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
import { resolveGlobalMap } from "../../shared/global-singleton.js";
import type { SandboxBackendHandle } from "./backend-handle.types.js";

const SANDBOX_EXEC_BRIDGES_KEY = Symbol.for("openclaw.sandboxExecBridges");

// Local/jiti-loaded plugins resolve this module through a separate module
// instantiation from core's native ESM graph, so a plain module-level Map
// would silently split into two unrelated instances: registration (from
// context.ts, native ESM) would never be visible to lookup (from a
// jiti-loaded plugin calling fetchAndExtractSandboxed), making every
// sandboxed-fetch call fall back to unsandboxed processing without error.
// globalThis + Symbol.for guarantees one shared Map per process regardless
// of which loader instantiated the referencing module.
export const SANDBOX_EXEC_BRIDGES = resolveGlobalMap<string, SandboxBackendHandle>(
  SANDBOX_EXEC_BRIDGES_KEY,
);

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
