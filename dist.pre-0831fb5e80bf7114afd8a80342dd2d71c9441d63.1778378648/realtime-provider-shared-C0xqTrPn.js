import { c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import "./text-runtime-Dm9-PE_c.js";
import { n as captureWsEvent } from "./runtime-Brq_srVD.js";
import "./proxy-capture-Dlg4Q-Wq.js";
//#region extensions/openai/realtime-provider-shared.ts
const trimToUndefined = normalizeOptionalString;
function asFiniteNumber(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function asObjectRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function readRealtimeErrorDetail(error) {
	if (typeof error === "string" && error) return error;
	const message = asObjectRecord(error)?.message;
	if (typeof message === "string" && message) return message;
	return "Unknown error";
}
function resolveOpenAIProviderConfigRecord(config) {
	return asObjectRecord(asObjectRecord(config.providers)?.openai) ?? asObjectRecord(config.openai) ?? asObjectRecord(config);
}
function captureOpenAIRealtimeWsClose(params) {
	captureWsEvent({
		url: params.url,
		direction: "local",
		kind: "ws-close",
		flowId: params.flowId,
		closeCode: typeof params.code === "number" ? params.code : void 0,
		meta: {
			provider: "openai",
			capability: params.capability,
			reason: Buffer.isBuffer(params.reasonBuffer) && params.reasonBuffer.length > 0 ? params.reasonBuffer.toString("utf8") : void 0
		}
	});
}
//#endregion
export { resolveOpenAIProviderConfigRecord as a, readRealtimeErrorDetail as i, asObjectRecord as n, trimToUndefined as o, captureOpenAIRealtimeWsClose as r, asFiniteNumber as t };
