import "./agent-scope-C5uhMtO-.js";
import { c as parseAgentSessionKey } from "./session-key-utils-CJRKuBJA.js";
import { c as normalizeAgentId, h as toAgentRequestSessionKey } from "./session-key-CQewiu8n.js";
import { c as resolveDefaultAgentId } from "./agent-scope-config-BWnA6LIS.js";
import { i as getRuntimeConfig } from "./io-B6jpFTxl.js";
import { c as getAgentRunContext } from "./agent-events-Cnxmg94X.js";
import { a as resolveSessionStoreKey, i as resolveSessionStoreAgentId, t as loadCombinedSessionStoreForGateway } from "./combined-store-gateway-CQjnzbFR.js";
import "./session-utils-DQ51FnrF.js";
import { t as resolvePreferredSessionKeyForSessionIdMatches } from "./session-id-resolution-werFKjEw.js";
//#region src/gateway/server-session-key.ts
const RUN_LOOKUP_CACHE_LIMIT = 256;
const RUN_LOOKUP_MISS_TTL_MS = 1e3;
const resolvedSessionKeyByRunId = /* @__PURE__ */ new Map();
function runLookupCacheKey(runId, agentId) {
	return `${agentId}\0${runId}`;
}
function setResolvedSessionKeyCache(runId, agentId, sessionKey) {
	if (!runId) return;
	const cacheKey = runLookupCacheKey(runId, agentId);
	if (!resolvedSessionKeyByRunId.has(cacheKey) && resolvedSessionKeyByRunId.size >= RUN_LOOKUP_CACHE_LIMIT) {
		const oldest = resolvedSessionKeyByRunId.keys().next().value;
		if (oldest) resolvedSessionKeyByRunId.delete(oldest);
	}
	resolvedSessionKeyByRunId.set(cacheKey, {
		sessionKey,
		expiresAt: sessionKey === null ? Date.now() + RUN_LOOKUP_MISS_TTL_MS : null
	});
}
function sessionKeyMatchesAgent(sessionKey, agentId, cfg) {
	if (cfg.session?.scope === "global" && sessionKey.trim().toLowerCase() === "global") return true;
	const normalizedAgentId = normalizeAgentId(agentId);
	if (!parseAgentSessionKey(sessionKey) && sessionKey.trim().toLowerCase().startsWith("agent:")) return false;
	return resolveSessionStoreAgentId(cfg, resolveSessionStoreKey({
		cfg,
		sessionKey,
		storeAgentId: agentId
	})) === normalizedAgentId;
}
function resolveRunSessionKeyForCaller(storeKey) {
	return toAgentRequestSessionKey(storeKey) ?? storeKey;
}
function resolveSessionKeyForRun(runId, opts = {}) {
	const cfg = getRuntimeConfig();
	const explicitAgentId = typeof opts.agentId === "string" && opts.agentId.trim() ? normalizeAgentId(opts.agentId) : void 0;
	const cached = getAgentRunContext(runId)?.sessionKey;
	if (!explicitAgentId && cached) return cached;
	const requestedAgentId = explicitAgentId ?? normalizeAgentId(resolveDefaultAgentId(cfg));
	const cacheAgentId = requestedAgentId;
	if (cached && sessionKeyMatchesAgent(cached, requestedAgentId, cfg)) {
		const sessionKey = resolveRunSessionKeyForCaller(cached);
		setResolvedSessionKeyCache(runId, cacheAgentId, sessionKey);
		return sessionKey;
	}
	const cacheKey = runLookupCacheKey(runId, cacheAgentId);
	const cachedLookup = resolvedSessionKeyByRunId.get(cacheKey);
	if (cachedLookup !== void 0) {
		if (cachedLookup.sessionKey !== null) return cachedLookup.sessionKey;
		if ((cachedLookup.expiresAt ?? 0) > Date.now()) return;
		resolvedSessionKeyByRunId.delete(cacheKey);
	}
	const { store } = loadCombinedSessionStoreForGateway(cfg, { agentId: requestedAgentId });
	const storeKey = resolvePreferredSessionKeyForSessionIdMatches(Object.entries(store).filter((entry) => entry[1]?.sessionId === runId && sessionKeyMatchesAgent(entry[0], requestedAgentId, cfg)), runId);
	if (storeKey) {
		const sessionKey = resolveRunSessionKeyForCaller(storeKey);
		setResolvedSessionKeyCache(runId, cacheAgentId, sessionKey);
		return sessionKey;
	}
	setResolvedSessionKeyCache(runId, cacheAgentId, null);
}
function resetResolvedSessionKeyForRunCacheForTest() {
	resolvedSessionKeyByRunId.clear();
}
//#endregion
export { resolveSessionKeyForRun as n, resetResolvedSessionKeyForRunCacheForTest as t };
