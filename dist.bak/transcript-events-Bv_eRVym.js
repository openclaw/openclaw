//#region src/sessions/transcript-events.ts
const SESSION_TRANSCRIPT_LISTENERS = /* @__PURE__ */ new Set();
function onSessionTranscriptUpdate(listener) {
	SESSION_TRANSCRIPT_LISTENERS.add(listener);
	return () => {
		SESSION_TRANSCRIPT_LISTENERS.delete(listener);
	};
}
function emitSessionTranscriptUpdate(sessionFile) {
	const trimmed = sessionFile.trim();
	if (!trimmed) return;
	const update = { sessionFile: trimmed };
	for (const listener of SESSION_TRANSCRIPT_LISTENERS) listener(update);
}

//#endregion
export { onSessionTranscriptUpdate as n, emitSessionTranscriptUpdate as t };