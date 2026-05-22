import { t as resolveGatewayProbeTarget } from "./probe-target-R3TIHZU9.js";
import { r as resolveGatewayProbeAuthSafeWithSecretInputs } from "./probe-auth-CKuGEKTn.js";
import { t as pickGatewaySelfPresence } from "./gateway-presence-CfpT0jUk.js";
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
