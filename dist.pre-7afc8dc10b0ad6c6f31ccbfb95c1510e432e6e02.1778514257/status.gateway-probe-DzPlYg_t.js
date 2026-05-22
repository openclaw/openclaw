import { t as resolveGatewayProbeTarget } from "./probe-target-etJebjUV.js";
import { r as resolveGatewayProbeAuthSafeWithSecretInputs } from "./probe-auth-C8Wee7Ds.js";
import { t as pickGatewaySelfPresence } from "./gateway-presence-CG4eJVHL.js";
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
