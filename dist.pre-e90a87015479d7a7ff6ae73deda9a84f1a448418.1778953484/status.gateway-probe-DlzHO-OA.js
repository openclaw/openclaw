import { t as resolveGatewayProbeTarget } from "./probe-target-Bhs8lJUI.js";
import { r as resolveGatewayProbeAuthSafeWithSecretInputs } from "./probe-auth-CCPd9LcM.js";
import { t as pickGatewaySelfPresence } from "./gateway-presence-Db_9Fco_.js";
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
