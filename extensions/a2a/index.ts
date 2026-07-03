/**
 * A2A Protocol Plugin for OpenClaw.
 *
 * Exposes standard A2A endpoints on the gateway:
 *   GET  /.well-known/agent.json  — Agent Card discovery
 *   POST /a2a/tasks/send          — JSON-RPC task execution
 *   GET  /a2a/tasks/:taskId       — Task status & history
 *
 * MVP: single-agent card, gateway-token auth, in-memory task registry.
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildAgentCard } from "./src/agent-card.js";
import {
  parseJsonRpc,
  formatResponse,
  formatJsonRpcError,
  isNotification,
  toJson,
  JSONRPC_ERROR,
  type JsonRpcRequest,
} from "./src/jsonrpc.js";
import {
  createTask,
  getTask,
  updateTaskState,
} from "./src/tasks.js";

// ── helpers ────────────────────────────────────────────────────────────

function sendJson(
  res: import("node:http").ServerResponse,
  status: number,
  body: unknown,
) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": String(Buffer.byteLength(json)),
  });
  res.end(json);
}

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

// ── plugin entry ───────────────────────────────────────────────────────

export default definePluginEntry({
  id: "a2a",
  name: "A2A Protocol",
  description:
    "Standard A2A protocol: agent card discovery and JSON-RPC task execution for cross-framework agent interoperability.",

  register(api) {
    const pluginCfg = (api.config as Record<string, unknown> | undefined) ?? {};
    const enabled = pluginCfg.enabled !== false;

    if (!enabled) {
      api.logger?.info?.("a2a: plugin loaded but disabled (config.enabled = false)");
      return;
    }

    // Determine gateway base URL.
    // In production the gateway bind host:port is available; for MVP we
    // construct it from the runtime or fall back to a sensible default.
    const gatewayUrl =
      (api.config as Record<string, unknown> | undefined)?.gatewayUrl as string
      ?? "http://localhost:18789";

    // ── Agent Card endpoint ──────────────────────────────────────────

    api.registerHttpRoute({
      path: "/.well-known/agent.json",
      auth: "plugin",
      match: "exact",
      async handler(_req, res) {
        try {
          // Collect agent metadata from config.
          const agents = ((api.config as Record<string, unknown> | undefined)
            ?.agents as { list?: { id: string; description?: string }[] } | undefined)
            ?.list ?? [];
          const card = buildAgentCard({ agents, gatewayUrl });
          sendJson(res, 200, card);
        } catch (err) {
          api.logger?.warn?.("a2a: agent card failed", { error: String(err) });
          sendJson(res, 500, { error: "Internal server error" });
        }
        return true;
      },
    });

    // ── JSON-RPC endpoint ────────────────────────────────────────────

    api.registerHttpRoute({
      path: "/a2a",
      auth: "plugin",
      match: "prefix",
      async handler(req, res) {
        // Only handle /a2a/tasks/send for MVP
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
        const path = url.pathname;

        try {
          const body = await readBody(req);

          if (path === "/a2a/tasks/send" && req.method === "POST") {
            return handleTasksSend(req, res, body);
          }

          if (path.startsWith("/a2a/tasks/") && req.method === "GET") {
            const taskId = path.slice("/a2a/tasks/".length);
            return handleTasksGet(res, taskId);
          }

          sendJson(res, 404, { error: "Not found" });
          return true;
        } catch (err) {
          api.logger?.warn?.("a2a: request failed", { error: String(err) });
          sendJson(res, 500, { error: "Internal server error" });
          return true;
        }
      },
    });

    api.logger?.info?.("a2a: plugin registered — /.well-known/agent.json + /a2a/tasks/*");
  },
});

// ── route handlers ─────────────────────────────────────────────────────

async function handleTasksSend(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  body: string,
): Promise<boolean> {
  const parsed = parseJsonRpc(body);

  // Batch
  if (Array.isArray(parsed)) {
    const results = await Promise.all(
      parsed.map((r) => executeSingleRequest(r)),
    );
    sendJson(res, 200, results);
    return true;
  }

  // Single
  if ("code" in parsed) {
    sendJson(res, 200, formatJsonRpcError(null, parsed.code, parsed.message));
    return true;
  }

  const result = await executeSingleRequest(parsed);
  if (isNotification(parsed)) {
    res.writeHead(204);
    res.end();
    return true;
  }
  sendJson(res, 200, result);
  return true;
}

async function executeSingleRequest(
  req: JsonRpcRequest,
): Promise<Record<string, unknown>> {
  // For MVP we support tasks/send only.
  if (req.method === "tasks/send") {
    return handleTaskSend(req);
  }

  return formatJsonRpcError(
    req.id,
    JSONRPC_ERROR.METHOD_NOT_FOUND.code,
    `Method not found: ${req.method}`,
  );
}

async function handleTaskSend(
  req: JsonRpcRequest,
): Promise<Record<string, unknown>> {
  const params = req.params as Record<string, unknown> | undefined;
  if (!params?.message || typeof params.message !== "string") {
    return formatJsonRpcError(
      req.id,
      JSONRPC_ERROR.INVALID_PARAMS.code,
      "Missing required 'message' parameter",
    );
  }

  try {
    // Create a session for this task.
    const { callGatewayFromCli } = await import("openclaw/plugin-sdk/gateway-runtime");
    const sessionKey = `agent:main:explicit:${Date.now()}`;

    // Create session
    await callGatewayFromCli("sessions.create", {
      url: "http://localhost:18789",
      json: true,
    }, {
      key: sessionKey,
      label: `A2A task: ${(params.message as string).slice(0, 50)}`,
    });

    // Create task in registry
    const task = createTask(sessionKey);

    // Send message to agent (non-blocking — agent runs async)
    callGatewayFromCli("sessions.send", {
      url: "http://localhost:18789",
      json: true,
    }, {
      sessionKey,
      message: params.message as string,
      deliver: false,
    }).catch(() => {
      updateTaskState(task.id, "failed");
    });

    return formatResponse(req.id, {
      taskId: task.id,
      state: task.state,
      sessionKey: task.sessionKey,
    });
  } catch (err) {
    return formatJsonRpcError(
      req.id,
      JSONRPC_ERROR.INTERNAL_ERROR.code,
      `Task creation failed: ${String(err)}`,
    );
  }
}

function handleTasksGet(
  res: import("node:http").ServerResponse,
  taskId: string,
): boolean {
  const task = getTask(taskId);
  if (!task) {
    sendJson(res, 404, { error: "Task not found" });
    return true;
  }

  sendJson(res, 200, {
    id: task.id,
    state: task.state,
    sessionKey: task.sessionKey,
    createdAt: new Date(task.createdAt).toISOString(),
    updatedAt: new Date(task.updatedAt).toISOString(),
  });
  return true;
}
