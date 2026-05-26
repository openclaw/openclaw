import { s as normalizeOptionalLowercaseString } from "./string-coerce-LndEvhRk.js";
import { r as normalizeProviderId } from "./provider-id-Cz7K6wgK.js";
import { a as resolvePluginControlPlaneFingerprint, r as loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot-DlaHO4z7.js";
import { s as normalizePluginsConfig } from "./config-state-BgyjpLHd.js";
import { n as getCurrentPluginMetadataSnapshot } from "./current-plugin-metadata-snapshot-DHmOxzz2.js";
//#region src/plugins/plugin-config-trust.ts
function normalizePluginConfigId(id) {
	return normalizeOptionalLowercaseString(id) ?? "";
}
function hasPluginConfigId(list, pluginId) {
	return Array.isArray(list) && list.some((entry) => normalizePluginConfigId(entry) === pluginId);
}
function findPluginConfigEntry(entries, pluginId) {
	if (!entries || typeof entries !== "object" || Array.isArray(entries)) return;
	for (const [key, value] of Object.entries(entries)) {
		if (normalizePluginConfigId(key) !== pluginId) continue;
		return value && typeof value === "object" && !Array.isArray(value) ? value : {};
	}
}
function isWorkspacePluginAllowedByConfig(params) {
	const pluginsConfig = params.config?.plugins;
	if (pluginsConfig?.enabled === false) return false;
	const pluginId = normalizePluginConfigId(params.plugin.id);
	if (!pluginId || hasPluginConfigId(pluginsConfig?.deny, pluginId)) return false;
	const entry = findPluginConfigEntry(pluginsConfig?.entries, pluginId);
	if (entry?.enabled === false) return false;
	if (entry?.enabled === true || hasPluginConfigId(pluginsConfig?.allow, pluginId)) return true;
	return params.isImplicitlyAllowed?.(pluginId) ?? false;
}
//#endregion
//#region src/agents/provider-auth-aliases.ts
const PROVIDER_AUTH_ALIAS_ORIGIN_PRIORITY = {
	config: 0,
	bundled: 1,
	global: 2,
	workspace: 3
};
let providerAuthAliasMapCache = /* @__PURE__ */ new WeakMap();
function buildProviderAuthAliasMapCacheKey(params, env) {
	return JSON.stringify({
		pluginControlPlane: resolvePluginControlPlaneFingerprint({
			config: params?.config,
			env,
			workspaceDir: params?.workspaceDir
		}),
		includeUntrustedWorkspacePlugins: params?.includeUntrustedWorkspacePlugins === true,
		plugins: params?.config?.plugins ?? null
	});
}
function resetProviderAuthAliasMapCacheForTest() {
	providerAuthAliasMapCache = /* @__PURE__ */ new WeakMap();
}
function resolveProviderAuthAliasOriginPriority(origin) {
	if (!origin) return Number.MAX_SAFE_INTEGER;
	return PROVIDER_AUTH_ALIAS_ORIGIN_PRIORITY[origin] ?? Number.MAX_SAFE_INTEGER;
}
function isWorkspacePluginTrustedForAuthAliases(plugin, config) {
	return isWorkspacePluginAllowedByConfig({
		config,
		isImplicitlyAllowed: (pluginId) => normalizePluginConfigId(config?.plugins?.slots?.contextEngine) === pluginId,
		plugin
	});
}
function shouldUsePluginAuthAliases(plugin, params) {
	if (plugin.origin !== "workspace" || params?.includeUntrustedWorkspacePlugins === true) return true;
	return isWorkspacePluginTrustedForAuthAliases(plugin, params?.config);
}
function setPreferredAlias(params) {
	const normalizedAlias = normalizeProviderId(params.alias);
	const normalizedTarget = normalizeProviderId(params.target);
	if (!normalizedAlias || !normalizedTarget) return;
	const existing = params.aliases.get(normalizedAlias);
	if (!existing || resolveProviderAuthAliasOriginPriority(params.origin) < resolveProviderAuthAliasOriginPriority(existing.origin)) params.aliases.set(normalizedAlias, {
		origin: params.origin,
		target: normalizedTarget
	});
}
function resolveProviderAuthAliasMap(params) {
	const env = params?.env ?? process.env;
	const cacheKey = buildProviderAuthAliasMapCacheKey(params, env);
	let envCache = providerAuthAliasMapCache.get(env);
	if (!envCache) {
		envCache = /* @__PURE__ */ new Map();
		providerAuthAliasMapCache.set(env, envCache);
	}
	const cached = envCache.get(cacheKey);
	if (cached) return cached;
	const config = params?.config ?? {};
	const snapshot = getCurrentPluginMetadataSnapshot({
		config,
		...params?.workspaceDir !== void 0 ? { workspaceDir: params.workspaceDir } : {},
		env,
		allowWorkspaceScopedSnapshot: true
	}) ?? (() => {
		if (normalizePluginsConfig(config.plugins).loadPaths.length !== 0) return;
		return getCurrentPluginMetadataSnapshot({
			...params?.workspaceDir !== void 0 ? { workspaceDir: params.workspaceDir } : {},
			env,
			allowWorkspaceScopedSnapshot: true,
			requireDefaultDiscoveryContext: true
		});
	})() ?? loadPluginMetadataSnapshot({
		config,
		...params?.workspaceDir !== void 0 ? { workspaceDir: params.workspaceDir } : {},
		env
	});
	const preferredAliases = /* @__PURE__ */ new Map();
	const aliases = Object.create(null);
	for (const plugin of snapshot.plugins) {
		if (!shouldUsePluginAuthAliases(plugin, params)) continue;
		for (const [alias, target] of Object.entries(plugin.providerAuthAliases ?? {}).toSorted(([left], [right]) => left.localeCompare(right))) setPreferredAlias({
			aliases: preferredAliases,
			alias,
			origin: plugin.origin,
			target
		});
		for (const choice of plugin.providerAuthChoices ?? []) for (const deprecatedChoiceId of choice.deprecatedChoiceIds ?? []) setPreferredAlias({
			aliases: preferredAliases,
			alias: deprecatedChoiceId,
			origin: plugin.origin,
			target: choice.provider
		});
	}
	for (const [alias, candidate] of preferredAliases) aliases[alias] = candidate.target;
	envCache.set(cacheKey, aliases);
	return aliases;
}
function resolveProviderIdForAuth(provider, params) {
	const normalized = normalizeProviderId(provider);
	if (!normalized) return normalized;
	return resolveProviderAuthAliasMap(params)[normalized] ?? normalized;
}
//#endregion
export { normalizePluginConfigId as a, isWorkspacePluginAllowedByConfig as i, resolveProviderAuthAliasMap as n, resolveProviderIdForAuth as r, resetProviderAuthAliasMapCacheForTest as t };
