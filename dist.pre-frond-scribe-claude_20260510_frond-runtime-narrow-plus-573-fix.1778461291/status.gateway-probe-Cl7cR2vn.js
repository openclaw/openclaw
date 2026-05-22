import { t as resolveGatewayProbeTarget } from "./probe-target-DRKRSn7_.js";
import { r as resolveGatewayProbeAuthSafeWithSecretInputs } from "./probe-auth-DpXPLo-7.js";
import { t as pickGatewaySelfPresence } from "./gateway-presence-BksiTxIL.js";
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
