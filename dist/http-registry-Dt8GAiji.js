import { _ as requireActivePluginHttpRouteRegistry } from "./runtime-DHxRl5F1.js";
import { n as normalizePluginHttpPath, t as findOverlappingPluginHttpRoute } from "./http-route-overlap-BShPdT8Q.js";
import { AsyncLocalStorage } from "node:async_hooks";
//#region src/plugins/http-registry.ts
const pluginHttpRouteRegistryScope = new AsyncLocalStorage();
function withPluginHttpRouteRegistry(registry, run) {
	return pluginHttpRouteRegistryScope.run(registry, run);
}
function registerPluginHttpRoute(params) {
	const registry = params.registry ?? pluginHttpRouteRegistryScope.getStore() ?? requireActivePluginHttpRouteRegistry();
	const routes = registry.httpRoutes ?? [];
	registry.httpRoutes = routes;
	const normalizedPath = normalizePluginHttpPath(params.path, params.fallbackPath);
	const suffix = params.accountId ? ` for account "${params.accountId}"` : "";
	if (!normalizedPath) {
		params.log?.(`plugin: webhook path missing${suffix}`);
		return () => {};
	}
	const routeMatch = params.match ?? "exact";
	const overlappingRoute = findOverlappingPluginHttpRoute(routes, {
		path: normalizedPath,
		match: routeMatch
	});
	if (overlappingRoute && overlappingRoute.auth !== params.auth) {
		params.log?.(`plugin: route overlap denied at ${normalizedPath} (${routeMatch}, ${params.auth})${suffix}; overlaps ${overlappingRoute.path} (${overlappingRoute.match}, ${overlappingRoute.auth}) owned by ${overlappingRoute.pluginId ?? "unknown-plugin"} (${overlappingRoute.source ?? "unknown-source"})`);
		return () => {};
	}
	const existingIndex = routes.findIndex((entry) => entry.path === normalizedPath && entry.match === routeMatch);
	if (existingIndex >= 0) {
		const existing = routes[existingIndex];
		if (!existing) return () => {};
		if (!params.replaceExisting) {
			params.log?.(`plugin: route conflict at ${normalizedPath} (${routeMatch})${suffix}; owned by ${existing.pluginId ?? "unknown-plugin"} (${existing.source ?? "unknown-source"})`);
			return () => {};
		}
		if (existing.pluginId && params.pluginId && existing.pluginId !== params.pluginId) {
			params.log?.(`plugin: route replacement denied for ${normalizedPath} (${routeMatch})${suffix}; owned by ${existing.pluginId}`);
			return () => {};
		}
		const pluginHint = params.pluginId ? ` (${params.pluginId})` : "";
		params.log?.(`plugin: replacing stale webhook path ${normalizedPath} (${routeMatch})${suffix}${pluginHint}`);
		routes.splice(existingIndex, 1);
	}
	const entry = {
		path: normalizedPath,
		handler: params.handler,
		auth: params.auth,
		match: routeMatch,
		...params.gatewayRuntimeScopeSurface ? { gatewayRuntimeScopeSurface: params.gatewayRuntimeScopeSurface } : {},
		pluginId: params.pluginId,
		source: params.source
	};
	routes.push(entry);
	return () => {
		const index = routes.indexOf(entry);
		if (index >= 0) routes.splice(index, 1);
	};
}
//#endregion
export { withPluginHttpRouteRegistry as n, registerPluginHttpRoute as t };
