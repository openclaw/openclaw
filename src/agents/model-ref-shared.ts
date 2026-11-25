/** Pure provider/model reference types, keys, and formatting. */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { ManifestModelIdNormalizationSource } from "../plugins/manifest-model-id-normalization.js";
import { modelKey } from "../shared/model-key.js";
export {
  findNormalizedProviderKey,
  normalizeProviderId,
  normalizeProviderIdForAuth,
} from "@openclaw/model-catalog-core/provider-id";
export { modelKey } from "../shared/model-key.js";

export type { ProviderModelRef as ModelRef } from "@openclaw/model-catalog-core/model-catalog-refs";

export type ModelManifestNormalizationContext = {
  manifestPlugins?: ManifestModelIdNormalizationSource;
};

export type ProviderModelIdNormalizationOptions = ModelManifestNormalizationContext & {
  allowManifestNormalization?: boolean;
};

export type ModelRefNormalizeOptions = ModelManifestNormalizationContext & {
  allowManifestNormalization?: boolean;
  allowPluginNormalization?: boolean;
};

/** Return the legacy raw key when it differs from the canonical key. */
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

/** Preserve literal provider/model refs that already include a provider prefix twice. */
export function formatLiteralProviderPrefixedModelRef(provider: string, modelRef: string): string {
  const providerId = normalizeProviderId(provider);
  const trimmedRef = modelRef.trim();
  if (!providerId || !trimmedRef) {
    return trimmedRef;
  }
  const normalizedRef = normalizeLowercaseStringOrEmpty(trimmedRef);
  const literalPrefix = `${providerId}/${providerId}/`;
  if (normalizedRef.startsWith(literalPrefix)) {
    return trimmedRef;
  }
  return normalizedRef.startsWith(`${providerId}/`) ? `${providerId}/${trimmedRef}` : trimmedRef;
}
