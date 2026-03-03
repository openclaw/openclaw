export const CACHE_TTL_CUSTOM_TYPE = "openclaw.cache-ttl";
const CACHE_TTL_NATIVE_PROVIDERS = new Set(["anthropic", "moonshot", "zai"]);
const OPENROUTER_CACHE_TTL_MODEL_PREFIXES = [
    "anthropic/",
    "moonshot/",
    "moonshotai/",
    "zai/",
];
function isOpenRouterCacheTtlModel(modelId) {
    return OPENROUTER_CACHE_TTL_MODEL_PREFIXES.some((prefix) => modelId.startsWith(prefix));
}
export function isCacheTtlEligibleProvider(provider, modelId) {
    const normalizedProvider = provider.toLowerCase();
    const normalizedModelId = modelId.toLowerCase();
    if (CACHE_TTL_NATIVE_PROVIDERS.has(normalizedProvider)) {
        return true;
    }
    if (normalizedProvider === "openrouter" && isOpenRouterCacheTtlModel(normalizedModelId)) {
        return true;
    }
    if (normalizedProvider === "kilocode" && normalizedModelId.startsWith("anthropic/")) {
        return true;
    }
    return false;
}
export function readLastCacheTtlTimestamp(sessionManager) {
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
