/**
 * Shared auth-profile constants.
 * Defines store versions, built-in CLI profile ids, lock budgets, refresh
 * timing, and logging used by auth profile runtime modules.
 */
import { createSubsystemLogger } from "../../logging/subsystem.js";

/** Current persisted auth profile store schema version. */
export const AUTH_STORE_VERSION = 1;

export {
  CLAUDE_CLI_PROFILE_ID,
  CODEX_CLI_PROFILE_ID,
  MINIMAX_CLI_PROFILE_ID,
} from "./profile-ids.js";

/** Cross-agent lock policy for claiming and settling OAuth generations, not provider I/O. */
export const OAUTH_REFRESH_LOCK_OPTIONS = {
  retries: {
    retries: 20,
    factor: 2,
    minTimeout: 100,
    maxTimeout: 10_000,
    randomize: true,
  },
  stale: 180_000,
} as const;

/** Caller observation deadline; the refresh owner must still durably settle after timeout. */
export const OAUTH_REFRESH_CALL_TIMEOUT_MS = 120_000;

/** Freshness window for syncing external CLI auth into auth profiles. */
export const EXTERNAL_CLI_SYNC_TTL_MS = 15 * 60 * 1000;

/** Auth profile subsystem logger. */
export const authProfilesLog = createSubsystemLogger("agents/auth-profiles");

/** Post-commit diagnostics cannot replace an acknowledged durable result. */
export function reportCommittedInlineAuthFailure(message: string, error: unknown): void {
  try {
    authProfilesLog.warn(message, { error });
  } catch {
    // The write is already authoritative even when a diagnostic sink fails.
  }
}
