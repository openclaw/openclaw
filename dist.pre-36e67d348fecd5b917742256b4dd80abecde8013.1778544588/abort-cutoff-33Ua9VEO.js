import { c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
//#region src/auto-reply/reply/abort-cutoff.ts
function resolveAbortCutoffFromContext(ctx) {
	const messageSid = normalizeOptionalString(ctx.MessageSidFull) ?? normalizeOptionalString(ctx.MessageSid);
	const timestamp = typeof ctx.Timestamp === "number" && Number.isFinite(ctx.Timestamp) ? ctx.Timestamp : void 0;
	if (!messageSid && timestamp === void 0) return;
	return {
		messageSid,
		timestamp
	};
}
function readAbortCutoffFromSessionEntry(entry) {
	if (!entry) return;
	const messageSid = normalizeOptionalString(entry.abortCutoffMessageSid);
	const timestamp = typeof entry.abortCutoffTimestamp === "number" && Number.isFinite(entry.abortCutoffTimestamp) ? entry.abortCutoffTimestamp : void 0;
	if (!messageSid && timestamp === void 0) return;
	return {
		messageSid,
		timestamp
	};
}
function hasAbortCutoff(entry) {
	return readAbortCutoffFromSessionEntry(entry) !== void 0;
}
function applyAbortCutoffToSessionEntry(entry, cutoff) {
	entry.abortCutoffMessageSid = cutoff?.messageSid;
	entry.abortCutoffTimestamp = cutoff?.timestamp;
}
function toNumericMessageSid(value) {
	const trimmed = normalizeOptionalString(value);
	if (!trimmed || !/^\d+$/.test(trimmed)) return;
	try {
		return BigInt(trimmed);
	} catch {
		return;
	}
}
function shouldSkipMessageByAbortCutoff(params) {
	const cutoffSid = normalizeOptionalString(params.cutoffMessageSid);
	const currentSid = normalizeOptionalString(params.messageSid);
	if (cutoffSid && currentSid) {
		const cutoffNumeric = toNumericMessageSid(cutoffSid);
		const currentNumeric = toNumericMessageSid(currentSid);
		if (cutoffNumeric !== void 0 && currentNumeric !== void 0) return currentNumeric <= cutoffNumeric;
		if (currentSid === cutoffSid) return true;
	}
	if (typeof params.cutoffTimestamp === "number" && Number.isFinite(params.cutoffTimestamp) && typeof params.timestamp === "number" && Number.isFinite(params.timestamp)) return params.timestamp <= params.cutoffTimestamp;
	return false;
}
function shouldPersistAbortCutoff(params) {
	const commandSessionKey = normalizeOptionalString(params.commandSessionKey);
	const targetSessionKey = normalizeOptionalString(params.targetSessionKey);
	if (!commandSessionKey || !targetSessionKey) return true;
	return commandSessionKey === targetSessionKey;
}
//#endregion
export { shouldPersistAbortCutoff as a, resolveAbortCutoffFromContext as i, hasAbortCutoff as n, shouldSkipMessageByAbortCutoff as o, readAbortCutoffFromSessionEntry as r, applyAbortCutoffToSessionEntry as t };
