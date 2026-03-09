/**
 * A2A HTTP Server — handles inbound A2A JSON-RPC requests.
 *
 * Mounts onto the existing Gateway HTTP server via registerHttpHandler
 * (no separate port). Handles:
 *   - GET  /.well-known/agent-card.json  → Agent Card discovery
 *   - GET  /.well-known/agent.json       → Legacy v0.2.x alias
 *   - POST /a2a/jsonrpc                  → A2A JSON-RPC endpoint
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentCard } from "@a2a-js/sdk";
import { DefaultRequestHandler, JsonRpcTransportHandler } from "@a2a-js/sdk/server";
import { buildAgentCard, AGENT_CARD_PATHS } from "./agent-card.js";
import type { A2APluginConfig } from "./config.js";
import { OpenClawAgentExecutor } from "./executor.js";
import { FileTaskStore } from "./task-store.js";

// ── Helpers ────────────────────────────────────────────────────────

const JSON_RPC_PATH = "/a2a/jsonrpc";

type Logger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

/** Read the full request body as a string. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

/** Verify inbound bearer token. Returns true if auth passes. */
function verifyBearerAuth(req: IncomingMessage, cfg: A2APluginConfig): boolean {
  if (cfg.auth.mode === "none") return true;
  if (!cfg.auth.token) return true; // no token configured = open

  const authHeader = req.headers.authorization;
  if (!authHeader) return false;

  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0]!.toLowerCase() !== "bearer") return false;

  return parts[1] === cfg.auth.token;
}

/** Send a JSON response. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

/** SSE response headers. */
const SSE_HEADERS: Record<string, string> = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no", // prevent nginx buffering
};

/** Write a single SSE event. */
function writeSseEvent(res: ServerResponse, data: unknown): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/** Check if client requested SSE via Accept header. */
function acceptsSSE(req: IncomingMessage): boolean {
  const accept = req.headers.accept ?? "";
  return accept.includes("text/event-stream");
}

// ── Server factory ─────────────────────────────────────────────────

export type A2AServer = {
  /** registerHttpHandler callback — returns true if request was handled. */
  handleRequest: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
  /** Start background tasks (cleanup timer). */
  start: () => void;
  /** Stop background tasks. */
  stop: () => void;
  /** Access the generated Agent Card. */
  agentCard: AgentCard;
  /** Access the task store. */
  taskStore: FileTaskStore;
};

export function createA2AServer(
  cfg: A2APluginConfig,
  stateDir: string,
  log: Logger,
  gatewayAuthToken: string | undefined,
): A2AServer {
  // Resolve gateway URL for Agent Card and executor
  const gatewayPort = 18789; // default OpenClaw gateway port
  const gatewayBaseUrl = `http://127.0.0.1:${gatewayPort}`;

  const agentCard = buildAgentCard(cfg, gatewayBaseUrl);
  const taskStore = new FileTaskStore(stateDir);
  const executor = new OpenClawAgentExecutor(cfg, gatewayBaseUrl, gatewayAuthToken, log);

  // DefaultRequestHandler: positional args (agentCard, taskStore, executor)
  const requestHandler = new DefaultRequestHandler(agentCard, taskStore, executor);

  // JsonRpcTransportHandler wraps the request handler for JSON-RPC dispatch
  const jsonRpcHandler = new JsonRpcTransportHandler(requestHandler);

  // Cleanup timer handle
  let cleanupTimer: ReturnType<typeof setInterval> | null = null;

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;

    // ── Agent Card discovery (public, no auth) ──
    if (req.method === "GET" && AGENT_CARD_PATHS.includes(pathname)) {
      log.info(`[a2a] Agent Card requested from ${req.socket.remoteAddress}`);
      sendJson(res, 200, agentCard);
      return true;
    }

    // ── A2A JSON-RPC endpoint ──
    if (req.method === "POST" && pathname === JSON_RPC_PATH) {
      if (!verifyBearerAuth(req, cfg)) {
        log.warn(`[a2a] unauthorized request from ${req.socket.remoteAddress}`);
        sendJson(res, 401, {
          jsonrpc: "2.0",
          error: { code: -32001, message: "Unauthorized" },
          id: null,
        });
        return true;
      }

      try {
        const body = await readBody(req);
        const parsed = JSON.parse(body);
        log.info(`[a2a] JSON-RPC request: ${parsed.method ?? "unknown"}`);

        // Use JsonRpcTransportHandler which routes to the right method
        const result = await jsonRpcHandler.handle(parsed);

        // handle() can return a Promise or AsyncGenerator
        if (result && typeof result === "object" && Symbol.asyncIterator in result) {
          const stream = result as AsyncGenerator;
          if (acceptsSSE(req)) {
            // SSE streaming — write each event as it arrives
            res.writeHead(200, SSE_HEADERS);
            for await (const chunk of stream) {
              writeSseEvent(res, chunk);
            }
            res.end();
          } else {
            // Non-SSE client — collect events and return the last one as JSON
            let last: unknown = { jsonrpc: "2.0", id: null };
            for await (const chunk of stream) {
              last = chunk;
            }
            sendJson(res, 200, last);
          }
        } else {
          sendJson(res, 200, result);
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.error(`[a2a] JSON-RPC error: ${errMsg}`);
        sendJson(res, 400, {
          jsonrpc: "2.0",
          error: { code: -32700, message: "Parse error" },
          id: null,
        });
      }
      return true;
    }

    // Not an A2A request
    return false;
  };

  const start = (): void => {
    // Periodic cleanup of expired tasks (every 30 min)
    cleanupTimer = setInterval(
      async () => {
        try {
          const removed = await taskStore.cleanup(cfg.timeouts.taskRetentionMs);
          if (removed > 0) {
            log.info(`[a2a] cleaned up ${removed} expired task(s)`);
          }
        } catch (err) {
          log.error(
            `[a2a] task cleanup error: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
      30 * 60 * 1000,
    );
    // Don't block process exit
    if (cleanupTimer && "unref" in cleanupTimer) {
      (cleanupTimer as NodeJS.Timeout).unref();
    }

    log.info(`[a2a] server started — Agent Card: ${agentCard.name}`);
    log.info(`[a2a] endpoints: GET /.well-known/agent-card.json, POST /a2a/jsonrpc`);
    if (cfg.peers.length > 0) {
      log.info(`[a2a] configured peers: ${cfg.peers.map((p) => p.name).join(", ")}`);
    }
  };

  const stop = (): void => {
    if (cleanupTimer) {
      clearInterval(cleanupTimer);
      cleanupTimer = null;
    }
    log.info("[a2a] server stopped");
  };

  return { handleRequest, start, stop, agentCard, taskStore };
}
