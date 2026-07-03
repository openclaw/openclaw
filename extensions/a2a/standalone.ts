/**
 * Standalone A2A endpoint — runs OpenClaw's A2A plugin core on a dedicated
 * HTTP port, so other A2A agents (e.g. sg on :9900) can discover and call it.
 *
 * Usage:  npx tsx standalone.ts [port] [gatewayUrl]
 * Default: port=9901  gatewayUrl=http://127.0.0.1:9901
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
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
} from "./src/tasks.js";

const PORT = parseInt(process.argv[2] ?? "9901", 10);
const GATEWAY_URL = process.argv[3] ?? `http://127.0.0.1:${PORT}`;

// ── helpers ──────────────────────────────────────────────────────────

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": String(Buffer.byteLength(json)),
  });
  res.end(json);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

// ── agent card ───────────────────────────────────────────────────────

const CARD = buildAgentCard({
  agents: [
    { id: "hermes", description: "DeepArchi MAEA central orchestrator — deep research, cross-agent coordination, strategic analysis" },
  ],
  gatewayUrl: GATEWAY_URL,
});

// ── JSON-RPC handler ─────────────────────────────────────────────────

async function executeSingleRequest(req: JsonRpcRequest): Promise<Record<string, unknown>> {
  if (req.method === "tasks/send") {
    return handleTaskSend(req);
  }
  // Hermes A2A dialect — map to standard tasks/send
  if (req.method === "message/send") {
    return handleMessageSend(req);
  }
  return formatJsonRpcError(
    req.id,
    JSONRPC_ERROR.METHOD_NOT_FOUND.code,
    `Method not found: ${req.method}`,
  );
}

/** Extract text from either format. */
function extractText(params: Record<string, unknown> | undefined): string | null {
  if (!params?.message) return null;
  // Standard: params.message is a string
  if (typeof params.message === "string") return params.message;
  // Hermes: params.message.parts[{text}]
  const msg = params.message as Record<string, unknown>;
  const parts = msg?.parts as Array<{ text?: string }> | undefined;
  if (parts) return parts.map((p) => p.text ?? "").join("\n").trim();
  // Hermes bare text fallback
  if (typeof msg.text === "string") return msg.text;
  return null;
}

/** Fetch remote Agent Card and return the JSON. */
async function fetchAgentCard(url: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${url}/.well-known/agent.json`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Forward a message to a remote A2A agent. */
async function forwardToRemote(
  targetUrl: string,
  text: string,
  authToken?: string,
): Promise<Record<string, unknown>> {
  // Discover dialect from Agent Card
  const card = await fetchAgentCard(targetUrl);
  const isHermes = card && (card.protocolVersion || card.securitySchemes);

  const reqId = `fwd-${Date.now()}`;
  let body: string;

  if (isHermes) {
    // Hermes dialect: message/send with nested parts
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
    // Standard A2A: tasks/send
    body = JSON.stringify({
      jsonrpc: "2.0",
      id: reqId,
      method: "tasks/send",
      params: { message: text },
    });
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;

  console.log(`[a2a:outbound] → ${targetUrl} (${isHermes ? "hermes" : "standard"}) — "${text.slice(0, 60)}"`);

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
    return { error: "Failed to parse remote response", raw: raw.slice(0, 500) };
  }
}

async function handleTaskSend(req: JsonRpcRequest): Promise<Record<string, unknown>> {
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

  // Outbound: forward to remote agent
  if (targetUrl) {
    try {
      const remoteResult = await forwardToRemote(targetUrl, text, authToken);
      const task = createTask(`outbound:${targetUrl}`);
      console.log(`[a2a:standalone] outbound task: ${task.id}`);

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

  // Local (no target)
  const task = createTask(`standalone:${Date.now()}`);
  console.log(`[a2a:standalone] task created: ${task.id} — "${text.slice(0, 60)}"`);

  return formatResponse(req.id, {
    taskId: task.id,
    state: task.state,
    sessionKey: task.sessionKey,
  });
}

/** Accept Hermes A2A dialect — params.message.parts[{text}]. */
async function handleMessageSend(req: JsonRpcRequest): Promise<Record<string, unknown>> {
  const params = req.params as Record<string, unknown> | undefined;
  const targetUrl = params?.target as string | undefined;
  const authToken = params?.auth as string | undefined;
  const text = extractText(params);

  if (!text) {
    return formatJsonRpcError(
      req.id,
      JSONRPC_ERROR.INVALID_PARAMS.code,
      "message.parts[].text is empty",
    );
  }

  // Outbound: forward to remote agent
  if (targetUrl) {
    try {
      const remoteResult = await forwardToRemote(targetUrl, text, authToken);
      const task = createTask(`outbound-hermes:${targetUrl}`);
      console.log(`[a2a:standalone] outbound-hermes task: ${task.id}`);

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

  // Local (no target)
  const task = createTask(`hermes:${Date.now()}`);
  console.log(`[a2a:standalone] hermes task created: ${task.id} — "${text.slice(0, 60)}"`);

  return formatResponse(req.id, {
    taskId: task.id,
    state: task.state,
    sessionKey: task.sessionKey,
  });
}

// ── server ───────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;

  // Agent Card
  if (path === "/.well-known/agent.json" && req.method === "GET") {
    sendJson(res, 200, CARD);
    return;
  }

  // Task status
  if (path.startsWith("/a2a/tasks/") && req.method === "GET") {
    const taskId = path.slice("/a2a/tasks/".length);
    const task = getTask(taskId);
    if (!task) {
      sendJson(res, 404, { error: "Task not found" });
      return;
    }
    sendJson(res, 200, {
      id: task.id,
      state: task.state,
      sessionKey: task.sessionKey,
      createdAt: new Date(task.createdAt).toISOString(),
      updatedAt: new Date(task.updatedAt).toISOString(),
    });
    return;
  }

  // JSON-RPC
  if (path === "/a2a/tasks/send" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const parsed = parseJsonRpc(body);

      // Batch
      if (Array.isArray(parsed)) {
        const results = await Promise.all(parsed.map((r) => executeSingleRequest(r)));
        sendJson(res, 200, results);
        return;
      }

      // Parse error
      if ("code" in parsed) {
        sendJson(res, 200, formatJsonRpcError(null, parsed.code, parsed.message));
        return;
      }

      // Single
      const result = await executeSingleRequest(parsed);
      if (isNotification(parsed)) {
        res.writeHead(204);
        res.end();
        return;
      }
      sendJson(res, 200, result);
    } catch (err) {
      console.error("[a2a:standalone] error:", err);
      sendJson(res, 500, { error: "Internal server error" });
    }
    return;
  }

  // 404
  sendJson(res, 404, { error: "Not found" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[a2a:standalone] listening on http://127.0.0.1:${PORT}`);
  console.log(`[a2a:standalone] Agent Card:   http://127.0.0.1:${PORT}/.well-known/agent.json`);
  console.log(`[a2a:standalone] JSON-RPC:     http://127.0.0.1:${PORT}/a2a/tasks/send`);
  console.log(`[a2a:standalone] gatewayUrl:   ${GATEWAY_URL}`);
});
