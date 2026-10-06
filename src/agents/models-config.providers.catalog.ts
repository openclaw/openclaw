/** Materializes authored rows and finalizes catalog rows without credential resolution. */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeConfiguredProviderCatalogModelRef } from "@openclaw/model-catalog-core/provider-model-id-normalization";
import { normalizeProviderCatalogModelIdForConfig } from "../config/model-input.js";
import {
  getProviderModelId,
  materializeConfiguredProviderModelRows,
  mergeNormalizedProviderModel,
} from "../config/model-provider-rows.js";
import type { ModelProviderConfig as ProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createConfiguredProviderCatalogModelIdNormalizer,
  type ModelManifestNormalizationContext,
} from "./model-ref-shared.js";

type ModelsConfig = NonNullable<OpenClawConfig["models"]>;
type ProviderModelConfig = NonNullable<
  NonNullable<ModelsConfig["providers"]>[string]["models"]
>[number];

function normalizeModelCostForCatalog(model: ProviderModelConfig): ProviderModelConfig {
  const cost = model.cost;
  if (
    !cost ||
    (["input", "output", "cacheRead", "cacheWrite"] as const).every(
      (key) => cost[key] !== undefined,
    )
  ) {
    return model;
  }
  return {
    ...model,
    cost: {
      ...model.cost,
      input: cost.input ?? 0,
      output: cost.output ?? 0,
      cacheRead: cost.cacheRead ?? 0,
      cacheWrite: cost.cacheWrite ?? 0,
    },
  };
}

function normalizeProviderModelsForConfig(
  providerKey: string,
  provider: ProviderConfig,
): ProviderConfig {
  if (!Array.isArray(provider.models) || provider.models.length === 0) {
    return provider;
  }

  const providerId = normalizeProviderId(providerKey);
  let mutated = false;
  const nextModels: ProviderModelConfig[] = [];
  const seenById = new Map<string, number>();
  for (const model of provider.models) {
    const rawId = getProviderModelId(model);
    const normalizedId = rawId
      ? normalizeProviderCatalogModelIdForConfig(
          providerId,
          normalizeConfiguredProviderCatalogModelRef(rawId),
        )
      : rawId;
    const normalizedModel =
      normalizedId && normalizedId !== rawId ? { ...model, id: normalizedId } : model;
    if (normalizedModel !== model) {
      mutated = true;
    }
    const id = getProviderModelId(normalizedModel);
    if (id) {
      const existingIndex = seenById.get(id);
      if (existingIndex !== undefined) {
        mutated = true;
        const existing = nextModels.at(existingIndex);
        if (existing) {
          nextModels[existingIndex] = mergeNormalizedProviderModel(existing, normalizedModel);
        }
        continue;
      }
      seenById.set(id, nextModels.length);
    }
    nextModels.push(normalizedModel);
  }

  for (const [index, model] of nextModels.entries()) {
    const normalized = normalizeModelCostForCatalog(model);
    if (normalized !== model) {
      nextModels[index] = normalized;
      mutated = true;
    }
  }

  return mutated ? { ...provider, models: nextModels } : provider;
}

function normalizeProviderModelMap(
  providers: ModelsConfig["providers"],
  normalize: (providerKey: string, provider: ProviderConfig) => ProviderConfig,
): ModelsConfig["providers"] {
  if (!providers) {
    return providers;
  }

  let mutated = false;
  const next: Record<string, ProviderConfig> = {};
  for (const [providerKey, provider] of Object.entries(providers)) {
    const normalized = normalize(providerKey, provider);
    mutated ||= normalized !== provider;
    next[providerKey] = normalized;
  }

  return mutated ? next : providers;
}

/** Resolves authored aliases once, before discovery consumes configured model membership. */
export function materializeConfiguredProviderCatalogModels(
  providers: ModelsConfig["providers"],
  options: ModelManifestNormalizationContext = {},
): ModelsConfig["providers"] {
  const normalizeModelId = createConfiguredProviderCatalogModelIdNormalizer(options);
  return normalizeProviderModelMap(providers, (providerKey, provider) =>
    materializeConfiguredProviderModelRows(provider, (id) => normalizeModelId(providerKey, id)),
  );
}

/** Finalizes emitted rows without applying authored aliases to their identities. */
export function normalizeProviderCatalogModelsForConfig(
  providers: ModelsConfig["providers"],
): ModelsConfig["providers"] {
  return normalizeProviderModelMap(providers, normalizeProviderModelsForConfig);
}
