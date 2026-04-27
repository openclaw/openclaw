import { loadPluginManifestRegistry } from "../plugins/manifest-registry.js";
import { isWorkspacePluginAllowedByConfig, normalizePluginConfigId, } from "../plugins/plugin-config-trust.js";
import { normalizeProviderId } from "./provider-id.js";
const PROVIDER_AUTH_ALIAS_ORIGIN_PRIORITY = {
    config: 0,
    bundled: 1,
    global: 2,
    workspace: 3,
};
function resolveProviderAuthAliasOriginPriority(origin) {
    if (!origin) {
        return Number.MAX_SAFE_INTEGER;
    }
    return PROVIDER_AUTH_ALIAS_ORIGIN_PRIORITY[origin] ?? Number.MAX_SAFE_INTEGER;
}
function isWorkspacePluginTrustedForAuthAliases(plugin, config) {
    return isWorkspacePluginAllowedByConfig({
        config,
        isImplicitlyAllowed: (pluginId) => normalizePluginConfigId(config?.plugins?.slots?.contextEngine) === pluginId,
        plugin,
    });
}
function shouldUsePluginAuthAliases(plugin, params) {
    if (plugin.origin !== "workspace" || params?.includeUntrustedWorkspacePlugins === true) {
        return true;
    }
    return isWorkspacePluginTrustedForAuthAliases(plugin, params?.config);
}
function setPreferredAlias(params) {
    const normalizedAlias = normalizeProviderId(params.alias);
    const normalizedTarget = normalizeProviderId(params.target);
    if (!normalizedAlias || !normalizedTarget) {
        return;
    }
    const existing = params.aliases.get(normalizedAlias);
    if (!existing ||
        resolveProviderAuthAliasOriginPriority(params.origin) <
            resolveProviderAuthAliasOriginPriority(existing.origin)) {
        params.aliases.set(normalizedAlias, {
            origin: params.origin,
            target: normalizedTarget,
        });
    }
}
export function resolveProviderAuthAliasMap(params) {
    const registry = loadPluginManifestRegistry({
        config: params?.config,
        workspaceDir: params?.workspaceDir,
        env: params?.env,
    });
    const preferredAliases = new Map();
    const aliases = Object.create(null);
    for (const plugin of registry.plugins) {
        if (!shouldUsePluginAuthAliases(plugin, params)) {
            continue;
        }
        for (const [alias, target] of Object.entries(plugin.providerAuthAliases ?? {}).toSorted(([left], [right]) => left.localeCompare(right))) {
            setPreferredAlias({
                aliases: preferredAliases,
                alias,
                origin: plugin.origin,
                target,
            });
        }
        for (const choice of plugin.providerAuthChoices ?? []) {
            for (const deprecatedChoiceId of choice.deprecatedChoiceIds ?? []) {
                setPreferredAlias({
                    aliases: preferredAliases,
                    alias: deprecatedChoiceId,
                    origin: plugin.origin,
                    target: choice.provider,
                });
            }
        }
    }
    for (const [alias, candidate] of preferredAliases) {
        aliases[alias] = candidate.target;
    }
    return aliases;
}
export function resolveProviderIdForAuth(provider, params) {
    const normalized = normalizeProviderId(provider);
    if (!normalized) {
        return normalized;
    }
    return resolveProviderAuthAliasMap(params)[normalized] ?? normalized;
}
