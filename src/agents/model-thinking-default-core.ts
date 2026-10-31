import {
  resolveThinkingDefaultForModel,
  resolveThinkingSelectionForModel,
  type ThinkingCatalogResolver,
} from "../auto-reply/thinking.js";
import { normalizeThinkLevel, type ThinkLevel } from "../auto-reply/thinking.shared.js";
import { MODEL_APIS } from "../config/model-config-vocabulary.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderThinkingPolicySource } from "../plugins/provider-thinking.types.js";
import { resolveAgentEntry } from "./agent-scope-config.js";
import { createBundledStaticCatalogModelResolver } from "./embedded-agent-runner/model.static-catalog.js";
import { mergeConfiguredThinkingLevelMap } from "./model-catalog-metadata.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { withoutOverriddenThinkingProfile } from "./model-compat-catalog.js";
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

/**
 * Catalog for callers that pass none: configured rows, with the selected model's bundled row
 * supplying thinking facts. A listed model keeps every value config states and only gains the
 * facts it omits; an unlisted model gets the bundled row itself.
 */
export function buildThinkingCatalog(params: {
  cfg: OpenClawConfig;
  provider?: string | null;
  model?: string | null;
}): ModelCatalogEntry[] {
  const configured = buildConfiguredModelCatalog({ cfg: params.cfg });
  const { provider, model } = params;
  if (!provider || !model) {
    return configured;
  }
  // Thinking facts describe the model, so a configured endpoint override (a proxy base URL)
  // does not hide the provider's bundled row here.
  const row = createBundledStaticCatalogModelResolver({ includeRuntimeDiscovery: true })({
    provider,
    modelId: model,
  });
  if (!row) {
    return configured;
  }
  const index = configured.findIndex((e) => e.provider === provider && e.id === model);
  const listed = configured[index];
  if (listed) {
    return configured.with(index, {
      ...listed,
      thinkingLevelMap: mergeConfiguredThinkingLevelMap(row, listed),
      compat: { ...withoutOverriddenThinkingProfile(row.compat, listed.compat), ...listed.compat },
    });
  }
  const entry: ModelCatalogEntry = {
    provider,
    id: row.id,
    name: row.name,
    api: MODEL_APIS.find((api) => api === row.api),
    baseUrl: row.baseUrl,
    reasoning: row.reasoning,
    ...(row.thinkingLevelMap ? { thinkingLevelMap: row.thinkingLevelMap } : {}),
    compat: row.compat,
  };
  return [...configured, entry];
}

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
    catalog: params.catalog ?? buildThinkingCatalog(params),
  });
}

/** Resolves configured intent and its execution level for the caller-selected runtime. */
export function resolveThinkingSelectionCore(
  params: ThinkingDefaultParams & { level?: ThinkLevel; agentRuntime: string | null | undefined },
) {
  return resolveThinkingSelectionForModel({
    ...params,
    level: params.level ?? resolveConfiguredThinkingDefaultCore(params),
    catalog: params.catalog ?? buildThinkingCatalog(params),
  });
}
