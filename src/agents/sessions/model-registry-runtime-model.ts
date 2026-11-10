import { normalizeResolvedPricing } from "@openclaw/llm-core";
import { normalizeModelFamily } from "@openclaw/model-catalog-core/model-catalog-types";
import { ModelInferenceCapabilitiesSchema } from "@openclaw/model-catalog-core/model-inference-capabilities";
import type { Api, Model } from "../../llm/types.js";
import type { ProviderModelCatalog } from "../models-config.merge.js";

/** Projects one validated registry row into the runtime model the registry publishes. */
export function createRegistryRuntimeModel(
  provider: string,
  config: ProviderModelCatalog,
  model: NonNullable<ProviderModelCatalog["models"]>[number],
  api: string | undefined,
  catalog?: { baseUrl: string; input: Model["input"] },
): Model {
  // An unusable persisted family drops only that fact, never the registry row.
  const family = normalizeModelFamily(model.family);
  const inference =
    model.inference === undefined
      ? undefined
      : ModelInferenceCapabilitiesSchema.safeParse(model.inference);
  return {
    id: model.id,
    name: catalog ? (model.name ?? model.id) : model.name,
    // SAFETY: both callers skip or reject rows with neither a model nor provider API.
    api: api as Api,
    provider,
    baseUrl: catalog ? catalog.baseUrl : (model.baseUrl ?? config.baseUrl!),
    reasoning: catalog ? (model.reasoning ?? false) : model.reasoning,
    thinkingLevelMap: model.thinkingLevelMap,
    input: catalog ? catalog.input : model.input,
    cost: catalog ? normalizeResolvedPricing(model.cost ?? {}) : model.cost,
    // Missing catalog windows remain unknown on disk; estimates belong to runtime models.
    contextWindow: model.contextWindow ?? Math.max(model.contextTokens ?? 0, 128000),
    ...(model.contextWindow === undefined ? { contextWindowSource: "synthetic" } : {}),
    contextTokens: model.contextTokens,
    ...(model.parameterCount !== undefined ? { parameterCount: model.parameterCount } : {}),
    ...(family ? { family } : {}),
    ...(inference ? { inference: inference.success ? inference.data : { chat: false } } : {}),
    contextWindows: model.contextWindows,
    contextWindowDefault: model.contextWindowDefault,
    maxTokens: catalog ? (model.maxTokens ?? 16384) : model.maxTokens,
    ...(catalog && model.maxTokens !== undefined ? { maxTokensSource: model.maxTokensSource } : {}),
    params: model.params,
    headers: undefined,
    compat: model.compat,
  } as Model; // SAFETY: registration validates required fields; persisted rows use `catalog`.
}
