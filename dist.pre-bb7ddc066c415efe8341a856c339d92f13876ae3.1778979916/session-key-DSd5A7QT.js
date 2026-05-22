import { g as toAgentStoreSessionKey } from "./session-key-8g_Q03Po.js";
import { t as canonicalizeMainSessionAlias } from "./main-session-Cc6fUCKz.js";
//#region src/cron/isolated-agent/session-key.ts
function resolveCronAgentSessionKey(params) {
	const raw = toAgentStoreSessionKey({
		agentId: params.agentId,
		requestKey: params.sessionKey.trim(),
		mainKey: params.mainKey
	});
	return canonicalizeMainSessionAlias({
		cfg: params.cfg,
		agentId: params.agentId,
		sessionKey: raw
	});
}
//#endregion
export { resolveCronAgentSessionKey as t };
