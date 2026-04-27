import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import { resolveAnthropicCacheRetentionFamily } from "./anthropic-family-cache-semantics.js";
export function isGooglePromptCacheEligible(params) {
    if (params.modelApi !== "google-generative-ai") {
        return false;
    }
    const normalizedModelId = normalizeLowercaseStringOrEmpty(params.modelId);
    return normalizedModelId.startsWith("gemini-2.5") || normalizedModelId.startsWith("gemini-3");
}
export function resolveCacheRetention(extraParams, provider, modelApi, modelId) {
    const hasExplicitCacheConfig = extraParams?.cacheRetention !== undefined || extraParams?.cacheControlTtl !== undefined;
    const family = resolveAnthropicCacheRetentionFamily({
        provider,
        modelApi,
        modelId,
        hasExplicitCacheConfig,
    });
    const googleEligible = isGooglePromptCacheEligible({ modelApi, modelId });
    if (!family && !googleEligible) {
        return undefined;
    }
    const newVal = extraParams?.cacheRetention;
    if (newVal === "none" || newVal === "short" || newVal === "long") {
        return newVal;
    }
    const legacy = extraParams?.cacheControlTtl;
    if (legacy === "5m") {
        return "short";
    }
    if (legacy === "1h") {
        return "long";
    }
    return family === "anthropic-direct" ? "short" : undefined;
}
