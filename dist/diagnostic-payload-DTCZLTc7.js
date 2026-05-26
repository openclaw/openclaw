import { n as emitDiagnosticEvent } from "./diagnostic-events-BLgzARSp.js";
//#region src/logging/diagnostic-payload.ts
function logLargePayload(params) {
	emitDiagnosticEvent({
		type: "payload.large",
		...params
	});
}
function logRejectedLargePayload(params) {
	logLargePayload({
		action: "rejected",
		...params
	});
}
function parseContentLengthHeader(raw) {
	const value = Array.isArray(raw) ? raw[0] : raw;
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	if (trimmed.length === 0 || !/^\d+$/.test(trimmed)) return;
	const parsed = Number.parseInt(trimmed, 10);
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : void 0;
}
//#endregion
export { logRejectedLargePayload as n, parseContentLengthHeader as r, logLargePayload as t };
