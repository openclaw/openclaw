import { d as resolvePluginRegistryLoadCacheKey, l as loadOpenClawPlugins } from "./loader-DkTFEskE.js";
import { d as pinActivePluginChannelRegistry, f as pinActivePluginHttpRouteRegistry, x as setActivePluginRegistry } from "./runtime-CFKT2mp_.js";
import { n as getLoadedRuntimePluginRegistry } from "./active-runtime-registry-CToOMaT0.js";
//#region src/plugins/runtime/standalone-runtime-registry-loader.ts
function resolveRuntimeSubagentMode(loadOptions) {
	if (loadOptions.runtimeOptions?.allowGatewaySubagentBinding === true) return "gateway-bindable";
	if (loadOptions.runtimeOptions?.subagent) return "explicit";
	return "default";
}
function installStandaloneRegistry(registry, params) {
	setActivePluginRegistry(registry, resolvePluginRegistryLoadCacheKey(params.loadOptions), resolveRuntimeSubagentMode(params.loadOptions), params.loadOptions.workspaceDir);
	switch (params.surface) {
		case "active": break;
		case "channel":
			pinActivePluginChannelRegistry(registry);
			break;
		case "http-route":
			pinActivePluginHttpRouteRegistry(registry);
			break;
	}
}
function ensureStandaloneRuntimePluginRegistryLoaded(params) {
	const requiredPluginIds = params.requiredPluginIds ?? params.loadOptions.onlyPluginIds;
	const surface = params.surface ?? "active";
	if (!params.forceLoad) {
		const existing = getLoadedRuntimePluginRegistry({
			env: params.loadOptions.env,
			loadOptions: params.loadOptions,
			workspaceDir: params.loadOptions.workspaceDir,
			requiredPluginIds,
			surface
		});
		if (existing) return existing;
	}
	const registry = loadOpenClawPlugins(params.forceLoad ? {
		...params.loadOptions,
		cache: false
	} : params.loadOptions);
	if (params.loadOptions.activate !== false) {
		switch (surface) {
			case "active": break;
			case "channel":
				pinActivePluginChannelRegistry(registry);
				break;
			case "http-route":
				pinActivePluginHttpRouteRegistry(registry);
				break;
		}
		return registry;
	}
	if (params.installRegistry === false) return registry;
	installStandaloneRegistry(registry, {
		loadOptions: params.loadOptions,
		surface
	});
	return registry;
}
//#endregion
export { ensureStandaloneRuntimePluginRegistryLoaded as t };
