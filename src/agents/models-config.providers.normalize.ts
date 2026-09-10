/**
 * Materializes authored model rows and finalizes emitted provider catalogs.
 */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeConfiguredProviderCatalogModelRef } from "@openclaw/model-catalog-core/provider-model-id-normalization";
import { mergeModelCost } from "../config/model-cost.js";
import { normalizeProviderCatalogModelIdForConfig } from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { ensureAuthProfileStore } from "./auth-profiles/store-runtime.js";
import {
  createConfiguredProviderCatalogModelIdNormalizer,
  type ModelManifestNormalizationContext,
} from "./model-ref-shared.js";
import {
  normalizeProviderSpecificConfig,
  resolveProviderConfigApiKeyResolver,
} from "./models-config.providers.policy.js";
import type { ProviderConfig, SecretDefaults } from "./models-config.providers.secret-helpers.js";
import {
  normalizeConfiguredProviderApiKey,
  normalizeHeaderValues,
  normalizeResolvedEnvApiKey,
  resolveApiKeyFromProfiles,
  resolveMissingProviderApiKey,
} from "./models-config.providers.secret-helpers.js";
import {
  enforceSourceManagedProviderSecrets,
  normalizeSourceProviderLookup,
} from "./models-config.providers.source-managed.js";

type ModelsConfig = NonNullable<OpenClawConfig["models"]>;
type ProviderModelConfig = NonNullable<
  NonNullable<ModelsConfig["providers"]>[string]["models"]
>[number];

function getProviderModelId(model: ProviderModelConfig): string | undefined {
  return typeof model.id === "string" && model.id.trim() ? model.id : undefined;
}

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

function mergeNormalizedProviderModel(
  existing: ProviderModelConfig,
  incoming: ProviderModelConfig,
): ProviderModelConfig {
  const cost = mergeModelCost(incoming.cost, existing.cost);
  return { ...incoming, ...existing, ...(cost ? { cost } : {}) };
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
  return normalizeProviderModelMap(providers, (providerKey, provider) => {
    if (!Array.isArray(provider.models) || provider.models.length === 0) {
      return provider;
    }
    const exactRows = new Map<string, ProviderModelConfig>();
    for (const model of provider.models) {
      const id = getProviderModelId(model)?.trim();
      if (id) {
        const existing = exactRows.get(id);
        exactRows.set(id, existing ? mergeNormalizedProviderModel(existing, model) : model);
      }
    }
    const normalizedIds = new Map<string, string>();
    const selectedRows = new Map<string, ProviderModelConfig>();
    for (const [id, model] of exactRows) {
      const normalized = normalizeModelId(providerKey, id) || id;
      normalizedIds.set(id, normalized);
      // Exact destinations retain their omissions; other aliases do not donate fields.
      if (!selectedRows.has(normalized)) {
        selectedRows.set(normalized, exactRows.get(normalized) ?? model);
      }
    }
    const seen = new Set<string>();
    const models = provider.models.flatMap((model) => {
      const rawId = getProviderModelId(model);
      if (!rawId) {
        return [model];
      }
      const id = normalizedIds.get(rawId.trim())!;
      if (seen.has(id)) {
        return [];
      }
      seen.add(id);
      const selected = selectedRows.get(id)!;
      return [selected.id === id ? selected : { ...selected, id }];
    });
    return models.length === provider.models.length &&
      models.every((model, index) => model === provider.models[index])
      ? provider
      : { ...provider, models };
  });
}

/** Finalizes emitted rows without applying authored aliases to their identities. */
export function normalizeProviderCatalogModelsForConfig(
  providers: ModelsConfig["providers"],
): ModelsConfig["providers"] {
  return normalizeProviderModelMap(providers, normalizeProviderModelsForConfig);
}

