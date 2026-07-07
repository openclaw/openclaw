/**
 * Sends typed JSON-RPC requests to the Codex app-server with sandbox guard
 * checks, shared-client leasing, and isolated-client shutdown handling.
 */
import type { resolveCodexAppServerAuthProfileIdForAgent } from "./auth-bridge.js";
import type { CodexAppServerRuntimeOptions, CodexAppServerStartOptions } from "./config.js";
import type {
  CodexAppServerRequestMethod,
  CodexAppServerRequestParams,
  CodexAppServerRequestResult,
  JsonValue,
} from "./protocol.js";
import { ensureCodexRemoteExecutionCompatibility } from "./remote-execution.js";
import { resolveCodexAppServerDirectSandboxBypassBlock } from "./sandbox-guard.js";
import {
  createIsolatedCodexAppServerClient,
  getLeasedSharedCodexAppServerClient,
  releaseLeasedSharedCodexAppServerClient,
} from "./shared-client.js";

const REMOTE_EXECUTION_COMPATIBILITY_METHODS = new Set([
  "thread/start",
  "thread/resume",
  "thread/fork",
  "turn/start",
  "thread/compact/start",
  "review/start",
]);

async function withCodexAppServerRequestDeadline<T>(params: {
  method: string;
  timeoutMs: number;
  run: (signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  const controller = new AbortController();
  if (params.timeoutMs <= 0) {
    return await params.run(controller.signal);
  }
  const timeoutError = Object.assign(new Error(`codex app-server ${params.method} timed out`), {
    name: "TimeoutError",
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      // Abort before rejecting. Even a fake or stale preflight that ignores the
      // signal must cross the post-preflight abort check before the target RPC.
      controller.abort(timeoutError);
      reject(timeoutError);
    }, params.timeoutMs);
    timeout.unref?.();
  });
  try {
    return await Promise.race([params.run(controller.signal), expired]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

/** Sends a typed Codex app-server request and returns the method-specific response shape. */
export async function requestCodexAppServerJson<M extends CodexAppServerRequestMethod>(params: {
  method: M;
  requestParams: CodexAppServerRequestParams<M>;
  timeoutMs?: number;
  startOptions?: CodexAppServerStartOptions;
  authProfileId?: string | null;
  agentDir?: string;
  config?: Parameters<typeof resolveCodexAppServerAuthProfileIdForAgent>[0]["config"];
  sessionKey?: string;
  sessionId?: string;
  isolated?: boolean;
  remoteExecution?: Pick<
    CodexAppServerRuntimeOptions,
    "remoteExecutionFingerprint" | "requestTimeoutMs"
  >;
  remoteExecutionHookCwd?: string;
}): Promise<CodexAppServerRequestResult<M>>;
export async function requestCodexAppServerJson<T = JsonValue | undefined>(params: {
  method: string;
  requestParams?: unknown;
  timeoutMs?: number;
  startOptions?: CodexAppServerStartOptions;
  authProfileId?: string | null;
  agentDir?: string;
  config?: Parameters<typeof resolveCodexAppServerAuthProfileIdForAgent>[0]["config"];
  sessionKey?: string;
  sessionId?: string;
  isolated?: boolean;
  remoteExecution?: Pick<
    CodexAppServerRuntimeOptions,
    "remoteExecutionFingerprint" | "requestTimeoutMs"
  >;
  remoteExecutionHookCwd?: string;
}): Promise<T>;
export async function requestCodexAppServerJson<T = JsonValue | undefined>(params: {
  method: string;
  requestParams?: unknown;
  timeoutMs?: number;
  startOptions?: CodexAppServerStartOptions;
  authProfileId?: string | null;
  agentDir?: string;
  config?: Parameters<typeof resolveCodexAppServerAuthProfileIdForAgent>[0]["config"];
  sessionKey?: string;
  sessionId?: string;
  isolated?: boolean;
  remoteExecution?: Pick<
    CodexAppServerRuntimeOptions,
    "remoteExecutionFingerprint" | "requestTimeoutMs"
  >;
  remoteExecutionHookCwd?: string;
}): Promise<T> {
  const sandboxBlock = resolveCodexAppServerDirectSandboxBypassBlock({
    method: params.method,
    requestParams: params.requestParams,
    config: params.config,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
  });
  if (sandboxBlock) {
    throw new Error(sandboxBlock);
  }
  const timeoutMs = params.timeoutMs ?? 60_000;
  return await withCodexAppServerRequestDeadline({
    method: params.method,
    timeoutMs,
    run: async (signal) => {
      const client = await (
        params.isolated ? createIsolatedCodexAppServerClient : getLeasedSharedCodexAppServerClient
      )({
        startOptions: params.startOptions,
        timeoutMs,
        authProfileId: params.authProfileId,
        agentDir: params.agentDir,
        config: params.config,
        abandonSignal: signal,
        ...(params.isolated
          ? {
              onStartedClient: (startedClient) => {
                const close = () => startedClient.close();
                if (signal.aborted) {
                  close();
                } else {
                  signal.addEventListener("abort", close, { once: true });
                }
              },
            }
          : {}),
      });
      try {
        signal.throwIfAborted();
        if (
          params.remoteExecution?.remoteExecutionFingerprint &&
          REMOTE_EXECUTION_COMPATIBILITY_METHODS.has(params.method)
        ) {
          await ensureCodexRemoteExecutionCompatibility({
            appServer: params.remoteExecution,
            client,
            cwd: params.remoteExecutionHookCwd ?? process.cwd(),
            signal,
          });
        }
        signal.throwIfAborted();
        return await client.request<T>(params.method, params.requestParams, { timeoutMs, signal });
      } finally {
        if (params.isolated) {
          // Wait for the child to actually exit (with a SIGKILL fallback) so
          // the parent process doesn't hang on an orphaned codex app-server.
          // The stdio bin shim does not always propagate stdin EOF to the
          // underlying codex binary, so the unref'd close() path can leave
          // the child running and keep the parent's event loop alive.
          await client.closeAndWait({ exitTimeoutMs: 2_000, forceKillDelayMs: 250 });
        } else {
          releaseLeasedSharedCodexAppServerClient(client);
        }
      }
    },
  });
}
