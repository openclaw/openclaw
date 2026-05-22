import { t as resolveGatewayProbeTarget } from "./probe-target-BSWSFWa-.js";
import { r as resolveGatewayProbeAuthSafeWithSecretInputs } from "./probe-auth-QqadhKY8.js";
import { t as pickGatewaySelfPresence } from "./gateway-presence-DRVXpmzO.js";
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
