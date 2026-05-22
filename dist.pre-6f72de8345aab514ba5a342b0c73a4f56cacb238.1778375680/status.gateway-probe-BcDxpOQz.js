import { t as resolveGatewayProbeTarget } from "./probe-target-Gb6GJ8N2.js";
import { r as resolveGatewayProbeAuthSafeWithSecretInputs } from "./probe-auth-_fU8gZsB.js";
import { t as pickGatewaySelfPresence } from "./gateway-presence-BCi1kTFT.js";
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
