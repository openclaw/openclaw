import { d as validateSessionId } from "./paths-Bg3PO6Gj.js";
//#region src/config/sessions/store-entry-shape.ts
function isRecord(value) {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
function isSafeSessionId(value) {
	if (typeof value !== "string") return false;
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > 255) return false;
	if (trimmed.includes("/") || trimmed.includes("\\") || trimmed === "." || trimmed === "..") return false;
	return /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/.test(trimmed);
}
function normalizeTranscriptSessionId(value) {
	try {
		return validateSessionId(value);
	} catch {
		return;
	}
}
function normalizeOptionalTimestamp(value) {
	if (value === void 0) return;
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}
function normalizePersistedSessionEntryShape(value) {
	if (!isRecord(value)) return;
	let next = value;
	const sessionFile = typeof value.sessionFile === "string" ? value.sessionFile.trim() : void 0;
	if (value.sessionId !== void 0) {
		if (!isSafeSessionId(value.sessionId)) return;
		const sessionId = value.sessionId.trim();
		if (!normalizeTranscriptSessionId(sessionId) && !sessionFile) {
			const { sessionId: _dropSessionId, ...rest } = next;
			next = rest;
		} else if (sessionId !== value.sessionId) next = {
			...next,
			sessionId
		};
	}
	if (value.sessionFile !== void 0 && typeof value.sessionFile !== "string") {
		if (next === value) next = { ...next };
		delete next.sessionFile;
	}
	const updatedAt = normalizeOptionalTimestamp(value.updatedAt);
	if (updatedAt !== value.updatedAt) {
		if (next === value) next = { ...next };
		next.updatedAt = updatedAt ?? 0;
	}
	return next;
}
//#endregion
export { normalizePersistedSessionEntryShape as t };
