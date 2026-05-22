import { t as resolveGatewayProbeTarget } from "./probe-target-CsD9I1Ok.js";
import { r as resolveGatewayProbeAuthSafeWithSecretInputs } from "./probe-auth-D2JyojWv.js";
import { t as pickGatewaySelfPresence } from "./gateway-presence-CzmBi8rd.js";
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
