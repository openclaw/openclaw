/** Cleanup consumes the existing manager without loading its construction graph. */
import { logWarn } from "../logger.js";
import type { createSessionMcpRuntimeManager } from "./agent-bundle-mcp-manager.js";
import { SESSION_MCP_RUNTIME_MANAGER_KEY } from "./agent-bundle-mcp-runtime-shared.js";
import type { SessionMcpRuntime, SessionMcpRuntimeLease } from "./agent-bundle-mcp-types.js";

export function peekSessionMcpRuntimeManager():
  | ReturnType<typeof createSessionMcpRuntimeManager>
  | undefined {
  // SAFETY: resolveGlobalSingleton stores symbol-keyed values on this same global object.
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  if (!Object.hasOwn(globalStore, SESSION_MCP_RUNTIME_MANAGER_KEY)) {
    return undefined;
  }
  // SAFETY: the manager API assigns only createSessionMcpRuntimeManager() to this key.
  return globalStore[SESSION_MCP_RUNTIME_MANAGER_KEY] as ReturnType<
    typeof createSessionMcpRuntimeManager
  >;
}

export function listAgentSessionMcpRuntimeIds(agentId: string): string[] {
  return peekSessionMcpRuntimeManager()?.listSessionIdsForAgent(agentId) ?? [];
}

/** Live views retain leases; close them and retry before agent storage can retire. */
export async function retireSessionMcpRuntimeForAgentDeletion(params: {
  sessionId: string;
  agentId: string;
  assertCurrent: () => void;
}): Promise<void> {
  params.assertCurrent();
  await peekSessionMcpRuntimeManager()?.retireSessionForAgentDeletion(
    params.sessionId,
    params.agentId,
    params.assertCurrent,
  );
}

/** Releases an acquisition after its consumer has taken ownership, or after failure. */
export async function releaseSessionMcpRuntime(
  lease: Pick<SessionMcpRuntimeLease, "runtime" | "retireUnusedServers"> & {
    releaseLease?: () => void;
  },
  retainedServerNames?: ReadonlySet<string>,
): Promise<void> {
  lease.releaseLease?.();
  try {
    if (retainedServerNames) {
      await lease.retireUnusedServers?.(retainedServerNames);
    }
  } catch (error) {
    logWarn(`bundle-mcp: unused server cleanup failed: ${String(error)}`);
  } finally {
    await completeDeferredSessionMcpRuntimeRetirement(lease.runtime).catch((error: unknown) => {
      logWarn(`bundle-mcp: deferred runtime cleanup failed: ${String(error)}`);
    });
  }
}

/** Completes deferred retirement after its final run, view, or request lease releases. */
export async function completeDeferredSessionMcpRuntimeRetirement(
  runtime: SessionMcpRuntime,
): Promise<boolean> {
  return await (peekSessionMcpRuntimeManager()?.completeDeferredRetirement(
    runtime.sessionId,
    runtime,
  ) ?? false);
}
