// Import probes keep the prepared graph's physical module boundaries.
export const mcpImportRuntimeEntrypoints = {
  uiResource: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "mcp-ui-resource",
    distWorkerPath: "legacy-finalizer/src/agents/mcp-ui-resource.js",
  },
  authProfile: {
    currentModuleUrl: import.meta.url,
    sourceWorkerName: "mcp-auth-profile.integration.test-support",
    distWorkerPath: "legacy-finalizer/src/agents/mcp-auth-profile.integration.test-support.js",
  },
} as const;
