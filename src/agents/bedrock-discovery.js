import { BedrockClient, ListFoundationModelsCommand, } from "@aws-sdk/client-bedrock";
import { createSubsystemLogger } from "../logging/subsystem.js";
const log = createSubsystemLogger("bedrock-discovery");
const DEFAULT_REFRESH_INTERVAL_SECONDS = 3600;
const DEFAULT_CONTEXT_WINDOW = 32000;
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_COST = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
};
const discoveryCache = new Map();
let hasLoggedBedrockError = false;
function normalizeProviderFilter(filter) {
    if (!filter || filter.length === 0) {
        return [];
    }
    const normalized = new Set(filter.map((entry) => entry.trim().toLowerCase()).filter((entry) => entry.length > 0));
    return Array.from(normalized).toSorted();
}
function buildCacheKey(params) {
    return JSON.stringify(params);
}
function includesTextModalities(modalities) {
    return (modalities ?? []).some((entry) => entry.toLowerCase() === "text");
}
function isActive(summary) {
    const status = summary.modelLifecycle?.status;
    return typeof status === "string" ? status.toUpperCase() === "ACTIVE" : false;
}
function mapInputModalities(summary) {
    const inputs = summary.inputModalities ?? [];
    const mapped = new Set();
    for (const modality of inputs) {
        const lower = modality.toLowerCase();
        if (lower === "text") {
            mapped.add("text");
        }
        if (lower === "image") {
            mapped.add("image");
        }
    }
    if (mapped.size === 0) {
        mapped.add("text");
    }
    return Array.from(mapped);
}
function inferReasoningSupport(summary) {
    const haystack = `${summary.modelId ?? ""} ${summary.modelName ?? ""}`.toLowerCase();
    return haystack.includes("reasoning") || haystack.includes("thinking");
}
function resolveDefaultContextWindow(config) {
    const value = Math.floor(config?.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW);
    return value > 0 ? value : DEFAULT_CONTEXT_WINDOW;
}
function resolveDefaultMaxTokens(config) {
    const value = Math.floor(config?.defaultMaxTokens ?? DEFAULT_MAX_TOKENS);
    return value > 0 ? value : DEFAULT_MAX_TOKENS;
}
function matchesProviderFilter(summary, filter) {
    if (filter.length === 0) {
        return true;
    }
    const providerName = summary.providerName ??
        (typeof summary.modelId === "string" ? summary.modelId.split(".")[0] : undefined);
    const normalized = providerName?.trim().toLowerCase();
    if (!normalized) {
        return false;
    }
    return filter.includes(normalized);
}
function shouldIncludeSummary(summary, filter) {
    if (!summary.modelId?.trim()) {
        return false;
    }
    if (!matchesProviderFilter(summary, filter)) {
        return false;
    }
    if (summary.responseStreamingSupported !== true) {
        return false;
    }
    if (!includesTextModalities(summary.outputModalities)) {
        return false;
    }
    if (!isActive(summary)) {
        return false;
    }
    return true;
}
function toModelDefinition(summary, defaults) {
    const id = summary.modelId?.trim() ?? "";
    return {
        id,
        name: summary.modelName?.trim() || id,
        reasoning: inferReasoningSupport(summary),
        input: mapInputModalities(summary),
        cost: DEFAULT_COST,
        contextWindow: defaults.contextWindow,
        maxTokens: defaults.maxTokens,
    };
}
export function resetBedrockDiscoveryCacheForTest() {
    discoveryCache.clear();
    hasLoggedBedrockError = false;
}
export async function discoverBedrockModels(params) {
    const refreshIntervalSeconds = Math.max(0, Math.floor(params.config?.refreshInterval ?? DEFAULT_REFRESH_INTERVAL_SECONDS));
    const providerFilter = normalizeProviderFilter(params.config?.providerFilter);
    const defaultContextWindow = resolveDefaultContextWindow(params.config);
    const defaultMaxTokens = resolveDefaultMaxTokens(params.config);
    const cacheKey = buildCacheKey({
        region: params.region,
        providerFilter,
        refreshIntervalSeconds,
        defaultContextWindow,
        defaultMaxTokens,
    });
    const now = params.now?.() ?? Date.now();
    if (refreshIntervalSeconds > 0) {
        const cached = discoveryCache.get(cacheKey);
        if (cached?.value && cached.expiresAt > now) {
            return cached.value;
        }
        if (cached?.inFlight) {
            return cached.inFlight;
        }
    }
    const clientFactory = params.clientFactory ?? ((region) => new BedrockClient({ region }));
    const client = clientFactory(params.region);
    const discoveryPromise = (async () => {
        const response = await client.send(new ListFoundationModelsCommand({}));
        const discovered = [];
        for (const summary of response.modelSummaries ?? []) {
            if (!shouldIncludeSummary(summary, providerFilter)) {
                continue;
            }
            discovered.push(toModelDefinition(summary, {
                contextWindow: defaultContextWindow,
                maxTokens: defaultMaxTokens,
            }));
        }
        return discovered.toSorted((a, b) => a.name.localeCompare(b.name));
    })();
    if (refreshIntervalSeconds > 0) {
        discoveryCache.set(cacheKey, {
            expiresAt: now + refreshIntervalSeconds * 1000,
            inFlight: discoveryPromise,
        });
    }
    try {
        const value = await discoveryPromise;
        if (refreshIntervalSeconds > 0) {
            discoveryCache.set(cacheKey, {
                expiresAt: now + refreshIntervalSeconds * 1000,
                value,
            });
        }
        return value;
    }
    catch (error) {
        if (refreshIntervalSeconds > 0) {
            discoveryCache.delete(cacheKey);
        }
        if (!hasLoggedBedrockError) {
            hasLoggedBedrockError = true;
            log.warn(`Failed to list models: ${String(error)}`);
        }
        return [];
    }
}
