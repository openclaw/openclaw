import { t as pickGatewaySelfPresence } from "./gateway-presence-DWGF-559.js";
import { t as resolveGatewayProbeTarget } from "./probe-target-C6jrKzo8.js";
import { r as resolveGatewayProbeAuthSafeWithSecretInputs } from "./probe-auth-C2ZDSDlW.js";
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
