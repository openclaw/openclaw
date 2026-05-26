import { _ as resolveSessionAgentId } from "./agent-scope-CtLXGcWm.js";
//#region src/auto-reply/reply/session-hooks.ts
function buildSessionHookContext(params) {
	return {
		sessionId: params.sessionId,
		sessionKey: params.sessionKey,
		agentId: resolveSessionAgentId({
			sessionKey: params.sessionKey,
			config: params.cfg
		})
	};
}
function buildSessionStartHookPayload(params) {
	return {
		event: {
			sessionId: params.sessionId,
			sessionKey: params.sessionKey,
			resumedFrom: params.resumedFrom
		},
		context: buildSessionHookContext({
			sessionId: params.sessionId,
			sessionKey: params.sessionKey,
			cfg: params.cfg
		})
	};
}
function buildSessionEndHookPayload(params) {
	return {
		event: {
			sessionId: params.sessionId,
			sessionKey: params.sessionKey,
			messageCount: params.messageCount ?? 0,
			durationMs: params.durationMs,
			reason: params.reason,
			sessionFile: params.sessionFile,
			transcriptArchived: params.transcriptArchived,
			nextSessionId: params.nextSessionId,
			nextSessionKey: params.nextSessionKey
		},
		context: buildSessionHookContext({
			sessionId: params.sessionId,
			sessionKey: params.sessionKey,
			cfg: params.cfg
		})
	};
}
//#endregion
//#region src/gateway/active-sessions-shutdown-tracker.ts
const trackedSessions = /* @__PURE__ */ new Map();
function noteActiveSessionForShutdown(entry) {
	if (!entry.sessionId) return;
	trackedSessions.set(entry.sessionId, entry);
}
function forgetActiveSessionForShutdown(sessionId) {
	if (!sessionId) return;
	trackedSessions.delete(sessionId);
}
function listActiveSessionsForShutdown() {
	return Array.from(trackedSessions.values());
}
//#endregion
export { buildSessionStartHookPayload as a, buildSessionEndHookPayload as i, listActiveSessionsForShutdown as n, noteActiveSessionForShutdown as r, forgetActiveSessionForShutdown as t };
