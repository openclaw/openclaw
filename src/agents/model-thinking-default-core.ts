import {
  resolveThinkingDefaultForModel,
  resolveThinkingSelectionForModel,
  type ThinkingCatalogResolver,
} from "../auto-reply/thinking.js";
import { normalizeThinkLevel, type ThinkLevel } from "../auto-reply/thinking.shared.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderThinkingPolicySource } from "../plugins/provider-thinking.types.js";
import { resolveAgentEntry } from "./agent-scope-config.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { resolveModelExtraParamSources } from "./model-extra-params.js";
import { buildConfiguredModelCatalog } from "./model-selection-shared.js";

type ThinkingDefaultParams = {
  cfg: OpenClawConfig;
  provider: string;
  model: string;
  catalog?: ModelCatalogEntry[];
  agentRuntime?: string | null;
  agentId?: string;
  providerPolicySource?: ProviderThinkingPolicySource;
  catalogResolver?: ThinkingCatalogResolver;
};

export function resolveConfiguredThinkingDefaultCore(params: {
  cfg: OpenClawConfig;
  provider: string;
  model: string;
  agentId?: string;
}): ThinkLevel | undefined {
  const agentThinking = params.agentId
    ? resolveAgentEntry(params.cfg, params.agentId)?.thinkingDefault
    : undefined;
  if (agentThinking) {
    return agentThinking;
  }
  const { modelParams, agentModelParams } = resolveModelExtraParamSources({
    config: params.cfg,
    provider: params.provider,
    modelId: params.model,
    agentId: params.agentId,
  });
  const perModelThinking = agentModelParams?.thinking ?? modelParams?.thinking;
  if (perModelThinking === false || perModelThinking === "disabled") {
    return "off";
  }
  return (
    (typeof perModelThinking === "string" ? normalizeThinkLevel(perModelThinking) : undefined) ??
    params.cfg.agents?.defaults?.thinkingDefault
  );
}

export function resolveThinkingDefaultCore(params: ThinkingDefaultParams): ThinkLevel {
  const configured = resolveConfiguredThinkingDefaultCore(params);
  if (configured) {
    return configured;
  }
  return resolveThinkingDefaultForModel({
    ...params,
    catalog: params.catalog ?? buildConfiguredModelCatalog({ cfg: params.cfg }),
  });
}

/** Resolves configured intent and its execution level for the caller-selected runtime. */
export function resolveThinkingSelectionCore(
  params: ThinkingDefaultParams & { level?: ThinkLevel; agentRuntime: string | null | undefined },
) {
  return resolveThinkingSelectionForModel({
    ...params,
    level: params.level ?? resolveConfiguredThinkingDefaultCore(params),
    catalog: params.catalog ?? buildConfiguredModelCatalog({ cfg: params.cfg }),
  });
}
