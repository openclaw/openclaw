/**
 * Minimal JSON-RPC observer for the user's Codex app-server daemon. It attaches
 * to threads as one more listener connection and never answers server->client
 * requests, so approvals stay with the user's own TUI.
 */
import path from "node:path";
import { createInterface } from "node:readline";
import { embeddedAgentLog, OPENCLAW_VERSION } from "openclaw/plugin-sdk/agent-harness-runtime";
import { runCommandBuffered } from "openclaw/plugin-sdk/process-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveCodexAppServerUserHomeDir } from "./app-server/auth-start-options.js";
import type { JsonValue, RpcRequest } from "./app-server/protocol.js";
import { createWebSocketTransport } from "./app-server/transport-websocket.js";

/** `codex app-server daemon start` polls readiness for 10 s itself (codex-rs app-server-daemon START_TIMEOUT). */
const DAEMON_START_TIMEOUT_MS = 15_000;
const OBSERVER_REQUEST_TIMEOUT_MS = 30_000;

export type CodexObserverNotification = { method: string; params: unknown };

export type CodexObserverClient = {
  request(method: string, params?: JsonValue): Promise<unknown>;
  onNotification(listener: (notification: CodexObserverNotification) => void): void;
  /** Resolves with a reason once the daemon connection is gone. */
  readonly closed: Promise<string>;
  close(): void;
};

/** The request may have been applied by the daemon; callers must not retry it. */
export class CodexObserverUncertainError extends Error {
  constructor(method: string, reason: string) {
    super(`${method} outcome uncertain: ${reason}`);
    this.name = "CodexObserverUncertainError";
  }
}

class CodexObserverRpcError extends Error {
  constructor(
    method: string,
    readonly code: number | undefined,
    message: string,
  ) {
    super(`${method} failed: ${message}`);
    this.name = "CodexObserverRpcError";
  }
}

/** Control socket the Codex TUI auto-joins when present (codex-rs tui/src/lib.rs maybe_probe_default_daemon_socket). */
export function resolveCodexDaemonSocketPath(env: NodeJS.ProcessEnv): string {
  return path.join(
    resolveCodexAppServerUserHomeDir(env),
    "app-server-control",
    "app-server-control.sock",
  );
}

/** Starts the daemon when needed; the CLI returns once the socket answers `initialize`. */
export async function ensureCodexDaemonRunning(
  codexExecutable: string,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<void> {
  const result = await runCommandBuffered([codexExecutable, "app-server", "daemon", "start"], {
    env,
    timeoutMs: DAEMON_START_TIMEOUT_MS,
    signal,
  });
  if (result.termination === "timeout") {
    throw new Error(`codex app-server daemon start timed out after ${DAEMON_START_TIMEOUT_MS}ms`);
  }
  if (result.code !== 0) {
    const detail = result.stderr.toString("utf8").trim() || result.stdout.toString("utf8").trim();
    throw new Error(
      detail || `codex app-server daemon start exited with code ${String(result.code)}`,
    );
  }
}

/** Opens one observer connection and completes the initialize handshake. */
export async function connectCodexObserverClient(target: {
  socketPath: string;
  env: NodeJS.ProcessEnv;
}): Promise<CodexObserverClient> {
  const transport = createWebSocketTransport({
    transport: "unix",
    url: `unix://${target.socketPath}`,
    command: "codex",
    args: [],
    headers: {},
    env: Object.fromEntries(
      Object.entries(target.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
  });
  type Pending = {
    method: string;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  };
  const pending = new Map<number, Pending & { timer: NodeJS.Timeout }>();
  const notificationListeners = new Set<(notification: CodexObserverNotification) => void>();
  let nextId = 1;
  let closeReason: string | undefined;
  let resolveClosed!: (reason: string) => void;
  const closed = new Promise<string>((resolve) => {
    resolveClosed = resolve;
  });

  const settlePendingOnClose = (reason: string) => {
    for (const [id, entry] of pending) {
      pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(new CodexObserverUncertainError(entry.method, reason));
    }
  };
  const finish = (reason: string) => {
    if (closeReason !== undefined) {
      return;
    }
    closeReason = reason;
    settlePendingOnClose(reason);
    resolveClosed(reason);
  };

  transport.once("error", (error) => {
    embeddedAgentLog.debug("codex local session observer transport error", { error });
    finish(error instanceof Error ? error.message : String(error));
  });
  transport.once("exit", (code, reason) => {
    finish(typeof reason === "string" && reason ? reason : `socket closed (${String(code)})`);
  });

  const handleLine = (line: string) => {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      embeddedAgentLog.debug("codex local session observer dropped unparsable frame");
      return;
    }
    if (!isRecord(message)) {
      return;
    }
    if (typeof message.method === "string") {
      if ("id" in message) {
        // Server->client request (approval, user input, elicitation): the user's
        // own TUI answers it; the daemon fans it out to every subscribed
        // connection and takes the first reply (codex-rs outgoing_message.rs
        // send_request_to_connections). Answering here would override the user.
        embeddedAgentLog.debug("codex local session observer ignoring server request", {
          method: message.method,
        });
        return;
      }
      for (const listener of notificationListeners) {
        listener({ method: message.method, params: message.params });
      }
      return;
    }
    if (typeof message.id !== "number") {
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) {
      return;
    }
    pending.delete(message.id);
    clearTimeout(entry.timer);
    const error = isRecord(message.error) ? message.error : undefined;
    if (error) {
      const code = typeof error.code === "number" ? error.code : undefined;
      const text = typeof error.message === "string" ? error.message : "unknown error";
      entry.reject(new CodexObserverRpcError(entry.method, code, text));
      return;
    }
    entry.resolve(message.result);
  };
  createInterface({ input: transport.stdout }).on("line", handleLine);

  const write = (message: RpcRequest, onError: (error: Error) => void) => {
    transport.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
      if (error) {
        onError(error);
      }
    });
  };
  const request = (method: string, params?: JsonValue): Promise<unknown> => {
    if (closeReason !== undefined) {
      return Promise.reject(new Error(`codex daemon connection closed: ${closeReason}`));
    }
    const id = nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending.delete(id)) {
          reject(new CodexObserverUncertainError(method, "request timed out"));
        }
      }, OBSERVER_REQUEST_TIMEOUT_MS);
      timer.unref();
      pending.set(id, { method, resolve, reject, timer });
      write({ id, method, params }, (error) => {
        if (pending.delete(id)) {
          clearTimeout(timer);
          reject(new CodexObserverUncertainError(method, error.message));
        }
      });
    });
  };

  const client: CodexObserverClient = {
    request,
    onNotification: (listener) => {
      notificationListeners.add(listener);
    },
    closed,
    close: () => {
      transport.kill?.();
      finish("closed by openclaw");
    },
  };

  try {
    // Experimental API is required for thread/queue/add (README "Queue a follow-up user turn").
    await Promise.race([
      request("initialize", {
        clientInfo: {
          name: "openclaw-local-session-source",
          title: "OpenClaw team sessions",
          version: OPENCLAW_VERSION,
        },
        capabilities: { experimentalApi: true },
      }),
      closed.then((reason) => {
        throw new Error(`codex daemon connection closed: ${reason}`);
      }),
    ]);
  } catch (error) {
    client.close();
    throw error;
  }
  write({ method: "initialized" }, () => {});
  return client;
}
