import {
  findNormalizedProviderKey as findNormalizedProviderKeyCore,
  findNormalizedProviderValue as findNormalizedProviderValueCore,
  normalizeProviderId as normalizeProviderIdCore,
  normalizeProviderIdForAuth as normalizeProviderIdForAuthCore,
} from "@openclaw/model-catalog-core/provider-id";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import { modelKey as sharedModelKey, normalizeStaticProviderModelId } from "./model-ref-shared.js";
import { normalizeProviderModelIdWithRuntime } from "./provider-model-normalization.runtime.js";

export type ModelRef = {
  provider: string;
  model: string;
};

export type ModelManifestNormalizationContext = {
  manifestPlugins?: readonly Pick<PluginManifestRecord, "modelIdNormalization">[];
};

/** Builds the canonical provider/model key used by config, registry, and model-list paths. */
export function modelKey(provider: string, model: string) {
  return sharedModelKey(provider, model);
}

/** Returns the pre-normalized key when callers need to preserve legacy config aliases. */
export function legacyModelKey(provider: string, model: string): string | null {
  const providerId = provider.trim();
  const modelId = model.trim();
  if (!providerId || !modelId) {
    return null;
  }
  const rawKey = `${providerId}/${modelId}`;
  const canonicalKey = modelKey(providerId, modelId);
  return rawKey === canonicalKey ? null : rawKey;
}

/** Normalizes provider ids for model identity and config lookup. */
export function normalizeProviderId(provider: string): string {
  return normalizeProviderIdCore(provider);
}

/** Normalizes provider ids for auth lookup, where provider aliases can intentionally collapse. */
export function normalizeProviderIdForAuth(provider: string): string {
  return normalizeProviderIdForAuthCore(provider);
}

/** Finds a provider value by normalized id while preserving the original map keys. */
export function findNormalizedProviderValue<T>(
  entries: Record<string, T> | undefined,
  provider: string,
): T | undefined {
  return findNormalizedProviderValueCore(entries, provider);
}

/** Finds the original provider key that matches a normalized provider id. */
export function findNormalizedProviderKey(
  entries: Record<string, unknown> | undefined,
  provider: string,
): string | undefined {
  return findNormalizedProviderKeyCore(entries, provider);
}

function normalizeProviderModelId(
  provider: string,
  model: string,
  options?: ModelManifestNormalizationContext & {
    allowManifestNormalization?: boolean;
    allowPluginNormalization?: boolean;
  },
): string {
  const staticModelId = normalizeStaticProviderModelId(provider, model, {
    allowManifestNormalization: options?.allowManifestNormalization,
    manifestPlugins: options?.manifestPlugins,
  });
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

type ModelRefNormalizeOptions = ModelManifestNormalizationContext & {
  allowManifestNormalization?: boolean;
  allowPluginNormalization?: boolean;
};

/** Normalizes provider/model parts using static, manifest, and optional plugin model-id rules. */
export function normalizeModelRef(
  provider: string,
  model: string,
  options?: ModelRefNormalizeOptions,
): ModelRef {
  const normalizedProvider = normalizeProviderId(provider);
  const normalizedModel = normalizeProviderModelId(normalizedProvider, model.trim(), options);
  return { provider: normalizedProvider, model: normalizedModel };
}

type ParseModelRefOptions = ModelRefNormalizeOptions;
const OPENROUTER_AUTO_COMPAT_ALIAS = "openrouter:auto";

/** Parses `provider/model` or bare model refs, applying the default provider when omitted. */
export function parseModelRef(
  raw: string,
  defaultProvider: string,
  options?: ParseModelRefOptions,
): ModelRef | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  // Preserve the historical colon spelling while canonicalizing to the normal openrouter/auto key.
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
