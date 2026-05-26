import { n as resolveGlobalSingleton } from "./global-singleton-DE6St75u.js";
import { AsyncLocalStorage } from "node:async_hooks";
//#region src/plugins/runtime/gateway-request-scope.ts
const pluginRuntimeGatewayRequestScope = resolveGlobalSingleton(Symbol.for("openclaw.pluginRuntimeGatewayRequestScope"), () => new AsyncLocalStorage());
/**
* Runs plugin gateway handlers with request-scoped context that runtime helpers can read.
*/
function withPluginRuntimeGatewayRequestScope(scope, run) {
	return pluginRuntimeGatewayRequestScope.run(scope, run);
}
/**
* Runs work under the current gateway request scope while attaching plugin identity.
*/
function withPluginRuntimePluginScope(scope, run) {
	const current = pluginRuntimeGatewayRequestScope.getStore();
	const scoped = current ? {
		...current,
		pluginId: scope.pluginId
	} : {
		pluginId: scope.pluginId,
		isWebchatConnect: () => false
	};
	if (scope.pluginSource !== void 0) scoped.pluginSource = scope.pluginSource;
	else delete scoped.pluginSource;
	return pluginRuntimeGatewayRequestScope.run(scoped, run);
}
/**
* Runs work under the current gateway request scope while attaching plugin identity.
*/
function withPluginRuntimePluginIdScope(pluginId, run) {
	return withPluginRuntimePluginScope({ pluginId }, run);
}
/**
* Returns the current plugin gateway request scope when called from a plugin request handler.
*/
function getPluginRuntimeGatewayRequestScope() {
	return pluginRuntimeGatewayRequestScope.getStore();
}
//#endregion
export { withPluginRuntimePluginScope as i, withPluginRuntimeGatewayRequestScope as n, withPluginRuntimePluginIdScope as r, getPluginRuntimeGatewayRequestScope as t };
