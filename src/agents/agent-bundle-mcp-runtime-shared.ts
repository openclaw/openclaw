/** Shared session MCP runtime constants and create-runtime factory type. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import type { SessionMcpRequesterScope, SessionMcpRuntime } from "./agent-bundle-mcp-types.js";
import type { McpServerConnectionResolved } from "./mcp-connection-resolver.js";

export const SESSION_MCP_RUNTIME_MANAGER_KEY = Symbol.for("openclaw.sessionMcpRuntimeManager");
export const DEFAULT_SESSION_MCP_RUNTIME_IDLE_TTL_MS = 10 * 60 * 1000;
export const SESSION_MCP_RUNTIME_SWEEP_INTERVAL_MS = 60 * 1000;
// Bounds live per-sender MCP transports in one session between idle sweeps;
// far above concurrent-run parallelism, so active requesters never evict.
export const SESSION_MCP_MAX_IDLE_REQUESTER_RUNTIMES = 64;

export type CreateSessionMcpRuntime = (params: {
  sessionId: string;
  sessionKey?: string;
  workspaceDir: string;
  agentDir?: string;
  cfg?: OpenClawConfig;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
  includeServerNames?: ReadonlySet<string>;
  excludeServerNames?: ReadonlySet<string>;
  safeServerNamesByServer?: ReadonlyMap<string, string>;
  connectionOverrides?: ReadonlyMap<string, McpServerConnectionResolved>;
  redactConnectionServerNames?: ReadonlySet<string>;
  requesterScope?: SessionMcpRequesterScope;
  configFingerprint?: string;
}) => SessionMcpRuntime;

export type SessionMcpSharedTask<T> = {
  controller: AbortController;
  promise: Promise<T>;
};

function toMcpRequestError(reason: unknown, fallbackMessage: string): Error {
  return reason instanceof Error ? reason : new Error(fallbackMessage, { cause: reason });
}

async function waitForSessionMcpRequest<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return await promise;
  }
  signal.throwIfAborted();
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(toMcpRequestError(signal.reason, "MCP request aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(toMcpRequestError(error, "MCP request failed"));
      },
    );
  });
}

export async function waitForSessionMcpSharedTask<T>(params: {
  task: SessionMcpSharedTask<T>;
  signal?: AbortSignal;
}): Promise<T> {
  params.signal?.throwIfAborted();
  const waitSignal = params.signal
    ? AbortSignal.any([params.signal, params.task.controller.signal])
    : params.task.controller.signal;
  return await waitForSessionMcpRequest(params.task.promise, waitSignal);
}

export function resolveSessionMcpRuntimeIdleTtlMs(): number {
  return DEFAULT_SESSION_MCP_RUNTIME_IDLE_TTL_MS;
}
