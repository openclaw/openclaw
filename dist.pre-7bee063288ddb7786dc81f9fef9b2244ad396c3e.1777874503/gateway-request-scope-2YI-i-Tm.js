import { n as resolveGlobalSingleton } from "./global-singleton-COlWgaGc.js";
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
function withPluginRuntimePluginIdScope(pluginId, run) {
	const current = pluginRuntimeGatewayRequestScope.getStore();
	const scoped = current ? {
		...current,
		pluginId
	} : {
		pluginId,
		isWebchatConnect: () => false
	};
	return pluginRuntimeGatewayRequestScope.run(scoped, run);
}
/**
* Returns the current plugin gateway request scope when called from a plugin request handler.
*/
function getPluginRuntimeGatewayRequestScope() {
	return pluginRuntimeGatewayRequestScope.getStore();
}
//#endregion
export { withPluginRuntimeGatewayRequestScope as n, withPluginRuntimePluginIdScope as r, getPluginRuntimeGatewayRequestScope as t };
