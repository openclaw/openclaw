import { t as resolveGatewayProbeTarget } from "./probe-target-hV5EHzzu.js";
import { r as resolveGatewayProbeAuthSafeWithSecretInputs } from "./probe-auth-A8SIsj0z.js";
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
