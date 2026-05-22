import { t as resolveGatewayProbeTarget } from "./probe-target-D_CsTyro.js";
import { r as resolveGatewayProbeAuthSafeWithSecretInputs } from "./probe-auth-Co6Kyqnn.js";
import { t as pickGatewaySelfPresence } from "./gateway-presence-APQq0j3I.js";
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
