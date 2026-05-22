import { p as resolveSessionAgentId } from "./agent-scope-ByE5d_BM.js";
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
export { buildSessionStartHookPayload as n, buildSessionEndHookPayload as t };
