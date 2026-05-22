import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { n as canonicalizePathForSecurity, r as canonicalizePathVariant, t as PROTECTED_PLUGIN_ROUTE_PREFIXES } from "./security-path-BTBxdfG9.js";
//#region src/gateway/server/plugins-http/path-context.ts
function normalizeProtectedPrefix(prefix) {
	const collapsed = normalizeLowercaseStringOrEmpty(prefix).replace(/\/{2,}/g, "/");
	if (collapsed.length <= 1) return collapsed || "/";
	return collapsed.replace(/\/+$/, "");
}
function prefixMatchPath(pathname, prefix) {
	return pathname === prefix || pathname.startsWith(`${prefix}/`) || pathname.startsWith(`${prefix}%`);
}
const NORMALIZED_PROTECTED_PLUGIN_ROUTE_PREFIXES = PROTECTED_PLUGIN_ROUTE_PREFIXES.map(normalizeProtectedPrefix);
function isProtectedPluginRoutePathFromContext(context) {
	if (context.candidates.some((candidate) => NORMALIZED_PROTECTED_PLUGIN_ROUTE_PREFIXES.some((prefix) => prefixMatchPath(candidate, prefix)))) return true;
	if (!context.malformedEncoding) return false;
	return NORMALIZED_PROTECTED_PLUGIN_ROUTE_PREFIXES.some((prefix) => prefixMatchPath(context.rawNormalizedPath, prefix));
}
function resolvePluginRoutePathContext(pathname) {
	const canonical = canonicalizePathForSecurity(pathname);
	return {
		pathname,
		canonicalPath: canonical.canonicalPath,
		candidates: canonical.candidates,
		malformedEncoding: canonical.malformedEncoding,
		decodePassLimitReached: canonical.decodePassLimitReached,
		rawNormalizedPath: canonical.rawNormalizedPath
	};
}
//#endregion
//#region src/gateway/server/plugins-http/route-match.ts
function doesPluginRouteMatchPath(route, context) {
	const routeCanonicalPath = canonicalizePathVariant(route.path);
	if (route.match === "prefix") return context.candidates.some((candidate) => prefixMatchPath(candidate, routeCanonicalPath));
	return context.candidates.some((candidate) => candidate === routeCanonicalPath);
}
function findMatchingPluginHttpRoutes(registry, context) {
	const routes = registry.httpRoutes ?? [];
	if (routes.length === 0) return [];
	const exactMatches = [];
	const prefixMatches = [];
	for (const route of routes) {
		if (!doesPluginRouteMatchPath(route, context)) continue;
		if (route.match === "prefix") prefixMatches.push(route);
		else exactMatches.push(route);
	}
	exactMatches.sort((a, b) => b.path.length - a.path.length);
	prefixMatches.sort((a, b) => b.path.length - a.path.length);
	return [...exactMatches, ...prefixMatches];
}
//#endregion
export { isProtectedPluginRoutePathFromContext as n, resolvePluginRoutePathContext as r, findMatchingPluginHttpRoutes as t };
