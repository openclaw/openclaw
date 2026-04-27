import { applyProviderNativeStreamingUsagePolicy, normalizeProviderConfigPolicy, resolveProviderConfigApiKeyPolicy, } from "./models-config.providers.policy.runtime.js";
export function applyNativeStreamingUsageCompat(providers) {
    let changed = false;
    const nextProviders = {};
    for (const [providerKey, provider] of Object.entries(providers)) {
        const nextProvider = applyProviderNativeStreamingUsagePolicy(providerKey, provider);
        nextProviders[providerKey] = nextProvider;
        changed ||= nextProvider !== provider;
    }
    return changed ? nextProviders : providers;
}
export function normalizeProviderSpecificConfig(providerKey, provider) {
    const normalized = normalizeProviderConfigPolicy(providerKey, provider);
    if (normalized && normalized !== provider) {
        return normalized;
    }
    return provider;
}
export function resolveProviderConfigApiKeyResolver(providerKey, provider) {
    return resolveProviderConfigApiKeyPolicy(providerKey, provider);
}
