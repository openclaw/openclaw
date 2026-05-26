import { t as getPluginRuntimeGatewayRequestScope } from "./gateway-request-scope-B9qYB9tg.js";
import { i as dispatchGatewayMethodInProcessRaw } from "./server-plugins-Dzx4kGwz.js";
//#region src/plugin-sdk/gateway-method-runtime.ts
/**
* Dispatch a Gateway control-plane method from an authenticated plugin request scope.
*/
async function dispatchGatewayMethod(method, params, options) {
	const scope = getPluginRuntimeGatewayRequestScope();
	if (scope?.gatewayMethodDispatchAllowed !== true) {
		const pluginLabel = scope?.pluginId ? ` for plugin "${scope.pluginId}"` : "";
		throw new Error(`Gateway method dispatch is reserved for plugin HTTP routes that declare contracts.gatewayMethodDispatch: ["authenticated-request"]${pluginLabel}.`);
	}
	return await dispatchGatewayMethodInProcessRaw(method, params, {
		disableSyntheticClient: true,
		requireScopedClient: true,
		...options?.expectFinal !== void 0 ? { expectFinal: options.expectFinal } : {},
		...options?.timeoutMs !== void 0 ? { timeoutMs: options.timeoutMs } : {}
	});
}
//#endregion
export { dispatchGatewayMethod as t };
