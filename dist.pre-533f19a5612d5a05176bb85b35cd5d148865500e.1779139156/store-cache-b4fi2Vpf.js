import { t as createSubsystemLogger } from "./subsystem-BCvJ25zm.js";
import { g as cloneAuthProfileStore } from "./runtime-snapshots-DMGDLaeG.js";
//#region src/agents/auth-profiles/constants.ts
/** @deprecated Anthropic provider-owned CLI profile id; do not use from third-party plugins. */
const CLAUDE_CLI_PROFILE_ID = "anthropic:claude-cli";
/** @deprecated OpenAI Codex provider-owned CLI profile id; do not use from third-party plugins. */
const CODEX_CLI_PROFILE_ID = "openai-codex:codex-cli";
const OPENAI_CODEX_DEFAULT_PROFILE_ID = "openai-codex:default";
/** @deprecated MiniMax provider-owned CLI profile id; do not use from third-party plugins. */
const MINIMAX_CLI_PROFILE_ID = "minimax-portal:minimax-cli";
const AUTH_STORE_LOCK_OPTIONS = {
	retries: {
		retries: 10,
		factor: 2,
		minTimeout: 100,
		maxTimeout: 1e4,
		randomize: true
	},
	stale: 3e4
};
const OAUTH_REFRESH_LOCK_OPTIONS = {
	retries: {
		retries: 20,
		factor: 2,
		minTimeout: 100,
		maxTimeout: 1e4,
		randomize: true
	},
	stale: 18e4
};
const OAUTH_REFRESH_CALL_TIMEOUT_MS = 12e4;
const EXTERNAL_CLI_SYNC_TTL_MS = 900 * 1e3;
const log = createSubsystemLogger("agents/auth-profiles");
//#endregion
//#region src/agents/auth-profiles/store-cache.ts
const loadedAuthStoreCache = /* @__PURE__ */ new Map();
function readCachedAuthProfileStore(params) {
	const cached = loadedAuthStoreCache.get(params.authPath);
	if (!cached || cached.authMtimeMs !== params.authMtimeMs || cached.stateMtimeMs !== params.stateMtimeMs) return null;
	if (Date.now() - cached.syncedAtMs >= 9e5) return null;
	return cloneAuthProfileStore(cached.store);
}
function writeCachedAuthProfileStore(params) {
	loadedAuthStoreCache.set(params.authPath, {
		authMtimeMs: params.authMtimeMs,
		stateMtimeMs: params.stateMtimeMs,
		syncedAtMs: Date.now(),
		store: cloneAuthProfileStore(params.store)
	});
}
function clearLoadedAuthStoreCache() {
	loadedAuthStoreCache.clear();
}
//#endregion
export { CLAUDE_CLI_PROFILE_ID as a, MINIMAX_CLI_PROFILE_ID as c, OPENAI_CODEX_DEFAULT_PROFILE_ID as d, log as f, AUTH_STORE_LOCK_OPTIONS as i, OAUTH_REFRESH_CALL_TIMEOUT_MS as l, readCachedAuthProfileStore as n, CODEX_CLI_PROFILE_ID as o, writeCachedAuthProfileStore as r, EXTERNAL_CLI_SYNC_TTL_MS as s, clearLoadedAuthStoreCache as t, OAUTH_REFRESH_LOCK_OPTIONS as u };
