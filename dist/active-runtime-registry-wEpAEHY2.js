import { l as resolveCompatibleRuntimePluginRegistry } from "./loader-DKK7Ita0.js";
import { a as getActivePluginRegistry, c as getActivePluginRegistryWorkspaceDir, r as getActivePluginHttpRouteRegistry, t as getActivePluginChannelRegistry } from "./runtime-DHxRl5F1.js";
//#region src/plugins/active-runtime-registry.ts
function getActiveRuntimePluginRegistry() {
	return getActivePluginRegistry();
}
function normalizeRequiredPluginIds(ids) {
	if (ids === void 0) return;
	return [...new Set(ids.map((id) => id.trim()).filter(Boolean))].toSorted((left, right) => left.localeCompare(right));
}
function registryContainsPluginIds(registry, pluginIds) {
	if (pluginIds === void 0) return true;
	const loaded = /* @__PURE__ */ new Set();
	for (const plugin of registry.plugins ?? []) if (plugin.status === void 0 || plugin.status === "loaded") loaded.add(plugin.id);
	for (const value of Object.values(registry)) {
		if (!Array.isArray(value)) continue;
		for (const entry of value) if (entry && typeof entry === "object" && "pluginId" in entry) {
			const pluginId = entry.pluginId;
			if (typeof pluginId === "string" && pluginId.length > 0) loaded.add(pluginId);
		}
	}
	if (pluginIds.length === 0) return loaded.size === 0;
	return pluginIds.every((pluginId) => loaded.has(pluginId));
}
function resolveSurfaceRegistry(surface) {
	switch (surface) {
		case "active": return getActivePluginRegistry();
		case "channel": return getActivePluginChannelRegistry();
		case "http-route": return getActivePluginHttpRouteRegistry();
	}
	return null;
}
function getLoadedRuntimePluginRegistry(params = {}) {
	const surface = params.surface ?? "active";
	const requiredPluginIds = normalizeRequiredPluginIds(params.requiredPluginIds ?? params.loadOptions?.onlyPluginIds);
	if (surface === "active" && params.loadOptions && requiredPluginIds?.length !== 0) {
		const compatible = resolveCompatibleRuntimePluginRegistry(params.loadOptions);
		if (!compatible || !registryContainsPluginIds(compatible, requiredPluginIds)) return;
		return compatible;
	}
	const activeWorkspaceDir = getActivePluginRegistryWorkspaceDir();
	const requestedWorkspaceDir = params.workspaceDir ?? params.loadOptions?.workspaceDir;
	if (requestedWorkspaceDir !== void 0 && activeWorkspaceDir !== requestedWorkspaceDir) return;
	const registry = resolveSurfaceRegistry(surface);
	if (!registry) return;
	if (!registryContainsPluginIds(registry, requiredPluginIds)) return;
	return registry;
}
//#endregion
export { getLoadedRuntimePluginRegistry as n, getActiveRuntimePluginRegistry as t };
