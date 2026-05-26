import { t as resolveGatewayProbeTarget } from "./probe-target-R8cyGd5i.js";
import { r as resolveGatewayProbeAuthSafeWithSecretInputs } from "./probe-auth-CbTbVDTG.js";
import { t as pickGatewaySelfPresence } from "./gateway-presence-Lk3E-_J0.js";
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
