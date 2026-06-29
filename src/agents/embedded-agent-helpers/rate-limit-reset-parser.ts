/**
 * Parser for provider rate-limit reset timestamps.
 *
 * When a provider returns a rate-limit error containing an explicit reset
 * timestamp (e.g. "Your limit will reset at 2026-07-02 17:39:49"), this
 * module extracts that timestamp so the cooldown system can use it instead
 * of generic exponential backoff.
 *
 * See: https://github.com/openclaw/openclaw/issues/97764
 */

/** Max cooldown we'll set from a parsed reset timestamp (7 days). */
const MAX_RESET_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
/** Minimum cooldown for a parsed reset to be meaningful (30s). Below this, backoff is better. */
const MIN_RESET_COOLDOWN_MS = 30_000;

/**
 * Regex patterns for extracting reset timestamps from provider error messages.
 * Matches common formats across ZAI/ZhipuAI, OpenAI, Anthropic, and others.
 */
// "reset at YYYY-MM-DD HH:MM:SS" or "resets at YYYY-MM-DD HH:MM:SS"
// "reset at YYYY-MM-DDTHH:MM:SSZ" (ISO 8601)
const RESET_AT_DATETIME_RE =
  /(?:reset(?:s)?(?:\s+will)?\s+(?:at|on)|expires?\s+(?:at|on))\s+(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/i;

// "Retry-After: N" or "retry after N seconds"
const RETRY_AFTER_SECONDS_RE =
  /(?:retry[ -]after(?:\s+seconds?)?\s*[:=]?\s*)(\d{1,8})\s*(?:seconds?|s)?\b/i;

// "reset_after_seconds": N (JSON field)
const RESET_AFTER_SECONDS_JSON_RE = /["']?reset_after_seconds["']?\s*[:=]\s*(\d{1,8})/i;

// "reset_at": "YYYY-MM-DDTHH:MM:SSZ" (JSON field)
const RESET_AT_JSON_RE =
  /["']?reset_at["']?\s*[:=]\s*["'](\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)["']/i;

/**
 * Detects whether an error message indicates a periodic (daily/weekly/monthly)
 * quota exhaustion rather than a transient rate limit.
 *
 * Periodic quota errors typically include an explicit reset timestamp and
 * should be treated differently from transient server overload.
 */
export function isPeriodicQuotaError(rawMessage: string | undefined): boolean {
  if (!rawMessage) {
    return false;
  }
  return /\b(?:daily|weekly|monthly)(?:\/(?:daily|weekly|monthly))*\s+(?:usage\s+)?limit(?:s)?(?:\s+(?:exhausted|reached|exceeded))?\b/i.test(
    rawMessage,
  );
}

/**
 * Parse a reset timestamp from a provider rate-limit error message.
 *
 * Returns the cooldown duration in milliseconds (relative to `now`), or `null`
 * if no reset timestamp could be parsed.
 *
 * The returned duration is clamped to [MIN_RESET_COOLDOWN_MS, MAX_RESET_COOLDOWN_MS].
 * Durations below MIN_RESET_COOLDOWN_MS are treated as noise — exponential
 * backoff is more appropriate for short windows.
 *
 * @param rawMessage - The raw error text from the provider response
 * @param now - Current timestamp (ms epoch). Defaults to Date.now()
 */
export function parseRateLimitResetTimestamp(
  rawMessage: string | undefined | null,
  now: number = Date.now(),
): number | null {
  if (!rawMessage || typeof rawMessage !== "string") {
    return null;
  }

  // Try datetime patterns first (most precise)
  const cooldownMs = tryParseDatetime(rawMessage, now) ?? tryParseSeconds(rawMessage, now);
  if (cooldownMs === null) {
    return null;
  }

  // Clamp to reasonable bounds
  if (cooldownMs < MIN_RESET_COOLDOWN_MS) {
    return null;
  }
  return Math.min(cooldownMs, MAX_RESET_COOLDOWN_MS);
}

function tryParseDatetime(raw: string, now: number): number | null {
  // Try "reset(s) at YYYY-MM-DD..." format
  const match1 = raw.match(RESET_AT_DATETIME_RE);
  if (match1) {
    const parsed = parseTimestamp(match1[1]);
    if (parsed !== null) {
      return Math.max(0, parsed - now);
    }
  }

  // Try JSON "reset_at" field
  const match2 = raw.match(RESET_AT_JSON_RE);
  if (match2) {
    const parsed = parseTimestamp(match2[1]);
    if (parsed !== null) {
      return Math.max(0, parsed - now);
    }
  }

  return null;
}

function tryParseSeconds(raw: string, now: number): number | null {
  // Try "Retry-After: N" / "retry after N seconds"
  const match1 = raw.match(RETRY_AFTER_SECONDS_RE);
  if (match1) {
    const seconds = parseInt(match1[1], 10);
    if (Number.isFinite(seconds) && seconds > 0) {
      return seconds * 1000;
    }
  }

  // Try JSON "reset_after_seconds" field
  const match2 = raw.match(RESET_AFTER_SECONDS_JSON_RE);
  if (match2) {
    const seconds = parseInt(match2[1], 10);
    if (Number.isFinite(seconds) && seconds > 0) {
      return seconds * 1000;
    }
  }

  return null;
}

/**
 * Parse a timestamp string into epoch milliseconds.
 * Handles both "YYYY-MM-DD HH:MM:SS" (space separator) and ISO 8601 formats.
 */
function parseTimestamp(value: string): number | null {
  // Normalize space separator to "T" for ISO parsing
  const normalized = value.includes("T") ? value : value.replace(" ", "T");

  // If no timezone suffix, assume the provider's local time matches the runtime timezone.
  // This is imperfect but covers the common case where the server and client share a TZ.
  const hasTz = /(?:Z|[+-]\d{2}:?\d{2})$/.test(normalized);

  const date = new Date(hasTz ? normalized : normalized + "Z");
  const ms = date.getTime();
  if (!Number.isFinite(ms)) {
    return null;
  }
  return ms;
}
