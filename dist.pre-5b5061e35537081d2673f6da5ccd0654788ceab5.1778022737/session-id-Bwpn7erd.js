//#region src/sessions/session-id.ts
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function looksLikeSessionId(value) {
	return SESSION_ID_RE.test(value.trim());
}
//#endregion
export { looksLikeSessionId as n, SESSION_ID_RE as t };
