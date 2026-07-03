/**
 * A2A Protocol Plugin for OpenClaw.
 *
 * Exposes standard A2A endpoints on the gateway:
 *   GET  /.well-known/agent.json  — Agent Card discovery
 *   POST /a2a/tasks/send          — JSON-RPC (inbound + outbound proxy)
 *   GET  /a2a/tasks/:taskId       — Task status & history
 *
 * Dual-format: accepts standard tasks/send and Hermes message/send.
 * Outbound:   params.target proxies to a remote A2A agent.
 */
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildAgentCard } from "./src/agent-card.js";
import {
  parseJsonRpc,
  formatResponse,
  formatJsonRpcError,
  isNotification,
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

/** Extract text from params.message — standard string or Hermes parts[]. */
function extractText(params: Record<string, unknown> | undefined): string | null {
  if (!params?.message) return null;
  if (typeof params.message === "string") return params.message;
  const msg = params.message as Record<string, unknown>;
  const parts = msg?.parts as Array<{ text?: string }> | undefined;
  if (parts) return parts.map((p) => p.text ?? "").join("\n").trim();
  if (typeof msg.text === "string") return msg.text;
  return null;
}

/** Fetch remote Agent Card and return parsed JSON, or null. */
async function fetchAgentCard(agentUrl: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${agentUrl}/.well-known/agent.json`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Forward a message to a remote A2A agent, auto-detecting dialect. */
async function forwardToRemote(
  targetUrl: string,
  text: string,
  authToken?: string,
): Promise<Record<string, unknown>> {
  const card = await fetchAgentCard(targetUrl);
  const isHermes = Boolean(card?.protocolVersion || card?.securitySchemes);

  const reqId = `a2a-${Date.now()}`;
  let body: string;

  if (isHermes) {
    body = JSON.stringify({
      jsonrpc: "2.0",
      id: reqId,
      method: "message/send",
      params: {
        message: {
          messageId: `oc-${Date.now()}`,
          role: "user",
          contextId: "openclaw-outbound",
          parts: [{ text }],
        },
      },
    });
  } else {
    body = JSON.stringify({
      jsonrpc: "2.0",
      id: reqId,
      method: "tasks/send",
      params: { message: text },
    });
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;

  const res = await fetch(targetUrl, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(30000),
  });

  const raw = await res.text();
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { _parseError: true, raw: raw.slice(0, 500) };
  }
}

// ── plugin entry ───────────────────────────────────────────────────────

export default definePluginEntry({
  id: "a2a",
  name: "A2A Protocol",
  description:
    "Standard A2A protocol: agent card discovery, dual-format JSON-RPC task execution, and outbound proxy for cross-framework agent interoperability.",

  register(api) {
    const pluginCfg = (api.config as Record<string, unknown> | undefined) ?? {};
    const enabled = pluginCfg.enabled !== false;

    if (!enabled) {
      api.logger?.info?.("a2a: plugin loaded but disabled (config.enabled = false)");
      return;
    }

    const gatewayUrl =
      (pluginCfg.gatewayUrl as string) ?? "http://localhost:18789";

    // ── Agent Card endpoint ──────────────────────────────────────────

    api.registerHttpRoute({
      path: "/.well-known/agent.json",
      auth: "plugin",
      match: "exact",
      async handler(_req, res) {
        try {
          const agents = (
            api.config as Record<string, unknown> | undefined
          )?.agents as { list?: { id: string; description?: string }[] } | undefined;
          const card = buildAgentCard({
            agents: agents?.list ?? [],
            gatewayUrl,
          });
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
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
        const path = url.pathname;

        try {
          const body = await readBody(req);

          // tasks/send (standard) or message/send (Hermes) — same pipeline
          if (req.method === "POST" &&
              (path === "/a2a/tasks/send" || path === "/a2a")) {
            return handleJsonRpc(req, res, body, gatewayUrl, api);
          }

          // Task status
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

    api.logger?.info?.("a2a: plugin registered — inbound + outbound proxy on /.well-known/agent.json + /a2a");
  },
});

// ── route handlers ─────────────────────────────────────────────────────

async function handleJsonRpc(
  _req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  body: string,
  gatewayUrl: string,
  api: ReturnType<typeof definePluginEntry> extends { register(a: infer A): void } ? A : never,
): Promise<boolean> {
  const parsed = parseJsonRpc(body);

  // Batch
  if (Array.isArray(parsed)) {
    const results = await Promise.all(
      parsed.map((r) => executeSingleRequest(r, gatewayUrl, api)),
    );
    sendJson(res, 200, results);
    return true;
  }

  // Parse error
  if ("code" in parsed) {
    sendJson(res, 200, formatJsonRpcError(null, parsed.code, parsed.message));
    return true;
  }

  // Single
  const result = await executeSingleRequest(parsed, gatewayUrl, api);
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
  gatewayUrl: string,
  api: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (req.method === "tasks/send") {
    return handleTaskOrMessage(req, gatewayUrl, api);
  }
  // Hermes A2A dialect
  if (req.method === "message/send") {
    return handleTaskOrMessage(req, gatewayUrl, api);
  }
  return formatJsonRpcError(
    req.id,
    JSONRPC_ERROR.METHOD_NOT_FOUND.code,
    `Method not found: ${req.method}`,
  );
}

async function handleTaskOrMessage(
  req: JsonRpcRequest,
  gatewayUrl: string,
  api: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const params = req.params as Record<string, unknown> | undefined;
  const targetUrl = params?.target as string | undefined;
  const authToken = params?.auth as string | undefined;
  const text = extractText(params);

  if (!text) {
    return formatJsonRpcError(
      req.id,
      JSONRPC_ERROR.INVALID_PARAMS.code,
      "Missing required 'message' parameter",
    );
  }

  // ── Outbound: forward to remote A2A agent ─────────────────────────

  if (targetUrl) {
    try {
      const remoteResult = await forwardToRemote(targetUrl, text, authToken);
      const task = createTask(`outbound:${targetUrl}`);
      updateTaskState(task.id, "completed");
      return formatResponse(req.id, {
        taskId: task.id,
        state: "completed",
        sessionKey: task.sessionKey,
        remote: remoteResult,
      });
    } catch (err) {
      return formatJsonRpcError(
        req.id,
        JSONRPC_ERROR.INTERNAL_ERROR.code,
        `Outbound call failed: ${String(err)}`,
      );
    }
  }

  // ── Inbound: dispatch to local OpenClaw agent ─────────────────────

  try {
    const { callGatewayFromCli } = await import("openclaw/plugin-sdk/gateway-runtime");
    const sessionKey = `agent:main:explicit:${Date.now()}`;

    await callGatewayFromCli("sessions.create", {
      url: gatewayUrl,
      json: true,
    }, {
      key: sessionKey,
      label: `A2A task: ${text.slice(0, 50)}`,
    });

    const task = createTask(sessionKey);

    callGatewayFromCli("sessions.send", {
      url: gatewayUrl,
      json: true,
    }, {
      sessionKey,
      message: text,
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
