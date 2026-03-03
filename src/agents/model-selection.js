import { resolveAgentModelPrimaryValue, toAgentModelListLike } from "../config/model-input.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveAgentConfig, resolveAgentEffectiveModelPrimary } from "./agent-scope.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults.js";
import { splitTrailingAuthProfile } from "./model-ref-profile.js";
import { normalizeGoogleModelId } from "./models-config.providers.js";
const log = createSubsystemLogger("model-selection");
const ANTHROPIC_MODEL_ALIASES = {
    "opus-4.6": "claude-opus-4-6",
    "opus-4.5": "claude-opus-4-5",
    "sonnet-4.6": "claude-sonnet-4-6",
    "sonnet-4.5": "claude-sonnet-4-5",
};
const CLAUDE_46_MODEL_RE = /claude-(?:opus|sonnet)-4(?:\.|-)6(?:$|[-.])/i;
function normalizeAliasKey(value) {
    return value.trim().toLowerCase();
}
export function modelKey(provider, model) {
    return `${provider}/${model}`;
}
export function normalizeProviderId(provider) {
    const normalized = provider.trim().toLowerCase();
    if (normalized === "z.ai" || normalized === "z-ai") {
        return "zai";
    }
    if (normalized === "opencode-zen") {
        return "opencode";
    }
    if (normalized === "qwen") {
        return "qwen-portal";
    }
    if (normalized === "kimi-code") {
        return "kimi-coding";
    }
    if (normalized === "bedrock" || normalized === "aws-bedrock") {
        return "amazon-bedrock";
    }
    // Backward compatibility for older provider naming.
    if (normalized === "bytedance" || normalized === "doubao") {
        return "volcengine";
    }
    return normalized;
}
export function findNormalizedProviderValue(entries, provider) {
    if (!entries) {
        return undefined;
    }
    const providerKey = normalizeProviderId(provider);
    for (const [key, value] of Object.entries(entries)) {
        if (normalizeProviderId(key) === providerKey) {
            return value;
        }
    }
    return undefined;
}
export function findNormalizedProviderKey(entries, provider) {
    if (!entries) {
        return undefined;
    }
    const providerKey = normalizeProviderId(provider);
    return Object.keys(entries).find((key) => normalizeProviderId(key) === providerKey);
}
export function isCliProvider(provider, cfg) {
    const normalized = normalizeProviderId(provider);
    if (normalized === "claude-cli") {
        return true;
    }
    if (normalized === "codex-cli") {
        return true;
    }
    const backends = cfg?.agents?.defaults?.cliBackends ?? {};
    return Object.keys(backends).some((key) => normalizeProviderId(key) === normalized);
}
function normalizeAnthropicModelId(model) {
    const trimmed = model.trim();
    if (!trimmed) {
        return trimmed;
    }
    const lower = trimmed.toLowerCase();
    return ANTHROPIC_MODEL_ALIASES[lower] ?? trimmed;
}
function normalizeProviderModelId(provider, model) {
    if (provider === "anthropic") {
        return normalizeAnthropicModelId(model);
    }
    if (provider === "vercel-ai-gateway" && !model.includes("/")) {
        // Allow Vercel-specific Claude refs without an upstream prefix.
        const normalizedAnthropicModel = normalizeAnthropicModelId(model);
        if (normalizedAnthropicModel.startsWith("claude-")) {
            return `anthropic/${normalizedAnthropicModel}`;
        }
    }
    if (provider === "google") {
        return normalizeGoogleModelId(model);
    }
    // OpenRouter-native models (e.g. "openrouter/aurora-alpha") need the full
    // "openrouter/<name>" as the model ID sent to the API. Models from external
    // providers already contain a slash (e.g. "anthropic/claude-sonnet-4-5") and
    // are passed through as-is (#12924).
    if (provider === "openrouter" && !model.includes("/")) {
        return `openrouter/${model}`;
    }
    return model;
}
export function normalizeModelRef(provider, model) {
    const normalizedProvider = normalizeProviderId(provider);
    const normalizedModel = normalizeProviderModelId(normalizedProvider, model.trim());
    return { provider: normalizedProvider, model: normalizedModel };
}
export function parseModelRef(raw, defaultProvider) {
    const trimmed = raw.trim();
    if (!trimmed) {
        return null;
    }
    const slash = trimmed.indexOf("/");
    if (slash === -1) {
        return normalizeModelRef(defaultProvider, trimmed);
    }
    const providerRaw = trimmed.slice(0, slash).trim();
    const model = trimmed.slice(slash + 1).trim();
    if (!providerRaw || !model) {
        return null;
    }
    return normalizeModelRef(providerRaw, model);
}
export function inferUniqueProviderFromConfiguredModels(params) {
    const model = params.model.trim();
    if (!model) {
        return undefined;
    }
    const configuredModels = params.cfg.agents?.defaults?.models;
    if (!configuredModels) {
        return undefined;
    }
    const normalized = model.toLowerCase();
    const providers = new Set();
    for (const key of Object.keys(configuredModels)) {
        const ref = key.trim();
        if (!ref || !ref.includes("/")) {
            continue;
        }
        const parsed = parseModelRef(ref, DEFAULT_PROVIDER);
        if (!parsed) {
            continue;
        }
        if (parsed.model === model || parsed.model.toLowerCase() === normalized) {
            providers.add(parsed.provider);
            if (providers.size > 1) {
                return undefined;
            }
        }
    }
    if (providers.size !== 1) {
        return undefined;
    }
    return providers.values().next().value;
}
export function resolveAllowlistModelKey(raw, defaultProvider) {
    const parsed = parseModelRef(raw, defaultProvider);
    if (!parsed) {
        return null;
    }
    return modelKey(parsed.provider, parsed.model);
}
export function buildConfiguredAllowlistKeys(params) {
    const rawAllowlist = Object.keys(params.cfg?.agents?.defaults?.models ?? {});
    if (rawAllowlist.length === 0) {
        return null;
    }
    const keys = new Set();
    for (const raw of rawAllowlist) {
        const key = resolveAllowlistModelKey(String(raw ?? ""), params.defaultProvider);
        if (key) {
            keys.add(key);
        }
    }
    return keys.size > 0 ? keys : null;
}
export function buildModelAliasIndex(params) {
    const byAlias = new Map();
    const byKey = new Map();
    const rawModels = params.cfg.agents?.defaults?.models ?? {};
    for (const [keyRaw, entryRaw] of Object.entries(rawModels)) {
        const parsed = parseModelRef(String(keyRaw ?? ""), params.defaultProvider);
        if (!parsed) {
            continue;
        }
        const alias = String(entryRaw?.alias ?? "").trim();
        if (!alias) {
            continue;
        }
        const aliasKey = normalizeAliasKey(alias);
        byAlias.set(aliasKey, { alias, ref: parsed });
        const key = modelKey(parsed.provider, parsed.model);
        const existing = byKey.get(key) ?? [];
        existing.push(alias);
        byKey.set(key, existing);
    }
    return { byAlias, byKey };
}
export function resolveModelRefFromString(params) {
    const { model } = splitTrailingAuthProfile(params.raw);
    if (!model) {
        return null;
    }
    if (!model.includes("/")) {
        const aliasKey = normalizeAliasKey(model);
        const aliasMatch = params.aliasIndex?.byAlias.get(aliasKey);
        if (aliasMatch) {
            return { ref: aliasMatch.ref, alias: aliasMatch.alias };
        }
    }
    const parsed = parseModelRef(model, params.defaultProvider);
    if (!parsed) {
        return null;
    }
    return { ref: parsed };
}
export function resolveConfiguredModelRef(params) {
    const rawModel = resolveAgentModelPrimaryValue(params.cfg.agents?.defaults?.model) ?? "";
    if (rawModel) {
        const trimmed = rawModel.trim();
        const aliasIndex = buildModelAliasIndex({
            cfg: params.cfg,
            defaultProvider: params.defaultProvider,
        });
        if (!trimmed.includes("/")) {
            const aliasKey = normalizeAliasKey(trimmed);
            const aliasMatch = aliasIndex.byAlias.get(aliasKey);
            if (aliasMatch) {
                return aliasMatch.ref;
            }
            // Default to anthropic if no provider is specified, but warn as this is deprecated.
            log.warn(`Model "${trimmed}" specified without provider. Falling back to "anthropic/${trimmed}". Please use "anthropic/${trimmed}" in your config.`);
            return { provider: "anthropic", model: trimmed };
        }
        const resolved = resolveModelRefFromString({
            raw: trimmed,
            defaultProvider: params.defaultProvider,
            aliasIndex,
        });
        if (resolved) {
            return resolved.ref;
        }
    }
    return { provider: params.defaultProvider, model: params.defaultModel };
}
export function resolveDefaultModelForAgent(params) {
    const agentModelOverride = params.agentId
        ? resolveAgentEffectiveModelPrimary(params.cfg, params.agentId)
        : undefined;
    const cfg = agentModelOverride && agentModelOverride.length > 0
        ? {
            ...params.cfg,
            agents: {
                ...params.cfg.agents,
                defaults: {
                    ...params.cfg.agents?.defaults,
                    model: {
                        ...toAgentModelListLike(params.cfg.agents?.defaults?.model),
                        primary: agentModelOverride,
                    },
                },
            },
        }
        : params.cfg;
    return resolveConfiguredModelRef({
        cfg,
        defaultProvider: DEFAULT_PROVIDER,
        defaultModel: DEFAULT_MODEL,
    });
}
export function resolveSubagentConfiguredModelSelection(params) {
    const agentConfig = resolveAgentConfig(params.cfg, params.agentId);
    return (normalizeModelSelection(agentConfig?.subagents?.model) ??
        normalizeModelSelection(params.cfg.agents?.defaults?.subagents?.model) ??
        normalizeModelSelection(agentConfig?.model));
}
export function resolveSubagentSpawnModelSelection(params) {
    const runtimeDefault = resolveDefaultModelForAgent({
        cfg: params.cfg,
        agentId: params.agentId,
    });
    return (normalizeModelSelection(params.modelOverride) ??
        resolveSubagentConfiguredModelSelection({
            cfg: params.cfg,
            agentId: params.agentId,
        }) ??
        normalizeModelSelection(resolveAgentModelPrimaryValue(params.cfg.agents?.defaults?.model)) ??
        `${runtimeDefault.provider}/${runtimeDefault.model}`);
}
export function buildAllowedModelSet(params) {
    const rawAllowlist = (() => {
        const modelMap = params.cfg.agents?.defaults?.models ?? {};
        return Object.keys(modelMap);
    })();
    const allowAny = rawAllowlist.length === 0;
    const defaultModel = params.defaultModel?.trim();
    const defaultRef = defaultModel && params.defaultProvider
        ? parseModelRef(defaultModel, params.defaultProvider)
        : null;
    const defaultKey = defaultRef ? modelKey(defaultRef.provider, defaultRef.model) : undefined;
    const catalogKeys = new Set(params.catalog.map((entry) => modelKey(entry.provider, entry.id)));
    if (allowAny) {
        if (defaultKey) {
            catalogKeys.add(defaultKey);
        }
        return {
            allowAny: true,
            allowedCatalog: params.catalog,
            allowedKeys: catalogKeys,
        };
    }
    const allowedKeys = new Set();
    const syntheticCatalogEntries = new Map();
    for (const raw of rawAllowlist) {
        const parsed = parseModelRef(String(raw), params.defaultProvider);
        if (!parsed) {
            continue;
        }
        const key = modelKey(parsed.provider, parsed.model);
        // Explicit allowlist entries are always trusted, even when bundled catalog
        // data is stale and does not include the configured model yet.
        allowedKeys.add(key);
        if (!catalogKeys.has(key) && !syntheticCatalogEntries.has(key)) {
            syntheticCatalogEntries.set(key, {
                id: parsed.model,
                name: parsed.model,
                provider: parsed.provider,
            });
        }
    }
    if (defaultKey) {
        allowedKeys.add(defaultKey);
    }
    const allowedCatalog = [
        ...params.catalog.filter((entry) => allowedKeys.has(modelKey(entry.provider, entry.id))),
        ...syntheticCatalogEntries.values(),
    ];
    if (allowedCatalog.length === 0 && allowedKeys.size === 0) {
        if (defaultKey) {
            catalogKeys.add(defaultKey);
        }
        return {
            allowAny: true,
            allowedCatalog: params.catalog,
            allowedKeys: catalogKeys,
        };
    }
    return { allowAny: false, allowedCatalog, allowedKeys };
}
export function getModelRefStatus(params) {
    const allowed = buildAllowedModelSet({
        cfg: params.cfg,
        catalog: params.catalog,
        defaultProvider: params.defaultProvider,
        defaultModel: params.defaultModel,
    });
    const key = modelKey(params.ref.provider, params.ref.model);
    return {
        key,
        inCatalog: params.catalog.some((entry) => modelKey(entry.provider, entry.id) === key),
        allowAny: allowed.allowAny,
        allowed: allowed.allowAny || allowed.allowedKeys.has(key),
    };
}
export function resolveAllowedModelRef(params) {
    const trimmed = params.raw.trim();
    if (!trimmed) {
        return { error: "invalid model: empty" };
    }
    const aliasIndex = buildModelAliasIndex({
        cfg: params.cfg,
        defaultProvider: params.defaultProvider,
    });
    const resolved = resolveModelRefFromString({
        raw: trimmed,
        defaultProvider: params.defaultProvider,
        aliasIndex,
    });
    if (!resolved) {
        return { error: `invalid model: ${trimmed}` };
    }
    const status = getModelRefStatus({
        cfg: params.cfg,
        catalog: params.catalog,
        ref: resolved.ref,
        defaultProvider: params.defaultProvider,
        defaultModel: params.defaultModel,
    });
    if (!status.allowed) {
        return { error: `model not allowed: ${status.key}` };
    }
    return { ref: resolved.ref, key: status.key };
}
export function resolveThinkingDefault(params) {
    const normalizedProvider = normalizeProviderId(params.provider);
    const modelLower = params.model.toLowerCase();
    const perModelThinking = params.cfg.agents?.defaults?.models?.[modelKey(params.provider, params.model)]?.params
        ?.thinking;
    if (perModelThinking === "off" ||
        perModelThinking === "minimal" ||
        perModelThinking === "low" ||
        perModelThinking === "medium" ||
        perModelThinking === "high" ||
        perModelThinking === "xhigh" ||
        perModelThinking === "adaptive") {
        return perModelThinking;
    }
    const configured = params.cfg.agents?.defaults?.thinkingDefault;
    if (configured) {
        return configured;
    }
    const isAnthropicFamilyModel = normalizedProvider === "anthropic" ||
        normalizedProvider === "amazon-bedrock" ||
        modelLower.includes("anthropic/") ||
        modelLower.includes(".anthropic.");
    if (isAnthropicFamilyModel && CLAUDE_46_MODEL_RE.test(modelLower)) {
        return "adaptive";
    }
    const candidate = params.catalog?.find((entry) => entry.provider === params.provider && entry.id === params.model);
    if (candidate?.reasoning) {
        return "low";
    }
    return "off";
}
/** Default reasoning level when session/directive do not set it: "on" if model supports reasoning, else "off". */
export function resolveReasoningDefault(params) {
    const key = modelKey(params.provider, params.model);
    const candidate = params.catalog?.find((entry) => (entry.provider === params.provider && entry.id === params.model) ||
        (entry.provider === key && entry.id === params.model));
    return candidate?.reasoning === true ? "on" : "off";
}
/**
 * Resolve the model configured for Gmail hook processing.
 * Returns null if hooks.gmail.model is not set.
 */
export function resolveHooksGmailModel(params) {
    const hooksModel = params.cfg.hooks?.gmail?.model;
    if (!hooksModel?.trim()) {
        return null;
    }
    const aliasIndex = buildModelAliasIndex({
        cfg: params.cfg,
        defaultProvider: params.defaultProvider,
    });
    const resolved = resolveModelRefFromString({
        raw: hooksModel,
        defaultProvider: params.defaultProvider,
        aliasIndex,
    });
    return resolved?.ref ?? null;
}
/**
 * Normalize a model selection value (string or `{primary?: string}`) to a
 * plain trimmed string.  Returns `undefined` when the input is empty/missing.
 * Shared by sessions-spawn and cron isolated-agent model resolution.
 */
export function normalizeModelSelection(value) {
    if (typeof value === "string") {
        const trimmed = value.trim();
        return trimmed || undefined;
    }
    if (!value || typeof value !== "object") {
        return undefined;
    }
    const primary = value.primary;
    if (typeof primary === "string" && primary.trim()) {
        return primary.trim();
    }
    return undefined;
}
