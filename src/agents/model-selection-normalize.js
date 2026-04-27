import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { modelKey as sharedModelKey, normalizeStaticProviderModelId } from "./model-ref-shared.js";
import { findNormalizedProviderKey, findNormalizedProviderValue, normalizeProviderId, normalizeProviderIdForAuth, } from "./provider-id.js";
import { normalizeProviderModelIdWithRuntime } from "./provider-model-normalization.runtime.js";
export function modelKey(provider, model) {
    return sharedModelKey(provider, model);
}
export function legacyModelKey(provider, model) {
    const providerId = provider.trim();
    const modelId = model.trim();
    if (!providerId || !modelId) {
        return null;
    }
    const rawKey = `${providerId}/${modelId}`;
    const canonicalKey = modelKey(providerId, modelId);
    return rawKey === canonicalKey ? null : rawKey;
}
export { findNormalizedProviderKey, findNormalizedProviderValue, normalizeProviderId, normalizeProviderIdForAuth, };
function normalizeProviderModelId(provider, model, options) {
    const staticModelId = normalizeStaticProviderModelId(provider, model);
    if (options?.allowPluginNormalization === false) {
        return staticModelId;
    }
    return (normalizeProviderModelIdWithRuntime({
        provider,
        context: {
            provider,
            modelId: staticModelId,
        },
    }) ?? staticModelId);
}
export function normalizeModelRef(provider, model, options) {
    const normalizedProvider = normalizeProviderId(provider);
    const normalizedModel = normalizeProviderModelId(normalizedProvider, model.trim(), options);
    return { provider: normalizedProvider, model: normalizedModel };
}
const OPENROUTER_AUTO_COMPAT_ALIAS = "openrouter:auto";
export function parseModelRef(raw, defaultProvider, options) {
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
