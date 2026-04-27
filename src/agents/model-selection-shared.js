import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeLowercaseStringOrEmpty, normalizeOptionalString, } from "../shared/string-coerce.js";
import { sanitizeForLog, stripAnsi } from "../terminal/ansi.js";
import { resolveConfiguredProviderFallback } from "./configured-provider-fallback.js";
import { DEFAULT_PROVIDER } from "./defaults.js";
import { splitTrailingAuthProfile } from "./model-ref-profile.js";
import { findNormalizedProviderValue, modelKey, normalizeModelRef, normalizeProviderId, parseModelRef, } from "./model-selection-normalize.js";
let log = null;
function getLog() {
    log ??= createSubsystemLogger("model-selection");
    return log;
}
const OPENROUTER_COMPAT_FREE_ALIAS = "openrouter:free";
function sanitizeModelWarningValue(value) {
    const stripped = value ? stripAnsi(value) : "";
    let controlBoundary = -1;
    for (let index = 0; index < stripped.length; index += 1) {
        const code = stripped.charCodeAt(index);
        if (code <= 0x1f || code === 0x7f) {
            controlBoundary = index;
            break;
        }
    }
    if (controlBoundary === -1) {
        return sanitizeForLog(stripped);
    }
    return sanitizeForLog(stripped.slice(0, controlBoundary));
}
export function inferUniqueProviderFromConfiguredModels(params) {
    const model = params.model.trim();
    if (!model) {
        return undefined;
    }
    const normalized = normalizeLowercaseStringOrEmpty(model);
    const providers = new Set();
    const addProvider = (provider) => {
        const normalizedProvider = normalizeProviderId(provider);
        if (!normalizedProvider) {
            return;
        }
        providers.add(normalizedProvider);
    };
    const configuredModels = params.cfg.agents?.defaults?.models;
    if (configuredModels) {
        for (const key of Object.keys(configuredModels)) {
            const ref = key.trim();
            if (!ref || !ref.includes("/")) {
                continue;
            }
            const parsed = parseModelRef(ref, DEFAULT_PROVIDER, {
                allowPluginNormalization: false,
            });
            if (!parsed) {
                continue;
            }
            if (parsed.model === model || normalizeLowercaseStringOrEmpty(parsed.model) === normalized) {
                addProvider(parsed.provider);
                if (providers.size > 1) {
                    return undefined;
                }
            }
        }
    }
    const configuredProviders = params.cfg.models?.providers;
    if (configuredProviders) {
        for (const [providerId, providerConfig] of Object.entries(configuredProviders)) {
            const models = providerConfig?.models;
            if (!Array.isArray(models)) {
                continue;
            }
            for (const entry of models) {
                const modelId = entry?.id?.trim();
                if (!modelId) {
                    continue;
                }
                if (modelId === model || normalizeLowercaseStringOrEmpty(modelId) === normalized) {
                    addProvider(providerId);
                }
            }
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
export function inferUniqueProviderFromCatalog(params) {
    const model = params.model.trim();
    if (!model) {
        return undefined;
    }
    const normalized = normalizeLowercaseStringOrEmpty(model);
    const providers = new Set();
    for (const entry of params.catalog) {
        const entryId = entry.id.trim();
        if (!entryId) {
            continue;
        }
        if (entryId !== model && normalizeLowercaseStringOrEmpty(entryId) !== normalized) {
            continue;
        }
        const provider = normalizeProviderId(entry.provider);
        if (provider) {
            providers.add(provider);
        }
        if (providers.size > 1) {
            return undefined;
        }
    }
    return providers.size === 1 ? providers.values().next().value : undefined;
}
export function resolveBareModelDefaultProvider(params) {
    return (inferUniqueProviderFromConfiguredModels({ cfg: params.cfg, model: params.model }) ??
        inferUniqueProviderFromCatalog({ catalog: params.catalog, model: params.model }) ??
        params.defaultProvider);
}
function isConcreteOpenRouterFreeModelRef(ref) {
    return ref.provider === "openrouter" && ref.model.includes("/") && ref.model.endsWith(":free");
}
function resolveConfiguredOpenRouterCompatFreeRef(params) {
    const configuredModels = params.cfg.agents?.defaults?.models ?? {};
    for (const raw of Object.keys(configuredModels)) {
        if (!raw.includes("/")) {
            continue;
        }
        const parsed = parseModelRef(raw, params.defaultProvider, {
            allowPluginNormalization: params.allowPluginNormalization,
        });
        if (parsed && isConcreteOpenRouterFreeModelRef(parsed)) {
            return parsed;
        }
    }
    const openrouterProviderConfig = findNormalizedProviderValue(params.cfg.models?.providers, "openrouter");
    for (const entry of openrouterProviderConfig?.models ?? []) {
        const modelId = entry?.id?.trim();
        if (!modelId || !modelId.includes("/") || !modelId.endsWith(":free")) {
            continue;
        }
        return normalizeModelRef("openrouter", modelId, {
            allowPluginNormalization: params.allowPluginNormalization,
        });
    }
    return null;
}
export function resolveConfiguredOpenRouterCompatAlias(params) {
    const normalized = normalizeLowercaseStringOrEmpty(params.raw);
    if (normalized === "openrouter:auto") {
        return normalizeModelRef("openrouter", "auto", {
            allowPluginNormalization: params.allowPluginNormalization,
        });
    }
    if (normalized !== OPENROUTER_COMPAT_FREE_ALIAS || !params.cfg) {
        return null;
    }
    return resolveConfiguredOpenRouterCompatFreeRef({
        cfg: params.cfg,
        defaultProvider: params.defaultProvider,
        allowPluginNormalization: params.allowPluginNormalization,
    });
}
export function parseModelRefWithCompatAlias(params) {
    return (resolveConfiguredOpenRouterCompatAlias(params) ??
        parseModelRef(params.raw, params.defaultProvider, {
            allowPluginNormalization: params.allowPluginNormalization,
        }));
}
export function resolveAllowlistModelKey(params) {
    const parsed = parseModelRefWithCompatAlias({
        cfg: params.cfg,
        raw: params.raw,
        defaultProvider: params.defaultProvider,
    });
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
        const key = resolveAllowlistModelKey({
            cfg: params.cfg,
            raw,
            defaultProvider: params.defaultProvider,
        });
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
        const parsed = parseModelRefWithCompatAlias({
            cfg: params.cfg,
            raw: keyRaw,
            defaultProvider: params.defaultProvider,
            allowPluginNormalization: params.allowPluginNormalization,
        });
        if (!parsed) {
            continue;
        }
        const alias = normalizeOptionalString(entryRaw?.alias) ?? "";
        if (!alias) {
            continue;
        }
        const aliasKey = normalizeLowercaseStringOrEmpty(alias);
        byAlias.set(aliasKey, { alias, ref: parsed });
        const key = modelKey(parsed.provider, parsed.model);
        const existing = byKey.get(key) ?? [];
        existing.push(alias);
        byKey.set(key, existing);
    }
    return { byAlias, byKey };
}
function buildModelCatalogMetadata(params) {
    const configuredByKey = new Map();
    for (const entry of buildConfiguredModelCatalog({ cfg: params.cfg })) {
        configuredByKey.set(modelKey(entry.provider, entry.id), entry);
    }
    const aliasByKey = new Map();
    const configuredModels = params.cfg.agents?.defaults?.models ?? {};
    for (const [rawKey, entryRaw] of Object.entries(configuredModels)) {
        const key = resolveAllowlistModelKey({
            cfg: params.cfg,
            raw: rawKey,
            defaultProvider: params.defaultProvider,
        });
        if (!key) {
            continue;
        }
        const alias = (entryRaw?.alias ?? "").trim();
        if (!alias) {
            continue;
        }
        aliasByKey.set(key, alias);
    }
    return { configuredByKey, aliasByKey };
}
function applyModelCatalogMetadata(params) {
    const key = modelKey(params.entry.provider, params.entry.id);
    const configuredEntry = params.metadata.configuredByKey.get(key);
    const alias = params.metadata.aliasByKey.get(key);
    if (!configuredEntry && !alias) {
        return params.entry;
    }
    const nextAlias = alias ?? params.entry.alias;
    const nextContextWindow = configuredEntry?.contextWindow ?? params.entry.contextWindow;
    const nextReasoning = configuredEntry?.reasoning ?? params.entry.reasoning;
    const nextInput = configuredEntry?.input ?? params.entry.input;
    return {
        ...params.entry,
        name: configuredEntry?.name ?? params.entry.name,
        ...(nextAlias ? { alias: nextAlias } : {}),
        ...(nextContextWindow !== undefined ? { contextWindow: nextContextWindow } : {}),
        ...(nextReasoning !== undefined ? { reasoning: nextReasoning } : {}),
        ...(nextInput ? { input: nextInput } : {}),
    };
}
function buildSyntheticAllowedCatalogEntry(params) {
    const key = modelKey(params.parsed.provider, params.parsed.model);
    const configuredEntry = params.metadata.configuredByKey.get(key);
    const alias = params.metadata.aliasByKey.get(key);
    const nextContextWindow = configuredEntry?.contextWindow;
    const nextReasoning = configuredEntry?.reasoning;
    const nextInput = configuredEntry?.input;
    return {
        id: params.parsed.model,
        name: configuredEntry?.name ?? params.parsed.model,
        provider: params.parsed.provider,
        ...(alias ? { alias } : {}),
        ...(nextContextWindow !== undefined ? { contextWindow: nextContextWindow } : {}),
        ...(nextReasoning !== undefined ? { reasoning: nextReasoning } : {}),
        ...(nextInput ? { input: nextInput } : {}),
    };
}
export function resolveModelRefFromString(params) {
    const { model } = splitTrailingAuthProfile(params.raw);
    if (!model) {
        return null;
    }
    if (!model.includes("/")) {
        const aliasKey = normalizeLowercaseStringOrEmpty(model);
        const aliasMatch = params.aliasIndex?.byAlias.get(aliasKey);
        if (aliasMatch) {
            return { ref: aliasMatch.ref, alias: aliasMatch.alias };
        }
    }
    const parsed = parseModelRefWithCompatAlias({
        cfg: params.cfg,
        raw: model,
        defaultProvider: params.defaultProvider,
        allowPluginNormalization: params.allowPluginNormalization,
    });
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
            allowPluginNormalization: params.allowPluginNormalization,
        });
        if (!trimmed.includes("/")) {
            const openrouterCompatRef = resolveConfiguredOpenRouterCompatAlias({
                cfg: params.cfg,
                raw: trimmed,
                defaultProvider: params.defaultProvider,
                allowPluginNormalization: params.allowPluginNormalization,
            });
            if (openrouterCompatRef) {
                return openrouterCompatRef;
            }
            const aliasKey = normalizeLowercaseStringOrEmpty(trimmed);
            const aliasMatch = aliasIndex.byAlias.get(aliasKey);
            if (aliasMatch) {
                return aliasMatch.ref;
            }
            const inferredProvider = inferUniqueProviderFromConfiguredModels({
                cfg: params.cfg,
                model: trimmed,
            });
            if (inferredProvider) {
                return { provider: inferredProvider, model: trimmed };
            }
            const safeTrimmed = sanitizeModelWarningValue(trimmed);
            const safeResolved = sanitizeForLog(`${params.defaultProvider}/${safeTrimmed}`);
            getLog().warn(`Model "${safeTrimmed}" specified without provider. Falling back to "${safeResolved}". Please use "${safeResolved}" in your config.`);
            return { provider: params.defaultProvider, model: trimmed };
        }
        const resolved = resolveModelRefFromString({
            cfg: params.cfg,
            raw: trimmed,
            defaultProvider: params.defaultProvider,
            aliasIndex,
            allowPluginNormalization: params.allowPluginNormalization,
        });
        if (resolved) {
            return resolved.ref;
        }
        const safe = sanitizeForLog(trimmed);
        const safeFallback = sanitizeForLog(`${params.defaultProvider}/${params.defaultModel}`);
        getLog().warn(`Model "${safe}" could not be resolved. Falling back to default "${safeFallback}".`);
    }
    const fallbackProvider = resolveConfiguredProviderFallback({
        cfg: params.cfg,
        defaultProvider: params.defaultProvider,
    });
    if (fallbackProvider) {
        return fallbackProvider;
    }
    return { provider: params.defaultProvider, model: params.defaultModel };
}
export function buildAllowedModelSetWithFallbacks(params) {
    const metadata = buildModelCatalogMetadata({
        cfg: params.cfg,
        defaultProvider: params.defaultProvider,
    });
    const catalog = params.catalog.map((entry) => applyModelCatalogMetadata({ entry, metadata }));
    const rawAllowlist = (() => {
        const modelMap = params.cfg.agents?.defaults?.models ?? {};
        return Object.keys(modelMap);
    })();
    const allowAny = rawAllowlist.length === 0;
    const defaultModel = params.defaultModel?.trim();
    const defaultRef = defaultModel && params.defaultProvider
        ? parseModelRefWithCompatAlias({
            cfg: params.cfg,
            raw: defaultModel,
            defaultProvider: params.defaultProvider,
        })
        : null;
    const defaultKey = defaultRef ? modelKey(defaultRef.provider, defaultRef.model) : undefined;
    const catalogKeys = new Set(catalog.map((entry) => modelKey(entry.provider, entry.id)));
    if (allowAny) {
        if (defaultKey) {
            catalogKeys.add(defaultKey);
        }
        return {
            allowAny: true,
            allowedCatalog: catalog,
            allowedKeys: catalogKeys,
        };
    }
    const allowedKeys = new Set();
    const syntheticCatalogEntries = new Map();
    const addAllowedModelRef = (raw) => {
        const trimmed = raw.trim();
        const defaultProvider = !trimmed.includes("/")
            ? resolveBareModelDefaultProvider({
                cfg: params.cfg,
                catalog,
                model: trimmed,
                defaultProvider: params.defaultProvider,
            })
            : params.defaultProvider;
        const parsed = parseModelRefWithCompatAlias({
            cfg: params.cfg,
            raw,
            defaultProvider,
        });
        if (!parsed) {
            return;
        }
        const key = modelKey(parsed.provider, parsed.model);
        allowedKeys.add(key);
        if (!catalogKeys.has(key) && !syntheticCatalogEntries.has(key)) {
            syntheticCatalogEntries.set(key, buildSyntheticAllowedCatalogEntry({ parsed, metadata }));
        }
    };
    for (const raw of rawAllowlist) {
        addAllowedModelRef(raw);
    }
    for (const fallback of params.fallbackModels) {
        addAllowedModelRef(fallback);
    }
    if (defaultKey) {
        allowedKeys.add(defaultKey);
    }
    const allowedCatalog = [
        ...catalog.filter((entry) => allowedKeys.has(modelKey(entry.provider, entry.id))),
        ...syntheticCatalogEntries.values(),
    ];
    if (allowedCatalog.length === 0 && allowedKeys.size === 0) {
        if (defaultKey) {
            catalogKeys.add(defaultKey);
        }
        return {
            allowAny: true,
            allowedCatalog: catalog,
            allowedKeys: catalogKeys,
        };
    }
    return { allowAny: false, allowedCatalog, allowedKeys };
}
export function getModelRefStatusFromAllowedSet(params) {
    const key = modelKey(params.ref.provider, params.ref.model);
    return {
        key,
        inCatalog: params.catalog.some((entry) => modelKey(entry.provider, entry.id) === key),
        allowAny: params.allowed.allowAny,
        allowed: params.allowed.allowAny || params.allowed.allowedKeys.has(key),
    };
}
export function getModelRefStatusWithFallbackModels(params) {
    const allowed = buildAllowedModelSetWithFallbacks({
        cfg: params.cfg,
        catalog: params.catalog,
        defaultProvider: params.defaultProvider,
        defaultModel: params.defaultModel,
        fallbackModels: params.fallbackModels,
    });
    return getModelRefStatusFromAllowedSet({
        catalog: params.catalog,
        ref: params.ref,
        allowed,
    });
}
export function resolveAllowedModelRefFromAliasIndex(params) {
    const trimmed = params.raw.trim();
    if (!trimmed) {
        return { error: "invalid model: empty" };
    }
    const effectiveDefaultProvider = !trimmed.includes("/")
        ? (inferUniqueProviderFromConfiguredModels({ cfg: params.cfg, model: trimmed }) ??
            params.defaultProvider)
        : params.defaultProvider;
    const resolved = resolveModelRefFromString({
        cfg: params.cfg,
        raw: trimmed,
        defaultProvider: effectiveDefaultProvider,
        aliasIndex: params.aliasIndex,
    });
    if (!resolved) {
        return { error: `invalid model: ${trimmed}` };
    }
    const status = params.getStatus(resolved.ref);
    if (!status.allowed) {
        return { error: `model not allowed: ${status.key}` };
    }
    return { ref: resolved.ref, key: status.key };
}
export function buildConfiguredModelCatalog(params) {
    const providers = params.cfg.models?.providers;
    if (!providers || typeof providers !== "object") {
        return [];
    }
    const catalog = [];
    for (const [providerRaw, provider] of Object.entries(providers)) {
        const providerId = normalizeProviderId(providerRaw);
        if (!providerId || !Array.isArray(provider?.models)) {
            continue;
        }
        for (const model of provider.models) {
            const id = normalizeOptionalString(model?.id) ?? "";
            if (!id) {
                continue;
            }
            const name = normalizeOptionalString(model?.name) || id;
            const contextWindow = typeof model?.contextWindow === "number" && model.contextWindow > 0
                ? model.contextWindow
                : undefined;
            const reasoning = typeof model?.reasoning === "boolean" ? model.reasoning : undefined;
            const input = Array.isArray(model?.input) ? model.input : undefined;
            catalog.push({
                provider: providerId,
                id,
                name,
                contextWindow,
                reasoning,
                input,
            });
        }
    }
    return catalog;
}
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
        cfg: params.cfg,
        raw: hooksModel,
        defaultProvider: params.defaultProvider,
        aliasIndex,
    });
    return resolved?.ref ?? null;
}
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
