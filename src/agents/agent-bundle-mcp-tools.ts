/** Public facade for bundle MCP tool materialization and session-scoped runtime management. */
export type { McpToolCatalogDiagnostic } from "./agent-bundle-mcp-types.js";
export {
  disposeAllSessionMcpRuntimes,
  getAdvertisedScopedMcpCatalog,
  getOrCreateRequesterScopedMcpRuntime,
  getOrCreateSessionMcpRuntime,
  peekSessionMcpRuntime,
  rememberAdvertisedScopedMcpCatalog,
  resolveSessionMcpConfigSummary,
  retireSessionMcpRuntime,
  retireSessionMcpRuntimeForSessionKey,
} from "./agent-bundle-mcp-runtime.js";
export {
  buildBundleMcpToolsFromCatalog,
  createBundleMcpToolRuntime,
  materializeBundleMcpToolsForRun,
} from "./agent-bundle-mcp-materialize.js";
export {
  materializeRequesterScopedMcpToolsForHarnessRun,
  type MaterializeRequesterScopedMcpToolsForHarnessRunParams,
  type RequesterScopedHarnessMcpTools,
} from "./agent-bundle-mcp-harness.js";
