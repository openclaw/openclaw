import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSubagentSpawnModelFallbacksOverride } from "./agent-scope.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults.js";
import type { AgentHarnessPluginSelection } from "./harness/runtime-plugin-load-plan.js";
import { resolveModelCandidateChainFromConfig } from "./model-fallback-candidates-core.js";
import type { ModelManifestNormalizationContext } from "./model-ref-shared.js";
import {
  resolveDefaultModelForAgent,
  resolveSubagentConfiguredModelSelection,
} from "./model-selection-config.js";
import { resolveConfiguredModelFallbacks } from "./model-selection-resolve.js";

/** Configured execution chains, not the model picker/alias inventory, own runtime admission. */
export function resolveConfiguredRuntimePluginSelections(
  config: OpenClawConfig,
  agentId: string,
  options: ModelManifestNormalizationContext & { allowPluginNormalization?: boolean } = {},
): AgentHarnessPluginSelection[] {
  const configured = resolveDefaultModelForAgent({ cfg: config, agentId, ...options });
  const subagentModel = resolveSubagentConfiguredModelSelection({
    cfg: config,
    agentId,
    includeAgentPrimary: false,
  });
  return resolveModelCandidateChainFromConfig({
    cfg: config,
    agentId,
    manifestPlugins: [],
    ...options,
    provider: configured.provider || DEFAULT_PROVIDER,
    model: configured.model || DEFAULT_MODEL,
    requestedRouteResolution: "resolved",
    // Session policy can narrow either configured chain after admission waits. Prepare
    // their owners once so nested execution never expands an already frozen generation.
    fallbacksOverride: [
      ...resolveConfiguredModelFallbacks({ cfg: config, agentId }),
      ...(subagentModel ? [subagentModel] : []),
      ...(resolveSubagentSpawnModelFallbacksOverride(config, agentId) ?? []),
    ],
  }).map((candidate) => ({
    provider: candidate.provider,
    modelId: candidate.model,
    agentId,
  }));
}
