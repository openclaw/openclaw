import { y as resolveStateDir } from "./paths-Cw7f9XhU.js";
import { p as resolveUserPath } from "./utils-sBTEdeml.js";
import { s as resolveDefaultAgentDir } from "./agent-scope-config-CMp71_27.js";
import path from "node:path";
import { createHash } from "node:crypto";
//#region src/agents/auth-profiles/path-constants.ts
const AUTH_PROFILE_FILENAME = "auth-profiles.json";
const AUTH_STATE_FILENAME = "auth-state.json";
const LEGACY_AUTH_FILENAME = "auth.json";
//#endregion
//#region src/agents/auth-profiles/path-resolve.ts
function resolveAuthStorePath(agentDir) {
	const resolved = resolveUserPath(agentDir ?? resolveDefaultAgentDir({}));
	return path.join(resolved, AUTH_PROFILE_FILENAME);
}
function resolveLegacyAuthStorePath(agentDir) {
	const resolved = resolveUserPath(agentDir ?? resolveDefaultAgentDir({}));
	return path.join(resolved, LEGACY_AUTH_FILENAME);
}
function resolveAuthStatePath(agentDir) {
	const resolved = resolveUserPath(agentDir ?? resolveDefaultAgentDir({}));
	return path.join(resolved, AUTH_STATE_FILENAME);
}
function resolveAuthStorePathForDisplay(agentDir) {
	const pathname = resolveAuthStorePath(agentDir);
	return pathname.startsWith("~") ? pathname : resolveUserPath(pathname);
}
function resolveAuthStatePathForDisplay(agentDir) {
	const pathname = resolveAuthStatePath(agentDir);
	return pathname.startsWith("~") ? pathname : resolveUserPath(pathname);
}
/**
* Resolve the path of the cross-agent, per-profile OAuth refresh coordination
* lock. The filename hashes `provider\0profileId` so it is filesystem-safe
* for arbitrary unicode/control-character inputs and always bounded in
* length. The NUL separator makes it impossible to collide two distinct
* `(provider, profileId)` pairs by string concatenation.
*
* This lock is the serialization point that prevents the `refresh_token_reused`
* storm when N agents share one OAuth profile (see issue #26322): every agent
* that attempts a refresh acquires this same file lock, so only one HTTP
* refresh is in-flight at a time and peers can adopt the resulting fresh
* credentials instead of racing against a single-use refresh token.
*
* The key intentionally includes `provider` so that two profiles that
* happen to share a `profileId` across providers (operator-renamed profile,
* test fixture, etc.) do not needlessly serialize against each other.
*/
function resolveOAuthRefreshLockPath(provider, profileId) {
	const hash = createHash("sha256");
	hash.update(provider, "utf8");
	hash.update("\0", "utf8");
	hash.update(profileId, "utf8");
	const safeId = `sha256-${hash.digest("hex")}`;
	return path.join(resolveStateDir(), "locks", "oauth-refresh", safeId);
}
//#endregion
export { resolveLegacyAuthStorePath as a, AUTH_STATE_FILENAME as c, resolveAuthStorePathForDisplay as i, LEGACY_AUTH_FILENAME as l, resolveAuthStatePathForDisplay as n, resolveOAuthRefreshLockPath as o, resolveAuthStorePath as r, AUTH_PROFILE_FILENAME as s, resolveAuthStatePath as t };
