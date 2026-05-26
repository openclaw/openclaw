import { l as resolvePluginNodeCapabilityTtlMs } from "./plugin-node-capability-C7GppvZZ.js";
import { t as findMatchingPluginHttpRoutes } from "./route-match-h17yQGxB.js";
//#region src/gateway/server/plugins-http/route-capability.ts
function hasNodeCapabilityRoute(route) {
	return Boolean(route.nodeCapability?.surface?.trim());
}
function resolvePluginNodeCapabilityRouteSurface(route) {
	const surface = route.nodeCapability.surface.trim();
	const owner = route.pluginId?.trim() || route.source?.trim();
	return {
		...route.nodeCapability,
		surface,
		...owner ? { scopeKey: `${owner}:${surface}` } : {}
	};
}
function findMatchingPluginNodeCapabilityRoutes(registry, context) {
	return findMatchingPluginHttpRoutes(registry, context).filter(hasNodeCapabilityRoute).map((route) => Object.assign({}, route, { nodeCapability: resolvePluginNodeCapabilityRouteSurface(route) }));
}
function findMatchingPluginNodeCapabilityRoute(registry, context) {
	return findMatchingPluginNodeCapabilityRoutes(registry, context)[0];
}
function listPluginNodeCapabilities(registry) {
	const surfaces = /* @__PURE__ */ new Map();
	for (const route of registry.httpRoutes ?? []) {
		const surface = route.nodeCapability?.surface?.trim();
		if (surface) {
			const next = resolvePluginNodeCapabilityRouteSurface(route);
			const existing = surfaces.get(surface);
			if (!existing || resolveTtlMs(next) < resolveTtlMs(existing)) surfaces.set(surface, next);
		}
	}
	return [...surfaces.values()].toSorted((a, b) => a.surface.localeCompare(b.surface));
}
function resolveTtlMs(surface) {
	return resolvePluginNodeCapabilityTtlMs(surface);
}
//#endregion
export { findMatchingPluginNodeCapabilityRoutes as n, listPluginNodeCapabilities as r, findMatchingPluginNodeCapabilityRoute as t };
