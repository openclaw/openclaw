import { i as normalizePluginIdScope, n as hasExplicitPluginIdScope, r as hasNonEmptyPluginIdScope } from "./plugin-scope-6HF2N6kz.js";
import { r as withActivatedPluginIds } from "./activation-context-VOwqwTGf.js";
import { c as loadOpenClawPlugins } from "./loader-DKK7Ita0.js";
import { a as getActivePluginRegistry } from "./runtime-DHxRl5F1.js";
import { n as getLoadedRuntimePluginRegistry } from "./active-runtime-registry-wEpAEHY2.js";
import { i as resolvePluginRuntimeLoadContext, n as buildPluginRuntimeLoadOptionsFromValues } from "./load-context-BO-9CJts.js";
import { g as resolveDiscoverableScopedChannelPluginIds, m as resolveConfiguredChannelPluginIds, n as resolveChannelPluginIds } from "./channel-plugin-ids-nB-ga3MN.js";
import { t as resolveEffectivePluginIds } from "./effective-plugin-ids-DbaE4A9N.js";
//#region src/plugins/runtime/runtime-registry-loader.ts
let pluginRegistryLoaded = "none";
function scopeRank(scope) {
	switch (scope) {
		case "none": return 0;
		case "configured-channels": return 1;
		case "channels": return 2;
		case "all": return 3;
	}
	throw new Error("Unsupported plugin registry scope");
}
function activeRegistrySatisfiesScope(scope, active, expectedChannelPluginIds, requestedPluginIds) {
	if (!active) return false;
	if (requestedPluginIds !== void 0) {
		if (requestedPluginIds.length === 0) return false;
		const activePluginIds = new Set(active.plugins.filter((plugin) => plugin.status === "loaded").map((plugin) => plugin.id));
		return requestedPluginIds.every((pluginId) => activePluginIds.has(pluginId));
	}
	const activeChannelPluginIds = new Set(active.channels.map((entry) => entry.plugin.id));
	switch (scope) {
		case "configured-channels":
		case "channels": return active.channels.length > 0 && expectedChannelPluginIds.every((pluginId) => activeChannelPluginIds.has(pluginId));
		case "all": return false;
	}
	throw new Error("Unsupported plugin registry scope");
}
function shouldForwardChannelScope(params) {
	return !params.scopedLoad && params.scope === "configured-channels";
}
function resolveScopePluginIds(params) {
	switch (params.scope) {
		case "configured-channels": return resolveConfiguredChannelPluginIds({
			config: params.context.config,
			activationSourceConfig: params.context.activationSourceConfig,
			workspaceDir: params.context.workspaceDir,
			env: params.context.env
		});
		case "channels": return resolveChannelPluginIds({
			config: params.context.config,
			workspaceDir: params.context.workspaceDir,
			env: params.context.env
		});
		case "all": return resolveEffectivePluginIds({
			config: params.context.rawConfig,
			workspaceDir: params.context.workspaceDir,
			env: params.context.env
		});
	}
	return params.scope;
}
function resolveOrLoadRuntimePluginRegistry(loadOptions) {
	if (!getLoadedRuntimePluginRegistry({
		env: loadOptions.env,
		loadOptions,
		workspaceDir: loadOptions.workspaceDir,
		requiredPluginIds: loadOptions.onlyPluginIds
	})) loadOpenClawPlugins(loadOptions);
}
function ensurePluginRegistryLoaded(options) {
	const scope = options?.scope ?? "all";
	const requestedPluginIdsFromOptions = normalizePluginIdScope(options?.onlyPluginIds);
	const requestedChannelIds = normalizePluginIdScope(options?.onlyChannelIds);
	const context = resolvePluginRuntimeLoadContext(options);
	const requestedChannelOwnerPluginIds = requestedChannelIds === void 0 ? void 0 : resolveDiscoverableScopedChannelPluginIds({
		config: context.config,
		activationSourceConfig: context.activationSourceConfig,
		channelIds: requestedChannelIds,
		workspaceDir: context.workspaceDir,
		env: context.env
	});
	const requestedPluginIds = requestedChannelOwnerPluginIds === void 0 ? requestedPluginIdsFromOptions : normalizePluginIdScope([...requestedPluginIdsFromOptions ?? [], ...requestedChannelOwnerPluginIds]);
	const scopedLoad = hasExplicitPluginIdScope(requestedPluginIds);
	const expectedPluginIds = scopedLoad ? requestedPluginIds ?? [] : resolveScopePluginIds({
		scope,
		context
	});
	const active = getActivePluginRegistry();
	const requestedPluginIdsForScope = scope === "all" ? expectedPluginIds : void 0;
	if (!scopedLoad && scopeRank(pluginRegistryLoaded) >= scopeRank(scope) && activeRegistrySatisfiesScope(scope, active, expectedPluginIds, requestedPluginIdsForScope)) return;
	if ((pluginRegistryLoaded === "none" || scopedLoad) && activeRegistrySatisfiesScope(scope, active, expectedPluginIds, requestedPluginIds)) {
		if (!scopedLoad) pluginRegistryLoaded = scope;
		return;
	}
	const scopedConfig = scope === "configured-channels" && expectedPluginIds.length > 0 && (!scopedLoad || requestedChannelOwnerPluginIds !== void 0) ? withActivatedPluginIds({
		config: context.config,
		pluginIds: expectedPluginIds
	}) ?? context.config : context.config;
	const scopedActivationSourceConfig = scope === "configured-channels" && expectedPluginIds.length > 0 && (!scopedLoad || requestedChannelOwnerPluginIds !== void 0) ? withActivatedPluginIds({
		config: context.activationSourceConfig,
		pluginIds: expectedPluginIds
	}) ?? context.activationSourceConfig : context.activationSourceConfig;
	resolveOrLoadRuntimePluginRegistry(buildPluginRuntimeLoadOptionsFromValues({
		...context,
		config: scopedConfig,
		activationSourceConfig: scopedActivationSourceConfig
	}, {
		throwOnLoadError: true,
		...hasExplicitPluginIdScope(requestedPluginIds) || shouldForwardChannelScope({
			scope,
			scopedLoad
		}) || hasNonEmptyPluginIdScope(expectedPluginIds) || scope === "all" ? { onlyPluginIds: expectedPluginIds } : {}
	}));
	if (!scopedLoad) pluginRegistryLoaded = scope;
}
const testing = { resetPluginRegistryLoadedForTests() {
	pluginRegistryLoaded = "none";
} };
//#endregion
export { testing as n, ensurePluginRegistryLoaded as t };
