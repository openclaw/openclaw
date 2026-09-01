/** Pure configured-model selection helpers safe for config validation. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentConfig } from "./agent-scope.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults.js";
import type {
  ModelManifestNormalizationContext,
  ModelRef,
  ModelRefSelection,
} from "./model-ref-shared.js";
import {
  normalizeModelSelection,
  resolveConfiguredModelRef,
  resolveConfiguredModelSelection,
} from "./model-selection-shared.js";

type DefaultModelParams = {
  cfg: OpenClawConfig;
  agentId?: string;
  allowManifestNormalization?: boolean;
  allowPluginNormalization?: boolean;
} & ModelManifestNormalizationContext;

export function resolveDefaultModelForAgent(params: DefaultModelParams): ModelRef {
  return resolveConfiguredModelRef({
    ...params,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
}

/** Retain static selection work for an owner that will later admit runtime normalization. */
export function resolveDefaultModelSelectionForAgent(
  params: Omit<DefaultModelParams, "allowPluginNormalization">,
): ModelRefSelection {
  return resolveConfiguredModelSelection({
    ...params,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
    allowPluginNormalization: false,
  });
}

export function resolveSubagentConfiguredModelSelection(params: {
  cfg: OpenClawConfig;
  agentId: string;
  includeAgentPrimary?: boolean;
}): string | undefined {
  const agentConfig = resolveAgentConfig(params.cfg, params.agentId);
  return (
    normalizeModelSelection(agentConfig?.subagents?.model) ??
    normalizeModelSelection(params.cfg.agents?.defaults?.subagents?.model) ??
    (params.includeAgentPrimary === false ? undefined : normalizeModelSelection(agentConfig?.model))
  );
}