export function normalizeProviders(params: {
  providers: ModelsConfig["providers"];
  agentDir: string;
  env?: NodeJS.ProcessEnv;
  secretDefaults?: SecretDefaults;
  sourceConfigForSecrets?: OpenClawConfig;
  secretRefManagedProviders?: Set<string>;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
}): ModelsConfig["providers"] {
  const { providers } = params;
  if (!providers) {
    return providers;
  }
  const env = params.env ?? process.env;
  const sourceProviders = normalizeSourceProviderLookup(
    params.sourceConfigForSecrets?.models?.providers,
  );
  let authStore: ReturnType<typeof ensureAuthProfileStore> | undefined;
  const resolveProfileApiKey = (providerKey: string) => {
    authStore ??= ensureAuthProfileStore(params.agentDir, {
      allowKeychainPrompt: false,
    });
    return resolveApiKeyFromProfiles({
      provider: providerKey,
      store: authStore,
      env,
    });
  };
  let mutated = false;
  const next: Record<string, ProviderConfig> = {};

  for (const [key, provider] of Object.entries(providers)) {
    const normalizedKey = key.trim();
    if (!normalizedKey) {
      mutated = true;
      continue;
    }
    if (normalizedKey !== key) {
      mutated = true;
    }
    // Only authored fields inherit loader facts; plugin-discovered inputs keep their own syntax.
    const sourceProvider = sourceProviders.get(normalizeProviderId(normalizedKey));
    const source =
      sourceProvider && params.sourceConfigForSecrets
        ? {
            config: params.sourceConfigForSecrets,
            providerKey: sourceProvider.providerKey,
          }
        : undefined;
    let normalizedProvider = provider;
    const normalizedHeaders = normalizeHeaderValues({
      headers: normalizedProvider.headers,
      secretDefaults: params.secretDefaults,
      source,
    });
    if (normalizedHeaders.mutated) {
      normalizedProvider = { ...normalizedProvider, headers: normalizedHeaders.headers };
    }
    const sourceInput =
      sourceProvider?.providerConfig.apiKey !== undefined
        ? {
            config: params.sourceConfigForSecrets,
            path: `models.providers.${sourceProvider.providerKey}.apiKey`,
            value: sourceProvider.providerConfig.apiKey,
            defaults: params.sourceConfigForSecrets?.secrets?.defaults,
          }
        : undefined;
    normalizedProvider = normalizeConfiguredProviderApiKey({
      providerKey: normalizedKey,
      sourceInput,
      provider: normalizedProvider,
      secretDefaults: params.secretDefaults,
      profileApiKey: undefined,
      secretRefManagedProviders: params.secretRefManagedProviders,
    });

    // Reverse-lookup: if apiKey looks like a resolved secret value (not an env
    // var name), check whether it matches the canonical env var for this provider.
    // This prevents resolveConfigEnvVars()-resolved secrets from being persisted
    // to models.json as plaintext. (Fixes #38757)
    normalizedProvider = normalizeResolvedEnvApiKey({
      providerKey: normalizedKey,
      provider: normalizedProvider,
      env,
      secretRefManagedProviders: params.secretRefManagedProviders,
    });

    const needsProfileApiKey =
      Array.isArray(normalizedProvider.models) &&
      normalizedProvider.models.length > 0 &&
      !(
        (typeof normalizedProvider.apiKey === "string" && normalizedProvider.apiKey.trim()) ||
        normalizedProvider.apiKey
      );
    const profileApiKey = needsProfileApiKey ? resolveProfileApiKey(normalizedKey) : undefined;
    const providerApiKeyResolver = needsProfileApiKey
      ? resolveProviderConfigApiKeyResolver(normalizedKey, undefined, params.manifestRegistry)
      : undefined;
    normalizedProvider = resolveMissingProviderApiKey({
      providerKey: normalizedKey,
      provider: normalizedProvider,
      env,
      profileApiKey,
      secretRefManagedProviders: params.secretRefManagedProviders,
      providerApiKeyResolver,
    });

    normalizedProvider = normalizeProviderSpecificConfig(
      normalizedKey,
      normalizedProvider,
      params.manifestRegistry,
    );

    mutated ||= normalizedProvider !== provider;

    const existing = next[normalizedKey];
    if (existing) {
      // Keep deterministic behavior if users accidentally define duplicate
      // provider keys that only differ by surrounding whitespace.
      mutated = true;
      next[normalizedKey] = {
        ...existing,
        ...normalizedProvider,
        models: normalizedProvider.models ?? existing.models,
      };
      continue;
    }
    next[normalizedKey] = normalizedProvider;
  }

  const normalizedProviders = mutated ? next : providers;
  return enforceSourceManagedProviderSecrets({
    providers: normalizedProviders,
    sourceConfigForSecrets: params.sourceConfigForSecrets,
    secretRefManagedProviders: params.secretRefManagedProviders,
  });
}
