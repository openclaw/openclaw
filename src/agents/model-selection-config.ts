/** Pure configured-model selection helpers safe for config validation. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentModelConfigForRuntime } from "./agent-scope-config.js";
import { resolveAgentConfig } from "./agent-scope.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults.js";
import type { ModelManifestNormalizationContext, ModelRef } from "./model-ref-shared.js";
import { normalizeModelSelection, resolveConfiguredModelRef } from "./model-selection-shared.js";

export function resolveDefaultModelForAgent(
  params: {
    cfg: OpenClawConfig;
    agentId?: string;
    allowManifestNormalization?: boolean;
    allowPluginNormalization?: boolean;
  } & ModelManifestNormalizationContext,
): ModelRef {
  return resolveConfiguredModelRef({
    ...params,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
}

export function resolveSubagentConfiguredModelSelection(params: {
  cfg: OpenClawConfig;
  agentId: string;
  includeAgentPrimary?: boolean;
  modelRuntime?: "native" | "acp";
}): string | undefined {
  const agentConfig = resolveAgentConfig(params.cfg, params.agentId);
  return (
    normalizeModelSelection(agentConfig?.subagents?.model) ??
    normalizeModelSelection(params.cfg.agents?.defaults?.subagents?.model) ??
    (params.includeAgentPrimary === false
      ? undefined
      : normalizeModelSelection(
          resolveAgentModelConfigForRuntime(agentConfig, params.modelRuntime),
        ))
  );
}
