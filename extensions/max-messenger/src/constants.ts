/**
 * Outbound text chunk size (chars). Default: 4000.
 *
 * TODO(phase-1c): verify empirically against MAX `send_message` body limit.
 * Locked at 4000 by docs/max-plugin/plan.md §8 row 6 — unverified upstream
 * limit, revisit after the first smoke test against a real bot token.
 */
export const MAX_TEXT_CHUNK_LIMIT = 4000;

/** Default DM policy per docs/max-plugin/plan.md §8 row 4. */
export const MAX_DEFAULT_DM_POLICY = "pairing";

/** Default group policy mirrors nextcloud-talk and Telegram defaults. */
export const MAX_DEFAULT_GROUP_POLICY = "allowlist";

/**
 * Environment variable consulted for the default-account bot token when no
 * tokenFile or inline token is provided. Mirrors `TELEGRAM_BOT_TOKEN`.
 */
export const MAX_BOT_TOKEN_ENV = "MAX_BOT_TOKEN";
