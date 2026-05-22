import { g as toAgentStoreSessionKey } from "./session-key-CQewiu8n.js";
import { t as canonicalizeMainSessionAlias } from "./main-session-4-6sWu5o.js";
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
