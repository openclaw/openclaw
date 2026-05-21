/**
 * JSON-RPC 2.0 client over a stdio child process — talks to the
 * @openclaw/claude-app-server binary. Bidirectional: the server can send
 * REQUESTS to us (`item/tool/call`, approval requests) which we route to
 * registered handlers.
 *
 * A single shared client is kept per host process so multiple turns share
 * one server (cheaper than spawn-per-turn). `clearSharedClaudeAppServerClient`
 * is called from the harness `dispose` hook on plugin teardown.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { JsonValue, RpcMessage, RpcNotification, RpcRequest, RpcResponse } from "./types.js";

export type ClaudeAppServerStartOptions = {
  command?: string;
  args?: string[];
  env?: Record<string, string | undefined>;
};

export type NotificationHandler = (notification: RpcNotification) => void;

export type ServerRequestHandler = (req: {
  id: number | string;
  method: string;
  params?: JsonValue;
}) => Promise<JsonValue | undefined> | JsonValue | undefined;

type PendingRequest = {
  method: string;
  resolve: (value: JsonValue) => void;
  reject: (error: Error) => void;
};

const DEFAULT_COMMAND = "openclaw-claude-app-server";
const FORCE_KILL_DELAY_MS = 2_000;
const REQUEST_TIMEOUT_MS = 600_000;
const STDERR_TAIL_MAX = 2_000;
const INIT_TIMEOUT_MS = 30_000;

export class ClaudeAppServerRpcError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: JsonValue,
    readonly method?: string,
  ) {
    super(message);
    this.name = "ClaudeAppServerRpcError";
  }
}

export class ClaudeAppServerClient {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private notificationHandlers: NotificationHandler[] = [];
  private serverRequestHandlers: ServerRequestHandler[] = [];
  private stopped = false;
  private initializePromise: Promise<JsonValue> | null = null;
  private initialized = false;
  private stderrRl: ReadlineInterface | null = null;
  private stdoutRl: ReadlineInterface | null = null;
  private stderrTail = "";
  private serverInfo: { name?: string; version?: string } | null = null;

  constructor(private readonly opts: ClaudeAppServerStartOptions) {}

  async start(): Promise<void> {
    if (this.initializePromise) {
      await this.initializePromise;
      return;
    }
    this.stopped = false;
    this.initialized = false;
    this.stderrTail = "";

    const command = this.opts.command ?? DEFAULT_COMMAND;
    const args = this.opts.args ?? [];
    const env: NodeJS.ProcessEnv = { ...process.env, ...this.opts.env };

    this.child = spawn(command, args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    embeddedAgentLog.info("claude-app-server: spawned", { pid: this.child.pid, command });

    this.stderrRl = createInterface({ input: this.child.stderr! });
    this.stderrRl.on("line", (line) => {
      if (!line.trim()) return;
      this.stderrTail = appendBoundedTail(this.stderrTail, `${line}\n`, STDERR_TAIL_MAX);
      embeddedAgentLog.debug(`claude-app-server stderr: ${line}`);
    });

    this.stdoutRl = createInterface({ input: this.child.stdout! });
    this.stdoutRl.on("line", (line) => this.onLine(line));

    this.child.once("exit", (code, signal) => {
      embeddedAgentLog.warn("claude-app-server: process exited", { code, signal });
      const suffix = this.stderrTail
        ? ` stderr=${JSON.stringify(this.stderrTail.slice(-STDERR_TAIL_MAX))}`
        : "";
      this.handleChildExit(
        new Error(
          `openclaw-claude-app-server exited (code=${formatExitValue(code)} signal=${formatExitValue(signal)})${suffix}`,
        ),
      );
    });
    this.child.stdin?.on("error", (err) => {
      embeddedAgentLog.warn("claude-app-server: stdin error", { error: err.message });
      this.handleChildExit(new Error(`openclaw-claude-app-server stdin error: ${err.message}`));
    });

    this.initializePromise = this.sendRequest<JsonValue>(
      "initialize",
      {
        clientInfo: { name: "openclaw/extensions/claude", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      },
      AbortSignal.timeout(INIT_TIMEOUT_MS),
    ).then((result) => {
      this.initialized = true;
      if (result && typeof result === "object" && !Array.isArray(result)) {
        const info = (result as Record<string, unknown>).serverInfo;
        if (info && typeof info === "object" && !Array.isArray(info)) {
          this.serverInfo = info as { name?: string; version?: string };
        }
      }
      embeddedAgentLog.info("claude-app-server: initialized", { server: this.serverInfo });
      return result;
    });

    try {
      await this.initializePromise;
    } catch (err) {
      this.initializePromise = null;
      this.stop();
      throw err;
    }
  }

  getServerInfo(): { name?: string; version?: string } | null {
    return this.serverInfo;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    const child = this.child;
    this.child = null;
    this.initialized = false;
    this.initializePromise = null;
    this.closeReaders();
    if (!child) return;
    child.stdin?.end();
    child.stdin?.destroy();
    const forceKill = setTimeout(() => {
      try {
        if (child.pid && process.platform !== "win32") {
          process.kill(-child.pid, "SIGKILL");
        } else {
          child.kill("SIGKILL");
        }
      } catch {
        /* ignore */
      }
    }, FORCE_KILL_DELAY_MS);
    forceKill.unref?.();
    child.once("exit", () => clearTimeout(forceKill));
    child.unref?.();
    this.rejectAll(new Error("claude-app-server stopped"));
  }

  isRunning(): boolean {
    return this.child !== null && !this.stopped;
  }

  async request<T = JsonValue>(method: string, params?: unknown, signal?: AbortSignal): Promise<T> {
    if (method !== "initialize") {
      if (this.initializePromise) {
        await this.initializePromise.catch(() => {});
      }
      if (!this.initialized) {
        throw new Error("claude-app-server is not initialized");
      }
    }
    return this.sendRequest<T>(method, params, signal);
  }

  notify(method: string, params?: unknown): void {
    this.writeLine(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  onNotification(handler: NotificationHandler): () => void {
    this.notificationHandlers.push(handler);
    return () => {
      this.notificationHandlers = this.notificationHandlers.filter((h) => h !== handler);
    };
  }

  onServerRequest(handler: ServerRequestHandler): () => void {
    this.serverRequestHandlers.push(handler);
    return () => {
      this.serverRequestHandlers = this.serverRequestHandlers.filter((h) => h !== handler);
    };
  }

  private async sendRequest<T>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
    if (!this.child) throw new Error("claude-app-server is not running");
    const id = this.nextId++;
    const msg: RpcRequest = { jsonrpc: "2.0", id, method, params };

    const result = await new Promise<JsonValue>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new ClaudeAppServerRpcError(`RPC ${method} timed out`, undefined, undefined, method),
        );
      }, REQUEST_TIMEOUT_MS);
      const onAbort = () => {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(new ClaudeAppServerRpcError(`RPC ${method} aborted`, undefined, undefined, method));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timeout);
          signal?.removeEventListener("abort", onAbort);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
      });
      try {
        this.writeLine(JSON.stringify(msg));
      } catch (writeErr) {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        this.pending.delete(id);
        reject(writeErr instanceof Error ? writeErr : new Error(String(writeErr)));
      }
    });
    return result as T;
  }

  private writeLine(line: string): void {
    if (!this.child?.stdin) throw new Error("stdin unavailable — server not running");
    this.child.stdin.write(line + "\n");
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: RpcMessage;
    try {
      msg = JSON.parse(trimmed) as RpcMessage;
    } catch {
      embeddedAgentLog.warn("claude-app-server: unparseable line", {
        preview: trimmed.slice(0, 200),
      });
      return;
    }

    if ("id" in msg && msg.id !== undefined && "method" in msg) {
      void this.handleServerRequest(msg as RpcRequest);
      return;
    }
    if ("id" in msg && msg.id !== undefined) {
      const resp = msg as RpcResponse;
      const pending = this.pending.get(resp.id as number);
      if (!pending) {
        embeddedAgentLog.warn("claude-app-server: unexpected response id", { id: resp.id });
        return;
      }
      this.pending.delete(resp.id as number);
      if (resp.error) {
        pending.reject(
          new ClaudeAppServerRpcError(
            resp.error.message || `RPC ${pending.method} failed`,
            resp.error.code,
            resp.error.data,
            pending.method,
          ),
        );
      } else {
        pending.resolve((resp.result ?? null) as JsonValue);
      }
      return;
    }
    if ("method" in msg) {
      const notif = msg as RpcNotification;
      for (const handler of this.notificationHandlers) {
        try {
          handler(notif);
        } catch (err) {
          embeddedAgentLog.warn("claude-app-server: notification handler threw", { error: err });
        }
      }
    }
  }

  private async handleServerRequest(req: RpcRequest): Promise<void> {
    const id = req.id!;
    try {
      for (const handler of this.serverRequestHandlers) {
        const result = await handler({
          id: id as number,
          method: req.method,
          params: req.params as JsonValue | undefined,
        });
        if (result !== undefined) {
          this.writeLine(JSON.stringify({ jsonrpc: "2.0", id, result }));
          return;
        }
      }
      // Default decline so the server doesn't hang waiting forever.
      this.writeLine(
        JSON.stringify({ jsonrpc: "2.0", id, result: defaultServerRequestResponse(req.method) }),
      );
    } catch (err) {
      this.writeLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
        }),
      );
    }
  }

  private handleChildExit(error: Error): void {
    if (this.child === null) return;
    this.rejectAll(error);
    this.closeReaders();
    this.child = null;
    this.initialized = false;
    this.initializePromise = null;
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      pending.reject(error);
    }
  }

  private closeReaders(): void {
    this.stderrRl?.close();
    this.stderrRl = null;
    this.stdoutRl?.close();
    this.stdoutRl = null;
  }
}

