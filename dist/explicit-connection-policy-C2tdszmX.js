import { a as trimToUndefined } from "./credential-planner-dZ8mfNpn.js";
import "./credentials-DSgFQfJz.js";
//#region src/gateway/explicit-connection-policy.ts
function hasExplicitGatewayConnectionAuth(auth) {
	return Boolean(trimToUndefined(auth?.token) || trimToUndefined(auth?.password));
}
function canSkipGatewayConfigLoad(params) {
	return !params.config && Boolean(trimToUndefined(params.urlOverride)) && hasExplicitGatewayConnectionAuth(params.explicitAuth);
}
function isGatewayConfigBypassCommandPath(commandPath) {
	return commandPath[0] === "cron";
}
//#endregion
export { isGatewayConfigBypassCommandPath as n, canSkipGatewayConfigLoad as t };
