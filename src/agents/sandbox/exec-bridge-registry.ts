/**
 * In-process sandbox-exec bridge registry keyed by sandbox container.
 *
 * Mirrors BROWSER_BRIDGES (browser-bridges.ts): plugin tool context only
 * carries serializable primitives (session keys, URLs), never live backend
 * handles directly, so plugin-facing primitives that need to reach a live
 * sandbox container look up the real handle here via a key. The key is the
 * sandbox's container identifier (`backend.runtimeId` / `SandboxContext.containerName`),
 * not the raw per-turn session key: default sandbox scope is "agent", so many
 * session keys share one container, and only the container identifier is
 * consistent between registration (context.ts) and the registry prune pass
 * (prune.ts, which only knows containerName), matching how BROWSER_BRIDGES
 * itself is deduplicated by containerName in stopCachedBrowserBridgesForContainer.
 */
import type { SandboxBackendHandle } from "./backend-handle.types.js";

export const SANDBOX_EXEC_BRIDGES = new Map<string, SandboxBackendHandle>();

/** Registers the live sandbox backend for a container, for plugin-facing sandboxed-exec lookups. */
export function registerSandboxExecBridge(
  containerKey: string,
  backend: SandboxBackendHandle,
): void {
  SANDBOX_EXEC_BRIDGES.set(containerKey, backend);
}

/** Looks up the live sandbox backend for a container, if one is registered. */
export function getSandboxExecBridge(containerKey: string): SandboxBackendHandle | undefined {
  return SANDBOX_EXEC_BRIDGES.get(containerKey);
}

/** Drops a container's sandbox-exec bridge entry (called from the same prune pass as BROWSER_BRIDGES). */
export function pruneSandboxExecBridge(containerKey: string): void {
  SANDBOX_EXEC_BRIDGES.delete(containerKey);
}
