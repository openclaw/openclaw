import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveUserPath } from "openclaw/plugin-sdk/text-utility-runtime";
import { IMessagePermissionDeniedError, ImsgStdoutHandler } from "./client-stdout-handler.js";
import { DEFAULT_IMESSAGE_PROBE_TIMEOUT_MS } from "./constants.js";

export { IMessagePermissionDeniedError } from "./client-stdout-handler.js";
export type {
  IMessageRpcError,
  IMessageRpcNotification,
  IMessageRpcResponse,
} from "./client-types.js";

import type { IMessageRpcNotification, IMessageRpcResponse } from "./client-types.js";

export type IMessageRpcClientOptions = {
  cliPath?: string;
  dbPath?: string;
  runtime?: RuntimeEnv;
  onNotification?: (msg: IMessageRpcNotification) => void;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
};

function isTestEnv(): boolean {
  if (process.env.NODE_ENV === "test") {
    return true;
  }
  const vitest = normalizeLowercaseStringOrEmpty(process.env.VITEST);
  return Boolean(vitest);
}

export class IMessageRpcClient {
  private readonly cliPath: string;
  private readonly dbPath?: string;
  private readonly runtime?: RuntimeEnv;
  private readonly onNotification?: (msg: IMessageRpcNotification) => void;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly closed: Promise<void>;
  private closedResolve: (() => void) | null = null;
  private child: ChildProcessWithoutNullStreams | null = null;
  private reader: Interface | null = null;
  private nextId = 1;
  private stdoutHandler: ImsgStdoutHandler | null = null;
  private permissionDeniedError: IMessagePermissionDeniedError | null = null;

  constructor(opts: IMessageRpcClientOptions = {}) {
    this.cliPath = opts.cliPath?.trim() || "imsg";
    this.dbPath = opts.dbPath?.trim() ? resolveUserPath(opts.dbPath) : undefined;
    this.runtime = opts.runtime;
    this.onNotification = opts.onNotification;
    this.closed = new Promise((resolve) => {
      this.closedResolve = resolve;
    });
  }

  async start(): Promise<void> {
    if (this.child) {
      return;
    }
    if (isTestEnv()) {
      throw new Error("Refusing to start imsg rpc in test environment; mock iMessage RPC client");
    }
    const args = ["rpc"];
    if (this.dbPath) {
      args.push("--db", this.dbPath);
    }
    const child = spawn(this.cliPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.reader = createInterface({ input: child.stdout });
    this.stdoutHandler = new ImsgStdoutHandler({
      onJsonFrame: (parsed) => {
        this.dispatchParsed(parsed);
      },
      onPermissionDenied: (err) => {
        this.permissionDeniedError = err;
        this.runtime?.error?.(`imsg rpc: ${err.message}`);
        this.failAll(err);
      },
      onNoiseFlushed: (grouped) => {
        // imsg sometimes prints multi-line banners (e.g. permission help
        // text) instead of JSON-RPC. Surface them as one log entry per
        // spawn cycle so the gateway log does not flood with one ERROR
        // per banner line.
        this.runtime?.log?.(`imsg rpc: non-JSON output from imsg:\n${grouped}`);
      },
    });

    this.reader.on("line", (line) => {
      this.stdoutHandler?.handle(line);
    });

    child.stderr?.on("data", (chunk) => {
      const lines = chunk.toString().split(/\r?\n/);
      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        this.runtime?.error?.(`imsg rpc: ${line.trim()}`);
      }
    });

    child.on("error", (err) => {
      this.failAll(err instanceof Error ? err : new Error(String(err)));
      this.closedResolve?.();
    });

    // Without this listener, async EPIPE from a dead child crashes the
    // gateway via uncaughtException. (#75438)
    child.stdin.on("error", (err) => {
      this.failAll(err instanceof Error ? err : new Error(String(err)));
    });

    child.on("close", (code, signal) => {
      // Flush any banner text the subprocess printed right before exiting
      // so the operator sees the diagnostic instead of just a bare close.
      this.stdoutHandler?.flush();
      if (this.permissionDeniedError) {
        this.failAll(this.permissionDeniedError);
      } else if (code !== 0 && code !== null) {
        const reason = signal ? `signal ${signal}` : `code ${code}`;
        this.failAll(new Error(`imsg rpc exited (${reason})`));
      } else {
        this.failAll(new Error("imsg rpc closed"));
      }
      this.closedResolve?.();
    });
  }

