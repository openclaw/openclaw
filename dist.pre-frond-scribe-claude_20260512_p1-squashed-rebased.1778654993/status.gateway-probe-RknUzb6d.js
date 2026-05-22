import { t as resolveGatewayProbeTarget } from "./probe-target-D0570jH9.js";
import { r as resolveGatewayProbeAuthSafeWithSecretInputs } from "./probe-auth-DyyflBKj.js";
import { t as pickGatewaySelfPresence } from "./gateway-presence-BjAGjfJJ.js";
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
