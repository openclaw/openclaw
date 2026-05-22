import { m as toAgentRequestSessionKey } from "./session-key-D4Z2yNv-.js";
import { i as getRuntimeConfig } from "./io-BqN-ccJq.js";
import { c as getAgentRunContext, u as registerAgentRunContext } from "./agent-events-yfdFay37.js";
import { t as loadCombinedSessionStoreForGateway } from "./combined-store-gateway-DD03OJf3.js";
import "./session-utils-EvD7NRX-.js";
import { t as resolvePreferredSessionKeyForSessionIdMatches } from "./session-id-resolution-Z3L4r9fy.js";
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
