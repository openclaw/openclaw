export declare function resolveAuthStorePath(agentDir?: string): string;
export declare function resolveLegacyAuthStorePath(agentDir?: string): string;
export declare function resolveAuthStatePath(agentDir?: string): string;
export declare function resolveAuthStorePathForDisplay(agentDir?: string): string;
export declare function resolveAuthStatePathForDisplay(agentDir?: string): string;
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
export declare function resolveOAuthRefreshLockPath(provider: string, profileId: string): string;
