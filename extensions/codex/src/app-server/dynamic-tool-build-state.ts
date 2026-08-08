type OpenClawCodingToolsFactory =
  (typeof import("openclaw/plugin-sdk/agent-harness"))["createOpenClawCodingTools"];
type RuntimeToolNormalizer =
  (typeof import("openclaw/plugin-sdk/agent-harness-runtime"))["normalizeAgentRuntimeTools"];

/** Mutable dependency seam shared by dynamic-tool construction and its behavioral tests. */
export const dynamicToolBuildState: {
  openClawCodingToolsFactory?: OpenClawCodingToolsFactory;
  runtimeToolNormalizer?: RuntimeToolNormalizer;
} = {};
