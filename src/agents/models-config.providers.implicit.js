import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { groupPluginDiscoveryProvidersByOrder, normalizePluginDiscoveryResult, resolvePluginDiscoveryProviders, runProviderCatalog, } from "../plugins/provider-discovery.js";
import { resolveOwningPluginIdsForProvider } from "../plugins/providers.js";
import { ensureAuthProfileStore } from "./auth-profiles/store.js";
import { isNonSecretApiKeyMarker, resolveNonEnvSecretRefApiKeyMarker, } from "./model-auth-markers.js";
import { createProviderApiKeyResolver, createProviderAuthResolver, } from "./models-config.providers.secrets.js";
import { findNormalizedProviderValue } from "./provider-id.js";
const log = createSubsystemLogger("agents/model-providers");
const PROVIDER_IMPLICIT_MERGERS = {
    ollama: ({ implicit }) => implicit,
};
const PLUGIN_DISCOVERY_ORDERS = ["simple", "profile", "paired", "late"];
function resolveLiveProviderCatalogTimeoutMs(env) {
    const live = env.OPENCLAW_LIVE_TEST === "1" || env.OPENCLAW_LIVE_GATEWAY === "1" || env.LIVE === "1";
    if (!live) {
        return null;
    }
    const raw = env.OPENCLAW_LIVE_PROVIDER_DISCOVERY_TIMEOUT_MS?.trim();
    if (!raw) {
        return 15_000;
    }
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 15_000;
}
function resolveProviderDiscoveryFilter(params) {
    const { config, workspaceDir, env } = params;
    const testRaw = env.OPENCLAW_TEST_ONLY_PROVIDER_PLUGIN_IDS?.trim();
    if (testRaw) {
        const ids = testRaw
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean);
        return ids.length > 0 ? [...new Set(ids)] : undefined;
    }
    const live = env.OPENCLAW_LIVE_TEST === "1" || env.OPENCLAW_LIVE_GATEWAY === "1" || env.LIVE === "1";
    if (!live) {
        return undefined;
    }
    const rawValues = [
        env.OPENCLAW_LIVE_PROVIDERS?.trim(),
        env.OPENCLAW_LIVE_GATEWAY_PROVIDERS?.trim(),
    ].filter((value) => Boolean(value && value !== "all"));
    if (rawValues.length === 0) {
        return undefined;
    }
    const ids = rawValues
        .flatMap((value) => value.split(","))
        .map((value) => value.trim())
        .filter(Boolean);
    if (ids.length === 0) {
        return undefined;
    }
    const pluginIds = new Set();
    for (const id of ids) {
        const owners = resolveOwningPluginIdsForProvider({
            provider: id,
            config,
            workspaceDir,
            env,
        }) ?? [];
        if (owners.length > 0) {
            for (const owner of owners) {
                pluginIds.add(owner);
            }
            continue;
        }
        pluginIds.add(id);
    }
    return pluginIds.size > 0
        ? [...pluginIds].toSorted((left, right) => left.localeCompare(right))
        : undefined;
}
export function resolveProviderDiscoveryFilterForTest(params) {
    return resolveProviderDiscoveryFilter(params);
}
function mergeImplicitProviderSet(target, additions) {
    if (!additions) {
        return;
    }
    for (const [key, value] of Object.entries(additions)) {
        target[key] = value;
    }
}
function mergeImplicitProviderConfig(params) {
    const { providerId, existing, implicit } = params;
    if (!existing) {
        return implicit;
    }
    const merge = PROVIDER_IMPLICIT_MERGERS[providerId];
    if (merge) {
        return merge({ existing, implicit });
    }
    return {
        ...implicit,
        ...existing,
        models: Array.isArray(existing.models) && existing.models.length > 0
            ? existing.models
            : implicit.models,
    };
}
function resolveConfiguredImplicitProvider(params) {
    for (const providerId of params.providerIds) {
        const configured = findNormalizedProviderValue(params.configuredProviders ?? undefined, providerId);
        if (configured) {
            return configured;
        }
    }
    return undefined;
}
function resolveExistingImplicitProviderFromContext(params) {
    return (resolveConfiguredImplicitProvider({
        configuredProviders: params.ctx.explicitProviders,
        providerIds: params.providerIds,
    }) ??
        resolveConfiguredImplicitProvider({
            configuredProviders: params.ctx.config?.models?.providers,
            providerIds: params.providerIds,
        }));
}
async function resolvePluginImplicitProviders(ctx, providers, order) {
    const byOrder = groupPluginDiscoveryProvidersByOrder(providers);
    const discovered = {};
    const catalogConfig = buildPluginCatalogConfig(ctx);
    for (const provider of byOrder[order]) {
        const resolveCatalogProviderApiKey = (providerId) => {
            const resolvedProviderId = providerId?.trim() || provider.id;
            const resolved = ctx.resolveProviderApiKey(resolvedProviderId);
            if (resolved.apiKey) {
                return resolved;
            }
            if (!findNormalizedProviderValue({
                [provider.id]: true,
                ...Object.fromEntries((provider.aliases ?? []).map((alias) => [alias, true])),
                ...Object.fromEntries((provider.hookAliases ?? []).map((alias) => [alias, true])),
            }, resolvedProviderId)) {
                return resolved;
            }
            const synthetic = provider.resolveSyntheticAuth?.({
                config: catalogConfig,
                provider: resolvedProviderId,
                providerConfig: catalogConfig.models?.providers?.[resolvedProviderId],
            });
            const syntheticApiKey = synthetic?.apiKey?.trim();
            if (!syntheticApiKey) {
                return resolved;
            }
            return {
                apiKey: isNonSecretApiKeyMarker(syntheticApiKey)
                    ? syntheticApiKey
                    : resolveNonEnvSecretRefApiKeyMarker("file"),
                discoveryApiKey: undefined,
            };
        };
        const result = await runProviderCatalogWithTimeout({
            provider,
            config: catalogConfig,
            agentDir: ctx.agentDir,
            workspaceDir: ctx.workspaceDir,
            env: ctx.env,
            resolveProviderApiKey: resolveCatalogProviderApiKey,
            resolveProviderAuth: (providerId, options) => ctx.resolveProviderAuth(providerId?.trim() || provider.id, options),
            timeoutMs: resolveLiveProviderCatalogTimeoutMs(ctx.env),
        });
        if (!result) {
            continue;
        }
        const normalizedResult = normalizePluginDiscoveryResult({
            provider,
            result,
        });
        for (const [providerId, implicitProvider] of Object.entries(normalizedResult)) {
            discovered[providerId] = mergeImplicitProviderConfig({
                providerId,
                existing: discovered[providerId] ??
                    resolveExistingImplicitProviderFromContext({
                        ctx,
                        providerIds: [
                            providerId,
                            provider.id,
                            ...(provider.aliases ?? []),
                            ...(provider.hookAliases ?? []),
                        ],
                    }),
                implicit: implicitProvider,
            });
        }
    }
    return Object.keys(discovered).length > 0 ? discovered : undefined;
}
function buildPluginCatalogConfig(ctx) {
    if (!ctx.explicitProviders || Object.keys(ctx.explicitProviders).length === 0) {
        return ctx.config ?? {};
    }
    return {
        ...ctx.config,
        models: {
            ...ctx.config?.models,
            providers: {
                ...ctx.config?.models?.providers,
                ...ctx.explicitProviders,
            },
        },
    };
}
async function runProviderCatalogWithTimeout(params) {
    const catalogRun = runProviderCatalog(params);
    const timeoutMs = params.timeoutMs ?? undefined;
    if (!timeoutMs) {
        return await catalogRun;
    }
    let timer;
    try {
        return await Promise.race([
            catalogRun,
            new Promise((_, reject) => {
                timer = setTimeout(() => {
                    reject(new Error(`provider catalog timed out after ${timeoutMs}ms: ${params.provider.id}`));
                }, timeoutMs);
                timer.unref?.();
            }),
        ]);
    }
    catch (error) {
        const message = formatErrorMessage(error);
        if (message.includes("provider catalog timed out after")) {
            log.warn(`${message}; skipping provider discovery`);
            return undefined;
        }
        throw error;
    }
    finally {
        if (timer) {
            clearTimeout(timer);
        }
    }
}
export async function resolveImplicitProviders(params) {
    const providers = {};
    const env = params.env ?? process.env;
    let authStore;
    const getAuthStore = () => (authStore ??= ensureAuthProfileStore(params.agentDir, {
        allowKeychainPrompt: false,
    }));
    const context = {
        ...params,
        get authStore() {
            return getAuthStore();
        },
        env,
        resolveProviderApiKey: createProviderApiKeyResolver(env, getAuthStore, params.config),
        resolveProviderAuth: createProviderAuthResolver(env, getAuthStore, params.config),
    };
    const discoveryProviders = await resolvePluginDiscoveryProviders({
        config: params.config,
        workspaceDir: params.workspaceDir,
        env,
        onlyPluginIds: resolveProviderDiscoveryFilter({
            config: params.config,
            workspaceDir: params.workspaceDir,
            env,
        }),
    });
    for (const order of PLUGIN_DISCOVERY_ORDERS) {
        mergeImplicitProviderSet(providers, await resolvePluginImplicitProviders(context, discoveryProviders, order));
    }
    return providers;
}
