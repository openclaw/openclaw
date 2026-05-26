import { t as resolveGatewayProbeTarget } from "./probe-target-DQ4RDGo0.js";
import { r as resolveGatewayProbeAuthSafeWithSecretInputs } from "./probe-auth-DkpxNu5n.js";
import { t as pickGatewaySelfPresence } from "./gateway-presence-MS1CXjJj.js";
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