  async stop(): Promise<void> {
    if (!this.child) {
      return;
    }
    this.reader?.close();
    this.reader = null;
    this.child.stdin?.end();
    const child = this.child;
    this.child = null;

    await Promise.race([
      this.closed,
      new Promise<void>((resolve) => {
        setTimeout(() => {
          if (!child.killed) {
            child.kill("SIGTERM");
          }
          resolve();
        }, 500);
      }),
    ]);
  }

  async waitForClose(): Promise<void> {
    await this.closed;
  }

  async request<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    opts?: { timeoutMs?: number },
  ): Promise<T> {
    if (this.permissionDeniedError) {
      // Fail-fast on every subsequent request after the first denial, so the
      // channel stops respawning imsg straight back into the same denial and
      // operators see one clear permission error instead of a flooded log.
      throw this.permissionDeniedError;
    }
    if (!this.child || !this.child.stdin) {
      throw new Error("imsg rpc not running");
    }
    const id = this.nextId++;
    const payload = {
      jsonrpc: "2.0",
      id,
      method,
      params: params ?? {},
    };
    const line = `${JSON.stringify(payload)}\n`;
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_IMESSAGE_PROBE_TIMEOUT_MS;

    const response = new Promise<T>((resolve, reject) => {
      const key = String(id);
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(key);
              reject(new Error(`imsg rpc timeout (${method})`));
            }, timeoutMs)
          : undefined;
      this.pending.set(key, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
    });

    // Reject the specific pending request on write error (e.g. EPIPE)
    // instead of letting it hang until timeout. (#75438)
    this.child.stdin.write(line, (err) => {
      if (err) {
        const key = String(id);
        const pending = this.pending.get(key);
        if (pending) {
          if (pending.timer) {
            clearTimeout(pending.timer);
          }
          this.pending.delete(key);
          pending.reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
    });
    return await response;
  }

  private dispatchParsed(parsed: IMessageRpcResponse<unknown>) {
    if (parsed.id !== undefined && parsed.id !== null) {
      const key = String(parsed.id);
      const pending = this.pending.get(key);
      if (!pending) {
        return;
      }
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      this.pending.delete(key);

      if (parsed.error) {
        const baseMessage = parsed.error.message ?? "imsg rpc error";
        const details = parsed.error.data;
        const code = parsed.error.code;
        const suffixes = [] as string[];
        if (typeof code === "number") {
          suffixes.push(`code=${code}`);
        }
        if (details !== undefined) {
          const detailText =
            typeof details === "string" ? details : JSON.stringify(details, null, 2);
          if (detailText) {
            suffixes.push(detailText);
          }
        }
        const msg = suffixes.length > 0 ? `${baseMessage}: ${suffixes.join(" ")}` : baseMessage;
        pending.reject(new Error(msg));
        return;
      }
      pending.resolve(parsed.result);
      return;
    }

    if (parsed.method) {
      this.onNotification?.({
        method: parsed.method,
        params: parsed.params,
      });
    }
  }

  private failAll(err: Error) {
    for (const [key, pending] of this.pending.entries()) {
      if (pending.timer) {
        clearTimeout(pending.timer);
      }
      pending.reject(err);
      this.pending.delete(key);
    }
  }
}

export async function createIMessageRpcClient(
  opts: IMessageRpcClientOptions = {},
): Promise<IMessageRpcClient> {
  const client = new IMessageRpcClient(opts);
  await client.start();
  return client;
}
