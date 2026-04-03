import type { PersistentMcpManager } from "./persistent-mcp-manager.js";

export type {
  BundleMcpToolRuntime,
  McpCatalogTool,
  McpServerCatalog,
  McpToolCatalog,
  SessionMcpRuntime,
  SessionMcpRuntimeManager,
} from "./pi-bundle-mcp-types.js";
export {
  __testing,
  createSessionMcpRuntime,
  disposeAllSessionMcpRuntimes,
  disposeSessionMcpRuntime,
  getOrCreateSessionMcpRuntime,
  getSessionMcpRuntimeManager,
} from "./pi-bundle-mcp-runtime.js";
export {
  createBundleMcpToolRuntime,
  materializeBundleMcpToolsForRun,
} from "./pi-bundle-mcp-materialize.js";

// ---------------------------------------------------------------------------
// PersistentMcpManager singleton — set by gateway on startup, null otherwise.
// ---------------------------------------------------------------------------

let _persistentMcpManager: PersistentMcpManager | null = null;

export function setPersistentMcpManager(manager: PersistentMcpManager | null): void {
  _persistentMcpManager = manager;
}

export function getPersistentMcpManager(): PersistentMcpManager | null {
  return _persistentMcpManager;
}
