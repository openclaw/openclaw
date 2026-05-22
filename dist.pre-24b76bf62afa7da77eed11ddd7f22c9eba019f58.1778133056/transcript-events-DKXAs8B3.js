import { c as normalizeOptionalString } from "./string-coerce-Bje8XVt9.js";
//#region src/sessions/transcript-events.ts
const SESSION_TRANSCRIPT_LISTENERS = /* @__PURE__ */ new Set();
function onSessionTranscriptUpdate(listener) {
	SESSION_TRANSCRIPT_LISTENERS.add(listener);
	return () => {
		SESSION_TRANSCRIPT_LISTENERS.delete(listener);
	};
}
function emitSessionTranscriptUpdate(update) {
	const normalized = typeof update === "string" ? { sessionFile: update } : {
		sessionFile: update.sessionFile,
		sessionKey: update.sessionKey,
		message: update.message,
		messageId: update.messageId
	};
	const trimmed = normalizeOptionalString(normalized.sessionFile);
	if (!trimmed) return;
	const nextUpdate = {
		sessionFile: trimmed,
		...normalizeOptionalString(normalized.sessionKey) ? { sessionKey: normalizeOptionalString(normalized.sessionKey) } : {},
		...normalized.message !== void 0 ? { message: normalized.message } : {},
		...normalizeOptionalString(normalized.messageId) ? { messageId: normalizeOptionalString(normalized.messageId) } : {}
	};
	for (const listener of SESSION_TRANSCRIPT_LISTENERS) try {
		listener(nextUpdate);
	} catch {}
}
//#endregion
export { onSessionTranscriptUpdate as n, emitSessionTranscriptUpdate as t };
