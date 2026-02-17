import { Hono } from "hono";
import type { Env } from "../env.js";
import {
  createInstance,
  getInstance,
  listInstances,
  deleteInstance,
  listConnections,
  listConnectionsByInstance,
  deleteConnection,
  listEventLogs,
} from "../db/queries.js";
import {
  spawnInstance,
  startInstance,
  stopInstance,
  removeInstance,
  getContainerLogs,
  getContainerStatus,
} from "../docker/manager.js";

export function createApiRoutes(env: Env) {
  const api = new Hono();

  // ── Instances ───────────────────────────────────────────────

  api.post("/api/instances", async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    const { name, spawn } = body as {
      name?: string;
      spawn?: boolean;
    };

    if (!name) {
      return c.json({ error: "Missing required field: name" }, 400);
    }

    if (spawn) {
      // Docker spawn path
      try {
        const result = await spawnInstance({ name, image: env.OPENCLAW_IMAGE });
        const instance = createInstance({
          name,
          gatewayUrl: result.gatewayUrl,
          gatewayToken: result.gatewayToken,
          bridgeUrl: result.bridgeUrl,
          containerId: result.containerId,
          deviceCredentials: result.deviceCredentials,
        });
        const dashboardUrl = `${result.gatewayUrl.replace(/^ws/, "http")}?token=${result.gatewayToken}`;
        return c.json(
          {
            id: instance.id,
            containerId: result.containerId,
            installUrl: `/slack/install?instance_id=${instance.id}`,
            dashboardUrl,
          },
          201,
        );
      } catch (err) {
        console.error("Docker spawn failed:", err);
        return c.json({ error: `Docker spawn failed: ${(err as Error).message}` }, 500);
      }
    }

    // Manual creation path
    const { gatewayUrl, gatewayToken, bridgeUrl } = body as {
      gatewayUrl?: string;
      gatewayToken?: string;
      bridgeUrl?: string;
    };

    if (!gatewayUrl || !gatewayToken || !bridgeUrl) {
      return c.json(
        {
          error:
            "Missing required fields: gatewayUrl, gatewayToken, bridgeUrl (or use spawn: true)",
        },
        400,
      );
    }

    const instance = createInstance({ name, gatewayUrl, gatewayToken, bridgeUrl });
    return c.json(
      {
        id: instance.id,
        installUrl: `/slack/install?instance_id=${instance.id}`,
      },
      201,
    );
  });

  api.get("/api/instances", (c) => {
    const instances = listInstances();
    return c.json(
      instances.map((i) => ({
        id: i.id,
        name: i.name,
        gatewayUrl: i.gatewayUrl,
        gatewayToken: i.gatewayToken,
        bridgeUrl: i.bridgeUrl,
        containerId: i.containerId,
        createdAt: i.createdAt,
      })),
    );
  });

  api.get("/api/instances/:id", (c) => {
    const id = c.req.param("id");
    const instance = getInstance(id);
    if (!instance) {
      return c.json({ error: "Not found" }, 404);
    }

    const connections = listConnectionsByInstance(id);
    return c.json({
      id: instance.id,
      name: instance.name,
      gatewayUrl: instance.gatewayUrl,
      gatewayToken: instance.gatewayToken,
      bridgeUrl: instance.bridgeUrl,
      containerId: instance.containerId,
      createdAt: instance.createdAt,
      connections: connections.map((conn) => ({
        id: conn.id,
        provider: conn.provider,
        externalId: conn.externalId,
        externalName: conn.externalName,
        connectedAt: conn.connectedAt,
      })),
    });
  });

  api.delete("/api/instances/:id", async (c) => {
    const id = c.req.param("id");
    const instance = getInstance(id);
    if (!instance) {
      return c.json({ error: "Not found" }, 404);
    }

    // Remove Docker container if managed
    if (instance.containerId) {
      try {
        await removeInstance(instance.containerId);
      } catch (err) {
        console.error("Failed to remove container:", err);
      }
    }

    const deleted = deleteInstance(id);
    if (!deleted) {
      return c.json({ error: "Not found" }, 404);
    }
    return c.json({ ok: true });
  });

  // ── Instance Docker controls ────────────────────────────────

  api.post("/api/instances/:id/start", async (c) => {
    const id = c.req.param("id");
    const instance = getInstance(id);
    if (!instance) {
      return c.json({ error: "Not found" }, 404);
    }
    if (!instance.containerId) {
      return c.json({ error: "Not a Docker-managed instance" }, 400);
    }
    try {
      await startInstance(instance.containerId);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  api.post("/api/instances/:id/stop", async (c) => {
    const id = c.req.param("id");
    const instance = getInstance(id);
    if (!instance) {
      return c.json({ error: "Not found" }, 404);
    }
    if (!instance.containerId) {
      return c.json({ error: "Not a Docker-managed instance" }, 400);
    }
    try {
      await stopInstance(instance.containerId);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // ── Instance logs + status ───────────────────────────────────

  api.get("/api/instances/:id/logs", async (c) => {
    const id = c.req.param("id");
    const instance = getInstance(id);
    if (!instance) {
      return c.json({ error: "Not found" }, 404);
    }
    if (!instance.containerId) {
      return c.json({ error: "Not a Docker-managed instance" }, 400);
    }
    const tail = c.req.query("tail") ? parseInt(c.req.query("tail")!, 10) : 200;
    try {
      const logs = await getContainerLogs(instance.containerId, tail);
      return c.json({ logs });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  api.get("/api/instances/:id/status", async (c) => {
    const id = c.req.param("id");
    const instance = getInstance(id);
    if (!instance) {
      return c.json({ error: "Not found" }, 404);
    }
    if (!instance.containerId) {
      return c.json({ status: "manual" });
    }
    try {
      const status = await getContainerStatus(instance.containerId);
      return c.json({ status });
    } catch (err) {
      return c.json({ status: "unknown", error: (err as Error).message });
    }
  });

  // ── Connections ─────────────────────────────────────────────

  api.get("/api/connections", (c) => {
    const connections = listConnections();
    return c.json(
      connections.map((conn) => ({
        id: conn.id,
        instanceId: conn.instanceId,
        provider: conn.provider,
        externalId: conn.externalId,
        externalName: conn.externalName,
        connectedAt: conn.connectedAt,
      })),
    );
  });

  api.delete("/api/connections/:id", (c) => {
    const id = c.req.param("id");
    const deleted = deleteConnection(id);
    if (!deleted) {
      return c.json({ error: "Not found" }, 404);
    }
    return c.json({ ok: true });
  });

  // ── Events ──────────────────────────────────────────────────

  api.get("/api/events", (c) => {
    const instanceId = c.req.query("instance_id");
    const provider = c.req.query("provider");
    const status = c.req.query("status");
    const limit = c.req.query("limit") ? parseInt(c.req.query("limit")!, 10) : undefined;
    const offset = c.req.query("offset") ? parseInt(c.req.query("offset")!, 10) : undefined;

    const result = listEventLogs({ instanceId, provider, status, limit, offset });
    return c.json(result);
  });

  return api;
}
