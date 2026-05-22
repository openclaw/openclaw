import { d as pickPrimaryLanIPv4, p as resolveGatewayBindHost } from "./net-DCUMtgJy.js";
import { n as pickPrimaryTailnetIPv4 } from "./tailnet-D6Ui4WCo.js";
//#region src/infra/network-discovery-display.ts
function summarizeDisplayNetworkError(error) {
	if (error instanceof Error) {
		const message = error.message.trim();
		if (message) return message;
	}
	return "network interface discovery failed";
}
function fallbackBindHostForDisplay(bindMode, customBindHost) {
	if (bindMode === "lan") return "0.0.0.0";
	if (bindMode === "custom") return customBindHost?.trim() || "0.0.0.0";
	return "127.0.0.1";
}
function pickBestEffortPrimaryLanIPv4() {
	try {
		return pickPrimaryLanIPv4();
	} catch {
		return;
	}
}
function inspectBestEffortPrimaryTailnetIPv4(params) {
	try {
		return { tailnetIPv4: pickPrimaryTailnetIPv4() };
	} catch (error) {
		const prefix = params?.warningPrefix?.trim();
		const warning = prefix ? `${prefix}: ${summarizeDisplayNetworkError(error)}.` : void 0;
		return {
			tailnetIPv4: void 0,
			...warning ? { warning } : {}
		};
	}
}
async function resolveBestEffortGatewayBindHostForDisplay(params) {
	try {
		return { bindHost: await resolveGatewayBindHost(params.bindMode, params.customBindHost) };
	} catch (error) {
		const prefix = params.warningPrefix?.trim();
		const warning = prefix ? `${prefix}: ${summarizeDisplayNetworkError(error)}.` : void 0;
		return {
			bindHost: fallbackBindHostForDisplay(params.bindMode, params.customBindHost),
			...warning ? { warning } : {}
		};
	}
}
//#endregion
export { pickBestEffortPrimaryLanIPv4 as n, resolveBestEffortGatewayBindHostForDisplay as r, inspectBestEffortPrimaryTailnetIPv4 as t };
