import { d as resolvePluginRegistryLoadCacheKey, l as loadOpenClawPlugins } from "./loader-BPHnZ58g.js";
import { d as pinActivePluginChannelRegistry, f as pinActivePluginHttpRouteRegistry, x as setActivePluginRegistry } from "./runtime-BB5JwDDz.js";
import { n as getLoadedRuntimePluginRegistry } from "./active-runtime-registry-E0P-GaIt.js";
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
	const existing = getLoadedRuntimePluginRegistry({
		env: params.loadOptions.env,
		loadOptions: params.loadOptions,
		workspaceDir: params.loadOptions.workspaceDir,
		requiredPluginIds,
		surface
	});
	if (existing) return existing;
	const registry = loadOpenClawPlugins(params.loadOptions);
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
	installStandaloneRegistry(registry, {
		loadOptions: params.loadOptions,
		surface
	});
	return registry;
}
//#endregion
export { ensureStandaloneRuntimePluginRegistryLoaded as t };
