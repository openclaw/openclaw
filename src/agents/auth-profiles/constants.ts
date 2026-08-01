/**
 * Shared auth-profile constants.
 * Defines store versions, built-in CLI profile ids, lock budgets, refresh
 * timing, and logging used by auth profile runtime modules.
 */
import { createSubsystemLogger } from "../../logging/subsystem.js";

/** Current persisted auth profile store schema version. */
export const AUTH_STORE_VERSION = 1;

/** @deprecated Anthropic provider-owned CLI profile id; do not use from third-party plugins. */
export const CLAUDE_CLI_PROFILE_ID = "anthropic:claude-cli";
/** @deprecated OpenAI provider-owned CLI profile id; do not use from third-party plugins. */
export const CODEX_CLI_PROFILE_ID = "openai:codex-cli";
/** Default OpenAI/Codex OAuth profile id used for migrated stores. */
export const OPENAI_CODEX_DEFAULT_PROFILE_ID = "openai:default";
/** @deprecated MiniMax provider-owned CLI profile id; do not use from third-party plugins. */
export const MINIMAX_CLI_PROFILE_ID = "minimax-portal:minimax-cli";

// Invariant: OAUTH_REFRESH_CALL_TIMEOUT_MS < OAUTH_REFRESH_LOCK_OPTIONS.stale
// so a legitimate refresh's critical section always finishes well before
// peers would treat the lock as reclaimable. Violating this invariant re-
// introduces the `refresh_token_reused` race the lock is meant to prevent.
//
// Retry budget note: keep the MINIMUM cumulative retry window comfortably
// above OAUTH_REFRESH_INLOCK_TIMEOUT_MS (the full held-lock ceiling, which is
// wider than the network-call timeout) so a waiter never surfaces
// refresh_contention while the owner is still within its legitimate in-lock
// runtime budget. With retries=22 the jitter-free floor is 162.7s (12.7s over
// the 150s in-lock ceiling) and the jittered max stays under the 180s stale
// window: 100+200+...+6400 (attempts 0-6) + 15*10_000 (capped attempts 7-21).
/** Cross-agent lock policy for shared OAuth refresh operations. */
export const OAUTH_REFRESH_LOCK_OPTIONS = {
  retries: {
    retries: 22,
    factor: 2,
    minTimeout: 100,
    maxTimeout: 10_000,
    randomize: true,
  },
  stale: 180_000,
} as const;

// Hard upper bound on a single OAuth refresh call (plugin hook + HTTP
// token-exchange). Any refresh that runs longer than this is aborted and
// surfaced as a refresh failure. Keep strictly below
// OAUTH_REFRESH_LOCK_OPTIONS.stale so the lock is never treated as stale
// by a waiter while the owner is still doing legitimate work.
/** Maximum duration for one OAuth refresh call inside the refresh lock. */
export const OAUTH_REFRESH_CALL_TIMEOUT_MS = 120_000;

// Hard upper bound on the ENTIRE held-lock critical section, not just the
// network refresh call. The section also runs an in-lock keychain store load
// (which on darwin can hit securityd) and provider buildApiKey hooks; if either
// hangs while the cross-agent lock is held, every same-key refresher chain
// stalls on the in-process gate or blocks acquiring the file lock. This bounds
// the whole body so a wedged keychain/hook cannot pin the lock indefinitely.
// Sits between the call timeout (so the network call's tighter budget fires
// first) and the stale window (so a waiter never reclaims the lock while the
// owner is still within its allowed runtime).
// Invariant: OAUTH_REFRESH_CALL_TIMEOUT_MS < OAUTH_REFRESH_INLOCK_TIMEOUT_MS < OAUTH_REFRESH_LOCK_OPTIONS.stale.
/** Maximum duration for the full held-lock OAuth refresh critical section. */
export const OAUTH_REFRESH_INLOCK_TIMEOUT_MS = 150_000;

/** Freshness window for syncing external CLI auth into auth profiles. */
export const EXTERNAL_CLI_SYNC_TTL_MS = 15 * 60 * 1000;

/** Auth profile subsystem logger. */
export const log = createSubsystemLogger("agents/auth-profiles");
