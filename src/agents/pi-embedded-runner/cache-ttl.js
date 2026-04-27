import { resolveProviderCacheTtlEligibility } from "../../plugins/provider-runtime.js";
import { normalizeLowercaseStringOrEmpty, normalizeOptionalLowercaseString, } from "../../shared/string-coerce.js";
import { isAnthropicFamilyCacheTtlEligible, isAnthropicModelRef, } from "./anthropic-family-cache-semantics.js";
import { isGooglePromptCacheEligible } from "./prompt-cache-retention.js";
export const CACHE_TTL_CUSTOM_TYPE = "openclaw.cache-ttl";
export function isCacheTtlEligibleProvider(provider, modelId, modelApi) {
    const normalizedProvider = normalizeLowercaseStringOrEmpty(provider);
    const normalizedModelId = normalizeLowercaseStringOrEmpty(modelId);
    const pluginEligibility = resolveProviderCacheTtlEligibility({
        provider: normalizedProvider,
        context: {
            provider: normalizedProvider,
            modelId: normalizedModelId,
            modelApi,
        },
    });
    if (pluginEligibility !== undefined) {
        return pluginEligibility;
    }
    return (isAnthropicFamilyCacheTtlEligible({
        provider: normalizedProvider,
        modelId: normalizedModelId,
        modelApi,
    }) ||
        (normalizedProvider === "kilocode" && isAnthropicModelRef(normalizedModelId)) ||
        isGooglePromptCacheEligible({ modelApi, modelId: normalizedModelId }));
}
function normalizeCacheTtlKey(value) {
    return normalizeOptionalLowercaseString(value);
}
function matchesCacheTtlContext(data, context) {
    if (!context) {
        return true;
    }
    const expectedProvider = normalizeCacheTtlKey(context.provider);
    if (expectedProvider && normalizeCacheTtlKey(data?.provider) !== expectedProvider) {
        return false;
    }
    const expectedModelId = normalizeCacheTtlKey(context.modelId);
    if (expectedModelId && normalizeCacheTtlKey(data?.modelId) !== expectedModelId) {
        return false;
    }
    return true;
}
export function readLastCacheTtlTimestamp(sessionManager, context) {
    const sm = sessionManager;
    if (!sm?.getEntries) {
        return null;
    }
    try {
        const entries = sm.getEntries();
        let last = null;
        for (let i = entries.length - 1; i >= 0; i--) {
            const entry = entries[i];
            if (entry?.type !== "custom" || entry?.customType !== CACHE_TTL_CUSTOM_TYPE) {
                continue;
            }
            const data = entry?.data;
            if (!matchesCacheTtlContext(data, context)) {
                continue;
            }
            const ts = typeof data?.timestamp === "number" ? data.timestamp : null;
            if (ts && Number.isFinite(ts)) {
                last = ts;
                break;
            }
        }
        return last;
    }
    catch {
        return null;
    }
}
export function appendCacheTtlTimestamp(sessionManager, data) {
    const sm = sessionManager;
    if (!sm?.appendCustomEntry) {
        return;
    }
    try {
        sm.appendCustomEntry(CACHE_TTL_CUSTOM_TYPE, data);
    }
    catch {
        // ignore persistence failures
    }
}
