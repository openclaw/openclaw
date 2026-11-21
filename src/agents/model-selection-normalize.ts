/**
 * Provider/model reference parsing and normalization. Parser and lookup declarations
 * remain the internal anchors consumed by the public Plugin SDK barrels.
 */
import {
  findNormalizedProviderValue as findNormalizedProviderValueCore,
  normalizeProviderId,
} from "@openclaw/model-catalog-core/provider-id";
import {
  normalizeBuiltInProviderModelId,
  normalizeConfiguredProviderCatalogModelRef,
  normalizeStaticProviderModelIdWithPolicies,
  stripSelfProviderModelPrefix,
} from "@openclaw/model-catalog-core/provider-model-id-normalization";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { resolveManifestModelIdNormalizationPolicies } from "../plugins/manifest-model-id-normalization.js";
import { modelKey } from "../shared/model-key.js";
import type {
  ModelRef,
  ModelRefNormalizeOptions,
  ProviderModelIdNormalizationOptions,
} from "./model-ref-shared.js";
import { normalizeProviderModelIdWithRuntime } from "./provider-model-normalization.runtime.js";

const OPENROUTER_AUTO_COMPAT_ALIAS = "openrouter:auto";

/** Find a provider value by normalized provider ID. */
export function findNormalizedProviderValue<T>(
  entries: Record<string, T> | undefined,
  provider: string,
): T | undefined {
  return findNormalizedProviderValueCore(entries, provider);
}

/** Parse `provider/model` or bare model text using a default provider. */
export function parseModelRef(
  raw: string,
  defaultProvider: string,
  options?: ModelRefNormalizeOptions,
): ModelRef | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  if (normalizeLowercaseStringOrEmpty(trimmed) === OPENROUTER_AUTO_COMPAT_ALIAS) {
    return normalizeModelRef("openrouter", "auto", options);
  }
  const slash = trimmed.indexOf("/");
  if (slash === -1) {
    return normalizeModelRef(defaultProvider, trimmed, options);
  }
  const providerRaw = trimmed.slice(0, slash).trim();
  const model = trimmed.slice(slash + 1).trim();
  if (!providerRaw || !model) {
    return null;
  }
  return normalizeModelRef(providerRaw, model, options);
}

/** Normalize a static provider model ID with built-in and optional manifest policy. */
export function normalizeStaticProviderModelId(
  provider: string,
  model: string,
  options: ProviderModelIdNormalizationOptions = {},
): string {
  const normalizedProvider = normalizeProviderId(provider);
  if (options.allowManifestNormalization === false) {
    return normalizeBuiltInProviderModelId(normalizedProvider, model);
  }
  return normalizeStaticProviderModelIdWithPolicies(
    normalizedProvider,
    model,
    resolveManifestModelIdNormalizationPolicies({ plugins: options.manifestPlugins }),
  );
}

/**
 * Captures manifest policies once for repeated static model-id comparisons.
 * Lifecycle-prepared callers must not rediscover plugin metadata inside model loops.
 */
export function createStaticProviderModelIdNormalizer(
  options: ProviderModelIdNormalizationOptions = {},
): (provider: string, model: string) => string {
  if (options.allowManifestNormalization === false) {
    return (provider, model) =>
      normalizeBuiltInProviderModelId(normalizeProviderId(provider), model);
  }
  if (options.manifestPlugins) {
    const policies = resolveManifestModelIdNormalizationPolicies({
      plugins: options.manifestPlugins,
    });
    return (provider, model) =>
      normalizeStaticProviderModelIdWithPolicies(normalizeProviderId(provider), model, policies);
  }
  return (provider, model) => normalizeStaticProviderModelId(provider, model, options);
}

/** Normalize a configured catalog model ID for comparisons against provider catalogs. */
export function normalizeConfiguredProviderCatalogModelId(
  provider: string,
  model: string,
  options: ProviderModelIdNormalizationOptions = {},
): string {
  return normalizeConfiguredProviderCatalogModelRef(
    normalizeStaticProviderModelId(provider, model, options),
  );
}

/** Reuses one manifest-policy view across configured model rows in an operation. */
export function createConfiguredProviderCatalogModelIdNormalizer(
  options: ProviderModelIdNormalizationOptions = {},
): (provider: string, model: string) => string {
  let normalizeStatic: ReturnType<typeof createStaticProviderModelIdNormalizer> | undefined;
  return (provider, model) =>
    normalizeConfiguredProviderCatalogModelRef(
      // Empty operations never prepare policies; default scalar readers retain their current scope.
      (normalizeStatic ??= createStaticProviderModelIdNormalizer(options))(provider, model),
    );
}

function normalizeProviderModelId(
  provider: string,
  model: string,
  options?: ModelRefNormalizeOptions,
): string {
  const providerModel = stripSelfProviderModelPrefix(provider, model);
  const staticModelId = normalizeStaticProviderModelId(provider, providerModel, options);
  if (options?.allowPluginNormalization === false) {
    return staticModelId;
  }
  return (
    normalizeProviderModelIdWithRuntime({
      provider,
      context: {
        provider,
        modelId: staticModelId,
      },
    }) ?? staticModelId
  );
}

/** Normalize a provider/model pair into a canonical model reference. */
export function normalizeModelRef(
  provider: string,
  model: string,
  options?: ModelRefNormalizeOptions,
): ModelRef {
  const normalizedProvider = normalizeProviderId(provider);
  const normalizedModel = normalizeProviderModelId(normalizedProvider, model.trim(), options);
  return { provider: normalizedProvider, model: normalizedModel };
}

/** Resolve an allowlist entry to a canonical provider/model key. */
export function resolveStaticAllowlistModelKey(
  raw: string,
  defaultProvider: string,
): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  const slash = trimmed.indexOf("/");
  const providerRaw = slash === -1 ? defaultProvider : trimmed.slice(0, slash).trim();
  const modelRaw = slash === -1 ? trimmed : trimmed.slice(slash + 1).trim();
  if (!providerRaw || !modelRaw) {
    return null;
  }
  const provider = normalizeProviderId(providerRaw);
  return modelKey(provider, normalizeStaticProviderModelId(provider, modelRaw));
}
