import { applyProviderNativeStreamingUsageCompatWithPlugin, normalizeProviderConfigWithPlugin, resolveProviderConfigApiKeyWithPlugin, } from "../plugins/provider-runtime.js";
import { resolveProviderPluginLookupKey } from "./models-config.providers.policy.lookup.js";
export function applyProviderNativeStreamingUsagePolicy(providerKey, provider) {
    const runtimeProviderKey = resolveProviderPluginLookupKey(providerKey, provider);
    return (applyProviderNativeStreamingUsageCompatWithPlugin({
        provider: runtimeProviderKey,
        context: {
            provider: providerKey,
            providerConfig: provider,
        },
    }) ?? provider);
}
export function normalizeProviderConfigPolicy(providerKey, provider) {
    const runtimeProviderKey = resolveProviderPluginLookupKey(providerKey, provider);
    return (normalizeProviderConfigWithPlugin({
        provider: runtimeProviderKey,
        context: {
            provider: providerKey,
            providerConfig: provider,
        },
    }) ?? provider);
}
export function resolveProviderConfigApiKeyPolicy(providerKey, provider) {
    const runtimeProviderKey = resolveProviderPluginLookupKey(providerKey, provider).trim();
    return (env) => resolveProviderConfigApiKeyWithPlugin({
        provider: runtimeProviderKey,
        context: {
            provider: providerKey,
            env,
        },
    });
}
