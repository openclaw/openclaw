import { n as GATEWAY_CLIENT_IDS, r as GATEWAY_CLIENT_MODES } from "./client-info-CgOISqZp.js";
import "./protocol-QC2mQFMN.js";
import "./version-CICmFtNN.js";
import { b as resolveActivePluginHttpRouteRegistry } from "./runtime-CFKT2mp_.js";
import { n as withPluginRuntimeGatewayRequestScope } from "./gateway-request-scope-v3GshBD5.js";
import { r as resolvePluginRoutePathContext, t as findMatchingPluginHttpRoutes } from "./route-match-BgKnQWSR.js";
import { t as matchedPluginRoutesRequireGatewayAuth } from "./route-auth-CUHH1xfl.js";
import { t as resolvePluginRouteRuntimeOperatorScopes } from "./plugin-route-runtime-scopes-DGgc1X-K.js";
//#region src/gateway/server/plugins-http.ts
function createPluginRouteRuntimeClient(scopes) {
	return { connect: {
		minProtocol: 4,
		maxProtocol: 4,
		client: {
			id: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
			version: "internal",
			platform: "node",
			mode: GATEWAY_CLIENT_MODES.BACKEND
		},
		role: "operator",
		scopes: [...scopes]
	} };
}
function writeUpgradeUnauthorized(socket) {
	socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
	socket.destroy();
}
function createGatewayPluginRequestHandler(params) {
	const { log } = params;
	return async (req, res, providedPathContext, dispatchContext) => {
		const registry = resolveActivePluginHttpRouteRegistry(params.registry);
		if ((registry.httpRoutes ?? []).length === 0) return false;
		const pathContext = providedPathContext ?? resolvePluginRoutePathContext(new URL(req.url ?? "/", "http://localhost").pathname);
		const matchedRoutes = findMatchingPluginHttpRoutes(registry, pathContext);
		if (matchedRoutes.length === 0) return false;
		if (matchedPluginRoutesRequireGatewayAuth(matchedRoutes) && dispatchContext?.gatewayAuthSatisfied !== true) {
			log.warn(`plugin http route blocked without gateway auth (${pathContext.canonicalPath})`);
			return false;
		}
		const gatewayRequestAuth = dispatchContext?.gatewayRequestAuth;
		const gatewayRequestOperatorScopes = dispatchContext?.gatewayRequestOperatorScopes;
		for (const route of matchedRoutes) {
			if (route.auth !== "gateway") continue;
			if (route.gatewayRuntimeScopeSurface === "trusted-operator") {
				if (!gatewayRequestAuth) {
					log.warn(`plugin http route blocked without caller auth context (${pathContext.canonicalPath})`);
					return false;
				}
				continue;
			}
			if (gatewayRequestOperatorScopes === void 0) {
				log.warn(`plugin http route blocked without caller scope context (${pathContext.canonicalPath})`);
				return false;
			}
		}
		for (const route of matchedRoutes) {
			let runtimeScopes = [];
			if (route.auth === "gateway") if (route.gatewayRuntimeScopeSurface === "trusted-operator") runtimeScopes = resolvePluginRouteRuntimeOperatorScopes(req, gatewayRequestAuth, "trusted-operator");
			else runtimeScopes = gatewayRequestOperatorScopes;
			const runtimeClient = createPluginRouteRuntimeClient(runtimeScopes);
			try {
				if (await withPluginRuntimeGatewayRequestScope({
					client: runtimeClient,
					isWebchatConnect: () => false
				}, async () => route.handler(req, res)) !== false) return true;
			} catch (err) {
				log.warn(`plugin http route failed (${route.pluginId ?? "unknown"}): ${String(err)}`);
				if (!res.headersSent) {
					res.statusCode = 500;
					res.setHeader("Content-Type", "text/plain; charset=utf-8");
					res.end("Internal Server Error");
				}
				return true;
			}
		}
		return false;
	};
}
function createGatewayPluginUpgradeHandler(params) {
	const { log } = params;
	return async (req, socket, head, providedPathContext, dispatchContext) => {
		const registry = resolveActivePluginHttpRouteRegistry(params.registry);
		if ((registry.httpRoutes ?? []).length === 0) return false;
		const pathContext = providedPathContext ?? resolvePluginRoutePathContext(new URL(req.url ?? "/", "http://localhost").pathname);
		const matchedRoutes = findMatchingPluginHttpRoutes(registry, pathContext).filter((route) => typeof route.handleUpgrade === "function");
		if (matchedRoutes.length === 0) return false;
		if (matchedPluginRoutesRequireGatewayAuth(matchedRoutes) && dispatchContext?.gatewayAuthSatisfied !== true) {
			log.warn(`plugin http upgrade blocked without gateway auth (${pathContext.canonicalPath})`);
			writeUpgradeUnauthorized(socket);
			return true;
		}
		const gatewayRequestAuth = dispatchContext?.gatewayRequestAuth;
		const gatewayRequestOperatorScopes = dispatchContext?.gatewayRequestOperatorScopes;
		for (const route of matchedRoutes) {
			if (route.auth !== "gateway") continue;
			if (route.gatewayRuntimeScopeSurface === "trusted-operator") {
				if (!gatewayRequestAuth) {
					log.warn(`plugin http upgrade blocked without caller auth context (${pathContext.canonicalPath})`);
					writeUpgradeUnauthorized(socket);
					return true;
				}
				continue;
			}
			if (gatewayRequestOperatorScopes === void 0) {
				log.warn(`plugin http upgrade blocked without caller scope context (${pathContext.canonicalPath})`);
				writeUpgradeUnauthorized(socket);
				return true;
			}
		}
		for (const route of matchedRoutes) {
			let runtimeScopes = [];
			if (route.auth === "gateway") if (route.gatewayRuntimeScopeSurface === "trusted-operator") runtimeScopes = resolvePluginRouteRuntimeOperatorScopes(req, gatewayRequestAuth, "trusted-operator");
			else runtimeScopes = gatewayRequestOperatorScopes;
			const runtimeClient = createPluginRouteRuntimeClient(runtimeScopes);
			try {
				if (await withPluginRuntimeGatewayRequestScope({
					client: runtimeClient,
					isWebchatConnect: () => false
				}, async () => route.handleUpgrade?.(req, socket, head)) !== false) return true;
			} catch (err) {
				log.warn(`plugin http upgrade failed (${route.pluginId ?? "unknown"}): ${String(err)}`);
				socket.destroy();
				return true;
			}
		}
		return false;
	};
}
//#endregion
export { createGatewayPluginRequestHandler, createGatewayPluginUpgradeHandler };
