import { createSubsystemLogger } from "../../logging/subsystem.js";

export const AUTH_STORE_VERSION = 1;
export const AUTH_PROFILE_FILENAME = "auth-profiles.json";
export const LEGACY_AUTH_FILENAME = "auth.json";

export const CLAUDE_CLI_PROFILE_ID = "anthropic:claude-cli";
export const CODEX_CLI_PROFILE_ID = "openai-codex:codex-cli";
export const QWEN_CLI_PROFILE_ID = "qwen-portal:qwen-cli";
export const MINIMAX_CLI_PROFILE_ID = "minimax-portal:minimax-cli";

/**
 * Sync target for Codex CLI credentials.
 *
 * We intentionally use `openai-codex:default` — the same slot that
 * `openclaw models auth login --provider openai-codex` writes to — so that
 * the two auth paths converge on a single, non-deprecated profile.
 *
 * The legacy `CODEX_CLI_PROFILE_ID` (`openai-codex:codex-cli`) is treated as
 * deprecated by `maybeRemoveDeprecatedCliAuthProfiles` in `doctor-auth.ts`.
 */
export const CODEX_CLI_SYNC_PROFILE_ID = "openai-codex:default";

export const AUTH_STORE_LOCK_OPTIONS = {
  retries: {
    retries: 10,
    factor: 2,
    minTimeout: 100,
    maxTimeout: 10_000,
    randomize: true,
  },
  stale: 30_000,
} as const;

export const EXTERNAL_CLI_SYNC_TTL_MS = 15 * 60 * 1000;
export const EXTERNAL_CLI_NEAR_EXPIRY_MS = 10 * 60 * 1000;

export const log = createSubsystemLogger("agents/auth-profiles");
