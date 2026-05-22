import { t as resolveGatewayProbeTarget } from "./probe-target-Df1NkUKj.js";
import { r as resolveGatewayProbeAuthSafeWithSecretInputs } from "./probe-auth-CmiPvcTa.js";
import { t as pickGatewaySelfPresence } from "./gateway-presence-C5CxkKqQ.js";
//#region src/commands/status.gateway-probe.ts
async function resolveGatewayProbeAuthResolution(cfg) {
	return resolveGatewayProbeAuthSafeWithSecretInputs({
		cfg,
		mode: resolveGatewayProbeTarget(cfg).mode,
		env: process.env
	});
}
async function resolveGatewayProbeAuth(cfg) {
	return (await resolveGatewayProbeAuthResolution(cfg)).auth;
}
//#endregion
export { pickGatewaySelfPresence, resolveGatewayProbeAuth, resolveGatewayProbeAuthResolution };
