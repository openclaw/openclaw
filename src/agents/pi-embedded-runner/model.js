import { AuthStorage as PiAuthStorageClass, ModelRegistry as PiModelRegistryClass, } from "@mariozechner/pi-coding-agent";
import { applyProviderResolvedModelCompatWithPlugins, applyProviderResolvedTransportWithPlugin, buildProviderUnknownModelHintWithPlugin, clearProviderRuntimeHookCache, normalizeProviderTransportWithPlugin, prepareProviderDynamicModel, runProviderDynamicModel, normalizeProviderResolvedModelWithPlugin, shouldPreferProviderRuntimeResolvedModel, } from "../../plugins/provider-runtime.js";
import { resolveOpenClawAgentDir } from "../agent-paths.js";
import { DEFAULT_CONTEXT_TOKENS } from "../defaults.js";
import { buildModelAliasLines } from "../model-alias-lines.js";
import { normalizeStaticProviderModelId } from "../model-ref-shared.js";
import { findNormalizedProviderValue, normalizeProviderId } from "../model-selection.js";
import { buildSuppressedBuiltInModelError, shouldSuppressBuiltInModel, } from "../model-suppression.js";
import { isLegacyModelsAddCodexMetadataModel } from "../openai-codex-models-add-legacy.js";
import { discoverAuthStorage, discoverModels } from "../pi-model-discovery.js";
import { attachModelProviderRequestTransport, resolveProviderRequestConfig, sanitizeConfiguredModelProviderRequest, } from "../provider-request-config.js";
import { buildInlineProviderModels, normalizeResolvedTransportApi, resolveProviderModelInput, sanitizeModelHeaders, } from "./model.inline-provider.js";
import { normalizeResolvedProviderModel } from "./model.provider-normalization.js";
const DEFAULT_PROVIDER_RUNTIME_HOOKS = {
    applyProviderResolvedModelCompatWithPlugins,
    applyProviderResolvedTransportWithPlugin,
    buildProviderUnknownModelHintWithPlugin,
    clearProviderRuntimeHookCache,
    prepareProviderDynamicModel,
    runProviderDynamicModel,
    shouldPreferProviderRuntimeResolvedModel,
    normalizeProviderResolvedModelWithPlugin,
    normalizeProviderTransportWithPlugin,
};
const STATIC_PROVIDER_RUNTIME_HOOKS = {
    applyProviderResolvedModelCompatWithPlugins: () => undefined,
    applyProviderResolvedTransportWithPlugin: () => undefined,
    buildProviderUnknownModelHintWithPlugin: () => undefined,
    clearProviderRuntimeHookCache: () => { },
    prepareProviderDynamicModel: async () => { },
    runProviderDynamicModel: () => undefined,
    normalizeProviderResolvedModelWithPlugin: () => undefined,
    normalizeProviderTransportWithPlugin: () => undefined,
};
function createEmptyPiDiscoveryStores() {
    const authStorage = typeof PiAuthStorageClass.inMemory === "function"
        ? PiAuthStorageClass.inMemory({})
        : PiAuthStorageClass.create();
    const modelRegistry = typeof PiModelRegistryClass.inMemory === "function"
        ? PiModelRegistryClass.inMemory(authStorage)
        : PiModelRegistryClass.create(authStorage);
    return { authStorage, modelRegistry };
}
function resolveRuntimeHooks(params) {
    if (params?.skipProviderRuntimeHooks) {
        return STATIC_PROVIDER_RUNTIME_HOOKS;
    }
    return params?.runtimeHooks ?? DEFAULT_PROVIDER_RUNTIME_HOOKS;
}
function canonicalizeLegacyResolvedModel(params) {
    if (normalizeProviderId(params.provider) !== "openai-codex" ||
        params.model.id.trim().toLowerCase() !== "gpt-5.4-codex") {
        return params.model;
    }
    return {
        ...params.model,
        id: "gpt-5.4",
        name: params.model.name.trim().toLowerCase() === "gpt-5.4-codex" ? "gpt-5.4" : params.model.name,
    };
}
function applyResolvedTransportFallback(params) {
    const normalized = params.runtimeHooks.normalizeProviderTransportWithPlugin({
        provider: params.provider,
        config: params.cfg,
        context: {
            provider: params.provider,
            api: params.model.api,
            baseUrl: params.model.baseUrl,
        },
    });
    if (!normalized) {
        return undefined;
    }
    const nextApi = normalizeResolvedTransportApi(normalized.api) ?? params.model.api;
    const nextBaseUrl = normalized.baseUrl ?? params.model.baseUrl;
    if (nextApi === params.model.api && nextBaseUrl === params.model.baseUrl) {
        return undefined;
    }
    return {
        ...params.model,
        api: nextApi,
        baseUrl: nextBaseUrl,
    };
}
function normalizeResolvedModel(params) {
    const normalizedInputModel = {
        ...params.model,
        input: resolveProviderModelInput({
            provider: params.provider,
            modelId: params.model.id,
            modelName: params.model.name,
            input: params.model.input,
        }),
    };
    const runtimeHooks = params.runtimeHooks ?? DEFAULT_PROVIDER_RUNTIME_HOOKS;
    const pluginNormalized = runtimeHooks.normalizeProviderResolvedModelWithPlugin({
        provider: params.provider,
        config: params.cfg,
        context: {
            config: params.cfg,
            agentDir: params.agentDir,
            provider: params.provider,
            modelId: normalizedInputModel.id,
            model: normalizedInputModel,
        },
    });
    const compatNormalized = runtimeHooks.applyProviderResolvedModelCompatWithPlugins?.({
        provider: params.provider,
        config: params.cfg,
        context: {
            config: params.cfg,
            agentDir: params.agentDir,
            provider: params.provider,
            modelId: normalizedInputModel.id,
            model: (pluginNormalized ?? normalizedInputModel),
        },
    });
    const transportNormalized = runtimeHooks.applyProviderResolvedTransportWithPlugin?.({
        provider: params.provider,
        config: params.cfg,
        context: {
            config: params.cfg,
            agentDir: params.agentDir,
            provider: params.provider,
            modelId: normalizedInputModel.id,
            model: (compatNormalized ?? pluginNormalized ?? normalizedInputModel),
        },
    });
    const fallbackTransportNormalized = transportNormalized ??
        applyResolvedTransportFallback({
            provider: params.provider,
            cfg: params.cfg,
            runtimeHooks,
            model: compatNormalized ?? pluginNormalized ?? normalizedInputModel,
        });
    return canonicalizeLegacyResolvedModel({
        provider: params.provider,
        model: normalizeResolvedProviderModel({
            provider: params.provider,
            model: fallbackTransportNormalized ?? compatNormalized ?? pluginNormalized ?? normalizedInputModel,
        }),
    });
}
function resolveProviderTransport(params) {
    const runtimeHooks = params.runtimeHooks ?? DEFAULT_PROVIDER_RUNTIME_HOOKS;
    const normalized = runtimeHooks.normalizeProviderTransportWithPlugin({
        provider: params.provider,
        config: params.cfg,
        context: {
            provider: params.provider,
            api: params.api,
            baseUrl: params.baseUrl,
        },
    });
    return {
        api: normalizeResolvedTransportApi(normalized?.api ?? params.api),
        baseUrl: normalized?.baseUrl ?? params.baseUrl,
    };
}
function findInlineModelMatch(params) {
    const inlineModels = buildInlineProviderModels(params.providers);
    const exact = inlineModels.find((entry) => entry.provider === params.provider && entry.id === params.modelId);
    if (exact) {
        return exact;
    }
    const normalizedProvider = normalizeProviderId(params.provider);
    return inlineModels.find((entry) => normalizeProviderId(entry.provider) === normalizedProvider && entry.id === params.modelId);
}
export { buildModelAliasLines, buildInlineProviderModels };
function resolveConfiguredProviderConfig(cfg, provider) {
    const configuredProviders = cfg?.models?.providers;
    if (!configuredProviders) {
        return undefined;
    }
    const exactProviderConfig = configuredProviders[provider];
    if (exactProviderConfig) {
        return exactProviderConfig;
    }
    return findNormalizedProviderValue(configuredProviders, provider);
}
function isModelsAddMetadataModel(params) {
    return (params.model?.metadataSource === "models-add" ||
        isLegacyModelsAddCodexMetadataModel(params));
}
function applyConfiguredProviderOverrides(params) {
    const { discoveredModel, providerConfig, modelId } = params;
    if (!providerConfig) {
        return {
            ...discoveredModel,
            // Discovered models originate from models.json and may contain persistence markers.
            headers: sanitizeModelHeaders(discoveredModel.headers, { stripSecretRefMarkers: true }),
        };
    }
    const configuredModel = providerConfig.models?.find((candidate) => candidate.id === modelId) ??
        (discoveredModel.id !== modelId
            ? providerConfig.models?.find((candidate) => candidate.id === discoveredModel.id)
            : undefined);
    const metadataOverrideModel = params.preferDiscoveredModelMetadata &&
        isModelsAddMetadataModel({ provider: params.provider, model: configuredModel })
        ? undefined
        : configuredModel;
    const discoveredHeaders = sanitizeModelHeaders(discoveredModel.headers, {
        stripSecretRefMarkers: true,
    });
    const providerHeaders = sanitizeModelHeaders(providerConfig.headers, {
        stripSecretRefMarkers: true,
    });
    const providerRequest = sanitizeConfiguredModelProviderRequest(providerConfig.request);
    const configuredHeaders = sanitizeModelHeaders(configuredModel?.headers, {
        stripSecretRefMarkers: true,
    });
    if (!configuredModel &&
        !providerConfig.baseUrl &&
        !providerConfig.api &&
        !providerHeaders &&
        !providerRequest) {
        return {
            ...discoveredModel,
            headers: discoveredHeaders,
        };
    }
    const normalizedInput = resolveProviderModelInput({
        provider: params.provider,
        modelId,
        modelName: metadataOverrideModel?.name ?? discoveredModel.name,
        input: metadataOverrideModel?.input,
        fallbackInput: discoveredModel.input,
    });
    const resolvedTransport = resolveProviderTransport({
        provider: params.provider,
        api: metadataOverrideModel?.api ?? providerConfig.api ?? discoveredModel.api,
        baseUrl: providerConfig.baseUrl ?? discoveredModel.baseUrl,
        cfg: params.cfg,
        runtimeHooks: params.runtimeHooks,
    });
    const requestConfig = resolveProviderRequestConfig({
        provider: params.provider,
        api: resolvedTransport.api ??
            normalizeResolvedTransportApi(discoveredModel.api) ??
            "openai-responses",
        baseUrl: resolvedTransport.baseUrl ?? discoveredModel.baseUrl,
        discoveredHeaders,
        providerHeaders,
        modelHeaders: configuredHeaders,
        authHeader: providerConfig.authHeader,
        request: providerRequest,
        capability: "llm",
        transport: "stream",
    });
    return attachModelProviderRequestTransport({
        ...discoveredModel,
        api: requestConfig.api ?? "openai-responses",
        baseUrl: requestConfig.baseUrl ?? discoveredModel.baseUrl,
        reasoning: metadataOverrideModel?.reasoning ?? discoveredModel.reasoning,
        input: normalizedInput,
        cost: metadataOverrideModel?.cost ?? discoveredModel.cost,
        contextWindow: metadataOverrideModel?.contextWindow ?? discoveredModel.contextWindow,
        contextTokens: metadataOverrideModel?.contextTokens ?? discoveredModel.contextTokens,
        maxTokens: metadataOverrideModel?.maxTokens ?? discoveredModel.maxTokens,
        headers: requestConfig.headers,
        compat: metadataOverrideModel?.compat ?? discoveredModel.compat,
    }, providerRequest);
}
function resolveExplicitModelWithRegistry(params) {
    const { provider, modelId, modelRegistry, cfg, agentDir, runtimeHooks } = params;
    const providerConfig = resolveConfiguredProviderConfig(cfg, provider);
    if (shouldSuppressBuiltInModel({
        provider,
        id: modelId,
        baseUrl: providerConfig?.baseUrl,
        config: cfg,
    })) {
        return { kind: "suppressed" };
    }
    const inlineMatch = findInlineModelMatch({
        providers: cfg?.models?.providers ?? {},
        provider,
        modelId,
    });
    if (inlineMatch?.api) {
        return {
            kind: "resolved",
            model: normalizeResolvedModel({
                provider,
                cfg,
                agentDir,
                model: inlineMatch,
                runtimeHooks,
            }),
        };
    }
    const model = modelRegistry.find(provider, modelId);
    if (model) {
        return {
            kind: "resolved",
            model: normalizeResolvedModel({
                provider,
                cfg,
                agentDir,
                model: applyConfiguredProviderOverrides({
                    provider,
                    discoveredModel: model,
                    providerConfig,
                    modelId,
                    cfg,
                    runtimeHooks,
                }),
                runtimeHooks,
            }),
        };
    }
    const providers = cfg?.models?.providers ?? {};
    const fallbackInlineMatch = findInlineModelMatch({
        providers,
        provider,
        modelId,
    });
    if (fallbackInlineMatch?.api) {
        return {
            kind: "resolved",
            model: normalizeResolvedModel({
                provider,
                cfg,
                agentDir,
                model: fallbackInlineMatch,
                runtimeHooks,
            }),
        };
    }
    return undefined;
}
function resolvePluginDynamicModelWithRegistry(params) {
    const { provider, modelId, modelRegistry, cfg, agentDir, workspaceDir } = params;
    const runtimeHooks = params.runtimeHooks ?? DEFAULT_PROVIDER_RUNTIME_HOOKS;
    const providerConfig = resolveConfiguredProviderConfig(cfg, provider);
    const preferDiscoveredModelMetadata = shouldCompareProviderRuntimeResolvedModel({
        provider,
        modelId,
        cfg,
        agentDir,
        workspaceDir,
        runtimeHooks,
    });
    const pluginDynamicModel = runtimeHooks.runProviderDynamicModel({
        provider,
        config: cfg,
        workspaceDir,
        context: {
            config: cfg,
            agentDir,
            provider,
            modelId,
            modelRegistry,
            providerConfig,
        },
    });
    if (!pluginDynamicModel) {
        return undefined;
    }
    const overriddenDynamicModel = applyConfiguredProviderOverrides({
        provider,
        discoveredModel: pluginDynamicModel,
        providerConfig,
        modelId,
        cfg,
        runtimeHooks,
        preferDiscoveredModelMetadata,
    });
    return normalizeResolvedModel({
        provider,
        cfg,
        agentDir,
        model: overriddenDynamicModel,
        runtimeHooks,
    });
}
function resolveConfiguredFallbackModel(params) {
    const { provider, modelId, cfg, agentDir, runtimeHooks } = params;
    const providerConfig = resolveConfiguredProviderConfig(cfg, provider);
    const configuredModel = providerConfig?.models?.find((candidate) => candidate.id === modelId);
    const providerHeaders = sanitizeModelHeaders(providerConfig?.headers, {
        stripSecretRefMarkers: true,
    });
    const providerRequest = sanitizeConfiguredModelProviderRequest(providerConfig?.request);
    const modelHeaders = sanitizeModelHeaders(configuredModel?.headers, {
        stripSecretRefMarkers: true,
    });
    if (!providerConfig && !modelId.startsWith("mock-")) {
        return undefined;
    }
    const fallbackTransport = resolveProviderTransport({
        provider,
        api: providerConfig?.api ?? "openai-responses",
        baseUrl: providerConfig?.baseUrl,
        cfg,
        runtimeHooks,
    });
    const requestConfig = resolveProviderRequestConfig({
        provider,
        api: fallbackTransport.api ?? "openai-responses",
        baseUrl: fallbackTransport.baseUrl,
        providerHeaders,
        modelHeaders,
        authHeader: providerConfig?.authHeader,
        request: providerRequest,
        capability: "llm",
        transport: "stream",
    });
    return normalizeResolvedModel({
        provider,
        cfg,
        agentDir,
        model: attachModelProviderRequestTransport({
            id: modelId,
            name: modelId,
            api: requestConfig.api ?? "openai-responses",
            provider,
            baseUrl: requestConfig.baseUrl,
            reasoning: configuredModel?.reasoning ?? false,
            input: resolveProviderModelInput({
                provider,
                modelId,
                modelName: configuredModel?.name ?? modelId,
                input: configuredModel?.input,
            }),
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: configuredModel?.contextWindow ??
                providerConfig?.models?.[0]?.contextWindow ??
                DEFAULT_CONTEXT_TOKENS,
            contextTokens: configuredModel?.contextTokens ?? providerConfig?.models?.[0]?.contextTokens,
            maxTokens: configuredModel?.maxTokens ??
                providerConfig?.models?.[0]?.maxTokens ??
                DEFAULT_CONTEXT_TOKENS,
            headers: requestConfig.headers,
        }, providerRequest),
        runtimeHooks,
    });
}
function shouldCompareProviderRuntimeResolvedModel(params) {
    return (params.runtimeHooks.shouldPreferProviderRuntimeResolvedModel?.({
        provider: params.provider,
        config: params.cfg,
        workspaceDir: params.workspaceDir,
        context: {
            provider: params.provider,
            modelId: params.modelId,
            config: params.cfg,
            agentDir: params.agentDir,
            workspaceDir: params.workspaceDir,
        },
    }) ?? false);
}
function preferProviderRuntimeResolvedModel(params) {
    if (params.runtimeResolvedModel) {
        return params.runtimeResolvedModel;
    }
    return params.explicitModel;
}
export function resolveModelWithRegistry(params) {
    const normalizedRef = {
        provider: params.provider,
        model: normalizeStaticProviderModelId(normalizeProviderId(params.provider), params.modelId),
    };
    const normalizedParams = {
        ...params,
        provider: normalizedRef.provider,
        modelId: normalizedRef.model,
    };
    const runtimeHooks = params.runtimeHooks ?? DEFAULT_PROVIDER_RUNTIME_HOOKS;
    const workspaceDir = normalizedParams.cfg?.agents?.defaults?.workspace;
    const explicitModel = resolveExplicitModelWithRegistry(normalizedParams);
    if (explicitModel?.kind === "suppressed") {
        return undefined;
    }
    if (explicitModel?.kind === "resolved") {
        if (!shouldCompareProviderRuntimeResolvedModel({
            provider: normalizedParams.provider,
            modelId: normalizedParams.modelId,
            cfg: normalizedParams.cfg,
            agentDir: normalizedParams.agentDir,
            workspaceDir,
            runtimeHooks,
        })) {
            return explicitModel.model;
        }
        const pluginDynamicModel = resolvePluginDynamicModelWithRegistry({
            ...normalizedParams,
            workspaceDir,
        });
        return preferProviderRuntimeResolvedModel({
            explicitModel: explicitModel.model,
            runtimeResolvedModel: pluginDynamicModel,
        });
    }
    const pluginDynamicModel = resolvePluginDynamicModelWithRegistry(normalizedParams);
    if (pluginDynamicModel) {
        return pluginDynamicModel;
    }
    return resolveConfiguredFallbackModel(normalizedParams);
}
export function resolveModel(provider, modelId, agentDir, cfg, options) {
    const normalizedRef = {
        provider,
        model: normalizeStaticProviderModelId(normalizeProviderId(provider), modelId),
    };
    const resolvedAgentDir = agentDir ?? resolveOpenClawAgentDir();
    const authStorage = options?.authStorage ?? discoverAuthStorage(resolvedAgentDir);
    const modelRegistry = options?.modelRegistry ?? discoverModels(authStorage, resolvedAgentDir);
    const runtimeHooks = resolveRuntimeHooks(options);
    const model = resolveModelWithRegistry({
        provider: normalizedRef.provider,
        modelId: normalizedRef.model,
        modelRegistry,
        cfg,
        agentDir: resolvedAgentDir,
        runtimeHooks,
    });
    if (model) {
        return { model, authStorage, modelRegistry };
    }
    return {
        error: buildUnknownModelError({
            provider: normalizedRef.provider,
            modelId: normalizedRef.model,
            cfg,
            agentDir: resolvedAgentDir,
            runtimeHooks,
        }),
        authStorage,
        modelRegistry,
    };
}
export async function resolveModelAsync(provider, modelId, agentDir, cfg, options) {
    const normalizedRef = {
        provider,
        model: normalizeStaticProviderModelId(normalizeProviderId(provider), modelId),
    };
    const resolvedAgentDir = agentDir ?? resolveOpenClawAgentDir();
    const emptyDiscoveryStores = options?.skipPiDiscovery && (!options.authStorage || !options.modelRegistry)
        ? createEmptyPiDiscoveryStores()
        : undefined;
    const authStorage = options?.authStorage ??
        emptyDiscoveryStores?.authStorage ??
        discoverAuthStorage(resolvedAgentDir);
    const modelRegistry = options?.modelRegistry ??
        emptyDiscoveryStores?.modelRegistry ??
        discoverModels(authStorage, resolvedAgentDir);
    const runtimeHooks = resolveRuntimeHooks(options);
    const explicitModel = resolveExplicitModelWithRegistry({
        provider: normalizedRef.provider,
        modelId: normalizedRef.model,
        modelRegistry,
        cfg,
        agentDir: resolvedAgentDir,
        runtimeHooks,
    });
    if (explicitModel?.kind === "suppressed") {
        return {
            error: buildUnknownModelError({
                provider: normalizedRef.provider,
                modelId: normalizedRef.model,
                cfg,
                agentDir: resolvedAgentDir,
                runtimeHooks,
            }),
            authStorage,
            modelRegistry,
        };
    }
    const providerConfig = resolveConfiguredProviderConfig(cfg, normalizedRef.provider);
    const resolveDynamicAttempt = async (attemptOptions) => {
        if (attemptOptions?.clearHookCache) {
            runtimeHooks.clearProviderRuntimeHookCache();
        }
        await runtimeHooks.prepareProviderDynamicModel({
            provider: normalizedRef.provider,
            config: cfg,
            context: {
                config: cfg,
                agentDir: resolvedAgentDir,
                provider: normalizedRef.provider,
                modelId: normalizedRef.model,
                modelRegistry,
                providerConfig,
            },
        });
        return resolveModelWithRegistry({
            provider: normalizedRef.provider,
            modelId: normalizedRef.model,
            modelRegistry,
            cfg,
            agentDir: resolvedAgentDir,
            runtimeHooks,
        });
    };
    let model = explicitModel?.kind === "resolved" &&
        !shouldCompareProviderRuntimeResolvedModel({
            provider: normalizedRef.provider,
            modelId: normalizedRef.model,
            cfg,
            agentDir: resolvedAgentDir,
            runtimeHooks,
        })
        ? explicitModel.model
        : await resolveDynamicAttempt();
    if (!model && !explicitModel && options?.retryTransientProviderRuntimeMiss) {
        // Startup can race the first provider-runtime snapshot load on a fresh
        // gateway boot. Retry once with a cleared hook cache before surfacing a
        // user-visible "Unknown model" that disappears on the next message.
        model = await resolveDynamicAttempt({ clearHookCache: true });
    }
    if (model) {
        return { model, authStorage, modelRegistry };
    }
    return {
        error: buildUnknownModelError({
            provider: normalizedRef.provider,
            modelId: normalizedRef.model,
            cfg,
            agentDir: resolvedAgentDir,
            runtimeHooks,
        }),
        authStorage,
        modelRegistry,
    };
}
/**
 * Build a more helpful error when the model is not found.
 *
 * Some provider plugins only become available after setup/auth has registered
 * them. When users point `agents.defaults.model.primary` at one of those
 * providers before setup, the raw `Unknown model` error is too vague. Provider
 * plugins can append a targeted recovery hint here.
 *
 * See: https://github.com/openclaw/openclaw/issues/17328
 */
function buildUnknownModelError(params) {
    const suppressed = buildSuppressedBuiltInModelError({
        provider: params.provider,
        id: params.modelId,
    });
    if (suppressed) {
        return suppressed;
    }
    const base = `Unknown model: ${params.provider}/${params.modelId}`;
    const runtimeHooks = params.runtimeHooks ?? DEFAULT_PROVIDER_RUNTIME_HOOKS;
    const hint = runtimeHooks.buildProviderUnknownModelHintWithPlugin({
        provider: params.provider,
        config: params.cfg,
        env: process.env,
        context: {
            config: params.cfg,
            agentDir: params.agentDir,
            env: process.env,
            provider: params.provider,
            modelId: params.modelId,
        },
    });
    return hint ? `${base}. ${hint}` : base;
}
