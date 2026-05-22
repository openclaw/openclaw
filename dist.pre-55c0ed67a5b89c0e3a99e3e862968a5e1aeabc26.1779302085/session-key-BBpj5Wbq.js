import { g as toAgentStoreSessionKey } from "./session-key-BAP1m9Ju.js";
import { t as canonicalizeMainSessionAlias } from "./main-session-DkcVDKOd.js";
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
