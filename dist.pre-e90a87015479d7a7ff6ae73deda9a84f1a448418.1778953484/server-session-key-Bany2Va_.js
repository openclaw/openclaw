import { h as toAgentRequestSessionKey } from "./session-key-DFEyR49L.js";
import { i as getRuntimeConfig } from "./io-CKxpl45h.js";
import { c as getAgentRunContext, u as registerAgentRunContext } from "./agent-events-B1hkQDEm.js";
import { t as loadCombinedSessionStoreForGateway } from "./combined-store-gateway-BOfF_hjX.js";
import "./session-utils-Cved_m-3.js";
import { t as resolvePreferredSessionKeyForSessionIdMatches } from "./session-id-resolution-BnTUxD_W.js";
//#region src/gateway/server-session-key.ts
const RUN_LOOKUP_CACHE_LIMIT = 256;
const RUN_LOOKUP_MISS_TTL_MS = 1e3;
const resolvedSessionKeyByRunId = /* @__PURE__ */ new Map();
function setResolvedSessionKeyCache(runId, sessionKey) {
	if (!runId) return;
	if (!resolvedSessionKeyByRunId.has(runId) && resolvedSessionKeyByRunId.size >= RUN_LOOKUP_CACHE_LIMIT) {
		const oldest = resolvedSessionKeyByRunId.keys().next().value;
		if (oldest) resolvedSessionKeyByRunId.delete(oldest);
	}
	resolvedSessionKeyByRunId.set(runId, {
		sessionKey,
		expiresAt: sessionKey === null ? Date.now() + RUN_LOOKUP_MISS_TTL_MS : null
	});
}
function resolveSessionKeyForRun(runId) {
	const cached = getAgentRunContext(runId)?.sessionKey;
	if (cached) return cached;
	const cachedLookup = resolvedSessionKeyByRunId.get(runId);
	if (cachedLookup !== void 0) {
		if (cachedLookup.sessionKey !== null) return cachedLookup.sessionKey;
		if ((cachedLookup.expiresAt ?? 0) > Date.now()) return;
		resolvedSessionKeyByRunId.delete(runId);
	}
	const { store } = loadCombinedSessionStoreForGateway(getRuntimeConfig());
	const storeKey = resolvePreferredSessionKeyForSessionIdMatches(Object.entries(store).filter((entry) => entry[1]?.sessionId === runId), runId);
	if (storeKey) {
		const sessionKey = toAgentRequestSessionKey(storeKey) ?? storeKey;
		registerAgentRunContext(runId, { sessionKey });
		setResolvedSessionKeyCache(runId, sessionKey);
		return sessionKey;
	}
	setResolvedSessionKeyCache(runId, null);
}
function resetResolvedSessionKeyForRunCacheForTest() {
	resolvedSessionKeyByRunId.clear();
}
//#endregion
export { resolveSessionKeyForRun as n, resetResolvedSessionKeyForRunCacheForTest as t };
