import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
//#region src/gateway/probe-target.ts
function resolveGatewayProbeTarget(cfg) {
	const gatewayMode = cfg.gateway?.mode === "remote" ? "remote" : "local";
	const remoteUrlRaw = normalizeOptionalString(cfg.gateway?.remote?.url) ?? "";
	const remoteUrlMissing = gatewayMode === "remote" && !remoteUrlRaw;
	return {
		gatewayMode,
		mode: gatewayMode === "remote" && !remoteUrlMissing ? "remote" : "local",
		remoteUrlMissing
	};
}
//#endregion
export { resolveGatewayProbeTarget as t };
