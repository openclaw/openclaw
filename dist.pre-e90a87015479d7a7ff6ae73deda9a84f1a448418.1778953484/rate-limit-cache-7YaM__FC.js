//#region extensions/codex/src/app-server/rate-limit-cache.ts
const DEFAULT_CODEX_RATE_LIMIT_CACHE_MAX_AGE_MS = 10 * 6e4;
const CODEX_RATE_LIMIT_CACHE_STATE = Symbol.for("openclaw.codexRateLimitCacheState");
function getCodexRateLimitCacheState() {
	const globalState = globalThis;
	globalState[CODEX_RATE_LIMIT_CACHE_STATE] ??= {};
	return globalState[CODEX_RATE_LIMIT_CACHE_STATE];
}
function rememberCodexRateLimits(value, nowMs = Date.now()) {
	if (value === void 0) return;
	const state = getCodexRateLimitCacheState();
	state.value = value;
	state.updatedAtMs = nowMs;
}
function readRecentCodexRateLimits(options) {
	const state = getCodexRateLimitCacheState();
	if (state.value === void 0 || state.updatedAtMs === void 0) return;
	const nowMs = options?.nowMs ?? Date.now();
	const maxAgeMs = options?.maxAgeMs ?? DEFAULT_CODEX_RATE_LIMIT_CACHE_MAX_AGE_MS;
	if (maxAgeMs >= 0 && nowMs - state.updatedAtMs > maxAgeMs) return;
	return state.value;
}
//#endregion
export { rememberCodexRateLimits as n, readRecentCodexRateLimits as t };
