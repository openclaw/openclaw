export const MODEL_CONTEXT_TOKEN_CACHE = new Map();
export function lookupCachedContextTokens(modelId) {
    if (!modelId) {
        return undefined;
    }
    return MODEL_CONTEXT_TOKEN_CACHE.get(modelId);
}
