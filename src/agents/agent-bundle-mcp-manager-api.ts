/** Module-level session MCP runtime manager entry APIs. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import { withGuardedFetchRequestAuthority } from "../infra/net/fetch-request-authority.js";
import { getBoundLegacyPluginSdkResourceHost } from "../plugins/legacy-sdk-resource-host.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  peekSessionMcpRuntimeManager,
  releaseSessionMcpRuntime,
} from "./agent-bundle-mcp-manager-cleanup.js";
import { createSessionMcpRuntimeManager } from "./agent-bundle-mcp-manager.js";
import { runWithSessionMcpToolCallAuthority } from "./agent-bundle-mcp-request-context.js";
import { SESSION_MCP_RUNTIME_MANAGER_KEY } from "./agent-bundle-mcp-runtime-shared.js";
import type {
  McpToolCatalog,
  RequesterScopedMcpRuntimeHandle,
  SessionMcpConfigReload,
  SessionMcpRuntime,
  SessionMcpRuntimeLease,
  SessionMcpRuntimeManager,
} from "./agent-bundle-mcp-types.js";
import { resetMcpStartupBackoff } from "./mcp-startup-backoff.js";

function getSessionMcpRuntimeManager() {
  const manager = peekSessionMcpRuntimeManager();
  if (!manager) {
    throw new Error("Session MCP runtime scheduler has not been bound by its lifecycle owner");
  }
  return manager;
}

export function setSessionMcpRuntimeScheduler(scheduler: GatewayScheduler): Promise<void> {
  return resolveGlobalSingleton(SESSION_MCP_RUNTIME_MANAGER_KEY, () =>
    createSessionMcpRuntimeManager({ scheduler }),
  ).setScheduler(scheduler);
}

async function acquireManagedRuntime<T extends SessionMcpRuntimeLease | undefined>(
  acquire: (manager: SessionMcpRuntimeManager) => Promise<T>,
  assertRequesterCurrent?: () => void,
): Promise<T> {
  const host = getBoundLegacyPluginSdkResourceHost();
  const scheduler = host?.scheduler;
  if (scheduler) {
    await setSessionMcpRuntimeScheduler(scheduler);
    host?.assertOpen();
    scheduler.signal.throwIfAborted();
  }
  let lease: T | undefined;
  try {
    lease = await withGuardedFetchRequestAuthority(assertRequesterCurrent, () =>
      runWithSessionMcpToolCallAuthority(assertRequesterCurrent, () =>
        acquire(getSessionMcpRuntimeManager()),
      ),
    );
    host?.assertOpen();
    scheduler?.signal.throwIfAborted();
    assertRequesterCurrent?.();
    if (lease && assertRequesterCurrent) {
      return { ...lease, assertRequesterCurrent };
    }
    return lease;
  } catch (error) {
    if (lease) {
      await releaseSessionMcpRuntime(lease);
    }
    throw error;
  }
}

export function acquireSessionMcpRuntime(
  params: Parameters<SessionMcpRuntimeManager["acquire"]>[0] & {
    assertRequesterCurrent?: () => void;
  },
): Promise<SessionMcpRuntimeLease> {
  const { assertRequesterCurrent, ...runtimeParams } = params;
  return acquireManagedRuntime((manager) => manager.acquire(runtimeParams), assertRequesterCurrent);
}

/**
 * Requester-scoped MCP runtime only (no static partition).
 * Shared-thread harnesses use this so static MCP stays harness-native.
 */
export function acquireRequesterScopedMcpRuntime(
  params: Parameters<SessionMcpRuntimeManager["acquireRequesterScoped"]>[0] & {
    assertRequesterCurrent?: () => void;
  },
): Promise<RequesterScopedMcpRuntimeHandle | undefined> {
  const { assertRequesterCurrent, ...runtimeParams } = params;
  return acquireManagedRuntime(
    (manager) => manager.acquireRequesterScoped(runtimeParams),
    assertRequesterCurrent,
  );
}

export function rememberAdvertisedScopedMcpCatalog(
  handle: RequesterScopedMcpRuntimeHandle,
  catalog: McpToolCatalog,
): void {
  getSessionMcpRuntimeManager().rememberAdvertisedScopedCatalog(handle, catalog);
}

export function getAdvertisedScopedMcpCatalog(sessionId: string): McpToolCatalog | null {
  return peekSessionMcpRuntimeManager()?.getAdvertisedScopedCatalog(sessionId) ?? null;
}

/** Looks up an existing session MCP runtime without creating it or connecting transports. */
export function peekSessionMcpRuntime(params: {
  sessionId?: string | null;
  sessionKey?: string | null;
}): SessionMcpRuntime | undefined {
  const sessionId = normalizeOptionalString(params.sessionId);
  const sessionKey = normalizeOptionalString(params.sessionKey);
  return peekSessionMcpRuntimeManager()?.peekSession({
    ...(sessionId ? { sessionId } : {}),
    ...(sessionKey ? { sessionKey } : {}),
  });
}

/** Captures only currently registered MCP runtimes; invoking it never selects a successor. */
export function captureSessionMcpRuntimeRetirement(params: {
  sessionId?: string;
  sessionKey?: string;
}): ReturnType<SessionMcpRuntimeManager["captureSessionRetirement"]> {
  return peekSessionMcpRuntimeManager()?.captureSessionRetirement(params);
}

export async function retireSessionMcpRuntime(params: {
  sessionId?: string | null;
  reason: string;
  preserveActiveLeases?: boolean;
  retainAcrossReuse?: boolean;
  onError?: (error: unknown, sessionId: string, reason: string) => void;
}): Promise<boolean> {
  const sessionId = normalizeOptionalString(params.sessionId);
  if (!sessionId) {
    return false;
  }
  const manager = peekSessionMcpRuntimeManager();
  if (!manager) {
    return true;
  }
  try {
    if (
      params.preserveActiveLeases === true &&
      manager.deferRetirement(sessionId, { retainAcrossReuse: params.retainAcrossReuse })
    ) {
      // The lifecycle owner checks every partition and preserves required retirement.
      await manager.completeDeferredRetirement(sessionId);
    } else {
      await manager.disposeSession(sessionId);
    }
    return true;
  } catch (error) {
    params.onError?.(error, sessionId, params.reason);
    return false;
  }
}

export async function retireSessionMcpRuntimeForSessionKey(params: {
  sessionKey?: string | null;
  reason: string;
  preserveActiveLeases?: boolean;
  onError?: (error: unknown, sessionId: string, reason: string) => void;
}): Promise<boolean> {
  const sessionKey = normalizeOptionalString(params.sessionKey);
  if (!sessionKey) {
    return false;
  }
  const sessionId = peekSessionMcpRuntimeManager()?.resolveSessionId(sessionKey);
  return await retireSessionMcpRuntime({
    sessionId,
    reason: params.reason,
    preserveActiveLeases: params.preserveActiveLeases,
    onError: params.onError,
  });
}

export async function reloadSessionMcpRuntimes(params: SessionMcpConfigReload): Promise<void> {
  const manager = peekSessionMcpRuntimeManager();
  if (manager) {
    await manager.reloadConfig(params);
  } else {
    resetMcpStartupBackoff();
  }
}

export async function disposeAllSessionMcpRuntimes(): Promise<void> {
  const manager = peekSessionMcpRuntimeManager();
  if (manager) {
    await manager.disposeAll();
  } else {
    resetMcpStartupBackoff();
  }
}
