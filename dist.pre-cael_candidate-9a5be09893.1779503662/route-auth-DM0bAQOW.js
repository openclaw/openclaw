import { n as isProtectedPluginRoutePathFromContext, r as resolvePluginRoutePathContext, t as findMatchingPluginHttpRoutes } from "./route-match-h17yQGxB.js";
//#region src/gateway/server/plugins-http/route-auth.ts
function matchedPluginRoutesRequireGatewayAuth(routes) {
	return routes.some((route) => route.auth === "gateway");
}
function shouldEnforceGatewayAuthForPluginPath(registry, pathnameOrContext) {
	const pathContext = typeof pathnameOrContext === "string" ? resolvePluginRoutePathContext(pathnameOrContext) : pathnameOrContext;
	if (pathContext.malformedEncoding || pathContext.decodePassLimitReached) return true;
	if (isProtectedPluginRoutePathFromContext(pathContext)) return true;
	return matchedPluginRoutesRequireGatewayAuth(findMatchingPluginHttpRoutes(registry, pathContext));
}
//#endregion
export { shouldEnforceGatewayAuthForPluginPath as n, matchedPluginRoutesRequireGatewayAuth as t };
