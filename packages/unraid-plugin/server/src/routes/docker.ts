import type { FastifyInstance } from "fastify";
import { Resource, Action } from "@unraidclaw/shared";
import type { DockerContainer, DockerContainerDetail, DockerActionResponse, DockerLogsResponse } from "@unraidclaw/shared";
import type { GraphQLClient } from "../graphql-client.js";
import { requirePermission } from "../permissions.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const LIST_QUERY = `query {
  docker {
    containers {
      id
      names
      image
      state
      status
      autoStart
    }
  }
}`;

const DETAIL_QUERY = `query ($id: String!) {
  docker {
    container(id: $id) {
      id
      names
      image
      state
      status
      autoStart
      ports { ip privatePort publicPort type }
      mounts { source destination mode }
      networkMode
    }
  }
}`;

const LOGS_QUERY = `query ($id: String!, $tail: Int, $since: String) {
  docker {
    containerLogs(id: $id, tail: $tail, since: $since)
  }
}`;

const execFileAsync = promisify(execFile);

interface DockerCreateBody {
  image: string;
  name?: string;
  ports?: string[];
  volumes?: string[];
  env?: string[];
  restart?: "no" | "always" | "unless-stopped" | "on-failure";
  network?: string;
}

function actionMutation(action: string): string {
  return `mutation ($id: String!) {
    docker {
      ${action}(id: $id) {
        id
        names
        state
        status
      }
    }
  }`;
}

export function registerDockerRoutes(app: FastifyInstance, gql: GraphQLClient): void {
  // List containers
  app.get("/api/docker/containers", {
    preHandler: requirePermission(Resource.DOCKER, Action.READ),
    handler: async (_req, reply) => {
      const data = await gql.query<{ docker: { containers: DockerContainer[] } }>(LIST_QUERY);
      return reply.send({ ok: true, data: data.docker.containers });
    },
  });

  // Get container details
  app.get<{ Params: { id: string } }>("/api/docker/containers/:id", {
    preHandler: requirePermission(Resource.DOCKER, Action.READ),
    handler: async (req, reply) => {
      const data = await gql.query<{ docker: { container: DockerContainerDetail } }>(
        DETAIL_QUERY,
        { id: req.params.id }
      );
      return reply.send({ ok: true, data: data.docker.container });
    },
  });

  // Get container logs
  app.get<{ Params: { id: string }; Querystring: { tail?: string; since?: string } }>(
    "/api/docker/containers/:id/logs",
    {
      preHandler: requirePermission(Resource.DOCKER, Action.READ),
      handler: async (req, reply) => {
        const tail = req.query.tail ? parseInt(req.query.tail, 10) : 100;
        const data = await gql.query<{ docker: { containerLogs: string } }>(
          LOGS_QUERY,
          { id: req.params.id, tail, since: req.query.since ?? null }
        );
        const response: DockerLogsResponse = { id: req.params.id, logs: data.docker.containerLogs };
        return reply.send({ ok: true, data: response });
      },
    }
  );

  // Container actions: start, stop, restart, pause, unpause
  for (const action of ["start", "stop", "restart", "pause", "unpause"] as const) {
    app.post<{ Params: { id: string } }>(`/api/docker/containers/:id/${action}`, {
      preHandler: requirePermission(Resource.DOCKER, Action.UPDATE),
      handler: async (req, reply) => {
        const data = await gql.query<{ docker: Record<string, DockerActionResponse> }>(
          actionMutation(action),
          { id: req.params.id }
        );
        return reply.send({ ok: true, data: data.docker[action] });
      },
    });
  }

  // Remove container (destructive)
  app.delete<{ Params: { id: string } }>("/api/docker/containers/:id", {
    preHandler: requirePermission(Resource.DOCKER, Action.DELETE),
    handler: async (req, reply) => {
      const data = await gql.query<{ docker: { remove: DockerActionResponse } }>(
        actionMutation("remove"),
        { id: req.params.id }
      );
      return reply.send({ ok: true, data: data.docker.remove });
    },
  });

  // Create container
  app.post<{ Body: DockerCreateBody }>("/api/docker/containers", {
    preHandler: requirePermission(Resource.DOCKER, Action.CREATE),
    handler: async (req, reply) => {
      const {
        image,
        name,
        ports = [],
        volumes = [],
        env = [],
        restart,
        network,
      } = req.body;

      const args = ["run", "-d"];
      if (name) args.push("--name", name);
      if (restart) args.push("--restart", restart);
      if (network) args.push("--network", network);
      for (const p of ports) args.push("-p", p);
      for (const v of volumes) args.push("-v", v);
      for (const e of env) args.push("-e", e);
      args.push(image);

      try {
        const { stdout } = await execFileAsync("docker", args);
        return reply.send({ ok: true, data: { id: stdout.trim() } });
      } catch (err: any) {
        return reply.status(500).send({
          ok: false,
          error: { code: "DOCKER_CREATE_FAILED", message: err.stderr ?? err.message },
        });
      }
    },
  });
}
