// Lazy-load pi-coding-agent model metadata so we can infer context windows when
// the agent reports a model id. This includes custom models.json entries.
import { loadConfig } from "../config/config.js";
import { resolveOpenClawAgentDir } from "./agent-paths.js";
import { ensureOpenClawModelsJson } from "./models-config.js";
const ANTHROPIC_1M_MODEL_PREFIXES = ["claude-opus-4", "claude-sonnet-4"];
export const ANTHROPIC_CONTEXT_1M_TOKENS = 1048576;
export function applyDiscoveredContextWindows(params) {
    for (const model of params.models) {
        if (!model?.id) {
            continue;
        }
        const contextWindow = typeof model.contextWindow === "number" ? Math.trunc(model.contextWindow) : undefined;
        if (!contextWindow || contextWindow <= 0) {
            continue;
        }
        const existing = params.cache.get(model.id);
        // When multiple providers expose the same model id with different limits,
        // prefer the smaller window so token budgeting is fail-safe (no overestimation).
        if (existing === undefined || contextWindow < existing) {
            params.cache.set(model.id, contextWindow);
        }
    }
}
export function applyConfiguredContextWindows(params) {
    const providers = params.modelsConfig?.providers;
    if (!providers || typeof providers !== "object") {
        return;
    }
    for (const provider of Object.values(providers)) {
        if (!Array.isArray(provider?.models)) {
            continue;
        }
        for (const model of provider.models) {
            const modelId = typeof model?.id === "string" ? model.id : undefined;
            const contextWindow = typeof model?.contextWindow === "number" ? model.contextWindow : undefined;
            if (!modelId || !contextWindow || contextWindow <= 0) {
                continue;
            }
            params.cache.set(modelId, contextWindow);
        }
    }
}
const MODEL_CACHE = new Map();
const loadPromise = (async () => {
    let cfg;
    try {
        cfg = loadConfig();
    }
    catch {
        // If config can't be loaded, leave cache empty.
        return;
    }
    try {
        await ensureOpenClawModelsJson(cfg);
    }
    catch {
        // Continue with best-effort discovery/overrides.
    }
    try {
        const { discoverAuthStorage, discoverModels } = await import("./pi-model-discovery.js");
        const agentDir = resolveOpenClawAgentDir();
        const authStorage = discoverAuthStorage(agentDir);
        const modelRegistry = discoverModels(authStorage, agentDir);
        const models = typeof modelRegistry.getAvailable === "function"
            ? modelRegistry.getAvailable()
            : modelRegistry.getAll();
        applyDiscoveredContextWindows({
            cache: MODEL_CACHE,
            models,
        });
    }
    catch {
        // If model discovery fails, continue with config overrides only.
    }
    applyConfiguredContextWindows({
        cache: MODEL_CACHE,
        modelsConfig: cfg.models,
    });
})().catch(() => {
    // Keep lookup best-effort.
});
export function lookupContextTokens(modelId) {
    if (!modelId) {
        return undefined;
    }
    // Best-effort: kick off loading, but don't block.
    void loadPromise;
    return MODEL_CACHE.get(modelId);
}
function resolveConfiguredModelParams(cfg, provider, model) {
    const models = cfg?.agents?.defaults?.models;
    if (!models) {
        return undefined;
    }
    const key = `${provider}/${model}`.trim().toLowerCase();
    for (const [rawKey, entry] of Object.entries(models)) {
        if (rawKey.trim().toLowerCase() === key) {
            const params = entry?.params;
            return params && typeof params === "object" ? params : undefined;
        }
    }
    return undefined;
}
function resolveProviderModelRef(params) {
    const modelRaw = params.model?.trim();
    if (!modelRaw) {
        return undefined;
    }
    const providerRaw = params.provider?.trim();
    if (providerRaw) {
        return { provider: providerRaw.toLowerCase(), model: modelRaw };
    }
    const slash = modelRaw.indexOf("/");
    if (slash <= 0) {
        return undefined;
    }
    const provider = modelRaw.slice(0, slash).trim().toLowerCase();
    const model = modelRaw.slice(slash + 1).trim();
    if (!provider || !model) {
        return undefined;
    }
    return { provider, model };
}
function isAnthropic1MModel(provider, model) {
    if (provider !== "anthropic") {
        return false;
    }
    const normalized = model.trim().toLowerCase();
    const modelId = normalized.includes("/")
        ? (normalized.split("/").at(-1) ?? normalized)
        : normalized;
    return ANTHROPIC_1M_MODEL_PREFIXES.some((prefix) => modelId.startsWith(prefix));
}
export function resolveContextTokensForModel(params) {
    if (typeof params.contextTokensOverride === "number" && params.contextTokensOverride > 0) {
        return params.contextTokensOverride;
    }
    const ref = resolveProviderModelRef({
        provider: params.provider,
        model: params.model,
    });
    if (ref) {
        const modelParams = resolveConfiguredModelParams(params.cfg, ref.provider, ref.model);
        if (modelParams?.context1m === true && isAnthropic1MModel(ref.provider, ref.model)) {
            return ANTHROPIC_CONTEXT_1M_TOKENS;
        }
    }
    return lookupContextTokens(params.model) ?? params.fallbackContextTokens;
}