function defaultServerRequestResponse(method: string): JsonValue {
  if (
    method === "item/commandExecution/requestApproval" ||
    method === "item/fileChange/requestApproval"
  ) {
    return { decision: "decline", reason: "no approval handler registered" };
  }
  if (method === "item/permissions/requestApproval") {
    return { permissions: {}, scope: "turn" };
  }
  if (method === "item/tool/call") {
    return {
      contentItems: [{ type: "inputText", text: "no dynamic-tool handler registered" }],
      success: false,
    };
  }
  return {};
}

function appendBoundedTail(current: string, next: string, maxLength: number): string {
  const combined = current + next;
  return combined.length > maxLength ? combined.slice(combined.length - maxLength) : combined;
}

function formatExitValue(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string" || typeof value === "number") return String(value);
  return "unknown";
}

// ─── Shared client lifecycle ────────────────────────────────────────────────

let sharedClient: ClaudeAppServerClient | null = null;
let sharedClientKey = "";

export function getSharedClaudeAppServerClient(
  opts: ClaudeAppServerStartOptions,
): ClaudeAppServerClient {
  // Spawn options form a key; if it changes we tear down the old client and
  // start fresh. This keeps reconfiguration cheap from the operator's side.
  const key = JSON.stringify({
    command: opts.command ?? DEFAULT_COMMAND,
    args: opts.args ?? [],
    env: opts.env ?? null,
  });
  if (!sharedClient || !sharedClient.isRunning() || sharedClientKey !== key) {
    if (sharedClient) {
      try {
        sharedClient.stop();
      } catch {
        /* ignore */
      }
    }
    sharedClient = new ClaudeAppServerClient(opts);
    sharedClientKey = key;
  }
  return sharedClient;
}

export async function clearSharedClaudeAppServerClient(): Promise<void> {
  if (sharedClient) {
    try {
      sharedClient.stop();
    } catch {
      /* ignore */
    }
    sharedClient = null;
    sharedClientKey = "";
  }
}
