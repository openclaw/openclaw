import type { OpenClawCodingToolsOptions } from "./agent-tools.options.js";
import { createToolSearchTools } from "./tool-search.js";

/** Ring-zero tools already own discovery controls and must not receive a second set. */
export function createAgentToolSearchControls(params: {
  enabled: boolean;
  hasRingZeroTools: boolean;
  agentId?: string;
  options?: OpenClawCodingToolsOptions;
}) {
  if (!params.enabled || params.hasRingZeroTools) {
    return [];
  }
  const options = params.options;
  return createToolSearchTools({
    config: options?.config,
    runtimeConfig: options?.config,
    agentId: params.agentId,
    sessionKey: options?.sessionKey,
    sessionId: options?.sessionId,
    runId: options?.runId,
    catalogRef: options?.toolSearchCatalogRef,
    codeModeSkills: options?.codeModeSkills,
    abortSignal: options?.abortSignal,
    executeTool: options?.toolSearchCatalogExecutor,
  });
}
