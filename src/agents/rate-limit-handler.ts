/**
 * Rate Limit Handler
 *
 * Provides configurable strategies for handling rate limits (HTTP 429) and credit exhaustion:
 * - "switch": Immediately try the next fallback model (default, current behavior)
 * - "wait": Parse Retry-After header and wait, then retry the same model
 * - "ask": Emit an event asking the user to choose
 */

import type { FailoverReason } from "./pi-embedded-helpers.js";

export type RateLimitStrategy = "switch" | "wait" | "ask";

export type RateLimitConfig = {
  /** Strategy when rate limit is hit: switch to fallback, wait and retry, or ask user. */
  strategy?: RateLimitStrategy;
  /** Max seconds to wait before falling back to switch strategy (default: 60). */
  maxWaitSeconds?: number;
  /** Backup model to use when strategy is "switch" (uses configured fallbacks if not set). */
  backupModel?: string;
};

export type RateLimitInfo = {
  /** Retry-After value in seconds (if available from headers). */
  retryAfterSeconds?: number;
  /** The reason for the rate limit (rate_limit, billing, etc.). */
  reason: FailoverReason;
  /** The provider that returned the rate limit. */
  provider: string;
  /** The model that was rate limited. */
  model: string;
  /** HTTP status code (429, 402, etc.). */
  status?: number;
};

export type RateLimitDecision = {
  /** Action to take. */
  action: "wait" | "switch" | "ask";
  /** Seconds to wait (if action is "wait"). */
  waitSeconds?: number;
  /** Model to switch to (if action is "switch" and backupModel is configured). */
  switchToModel?: string;
};

const DEFAULT_MAX_WAIT_SECONDS = 60;

/**
 * Parse Retry-After header value.
 * Supports both seconds (integer) and HTTP-date formats.
 */
export function parseRetryAfter(headerValue: string | null | undefined): number | undefined {
  if (!headerValue) {
    return undefined;
  }

  const trimmed = headerValue.trim();

  // Try parsing as integer (seconds)
  const asNumber = parseInt(trimmed, 10);
  if (!Number.isNaN(asNumber)) {
    // Negative values are invalid for Retry-After
    if (asNumber < 0) {
      return undefined;
    }
    // If it looks like a plain number, return it
    if (/^-?\d+$/.test(trimmed)) {
      return asNumber;
    }
  }

  // Try parsing as HTTP-date (only if it doesn't look like a plain number)
  const asDate = Date.parse(trimmed);
  if (!Number.isNaN(asDate)) {
    const seconds = Math.max(0, Math.ceil((asDate - Date.now()) / 1000));
    return seconds;
  }

  return undefined;
}

/**
 * Extract Retry-After from various header formats used by AI providers.
 */
export function extractRetryAfterFromHeaders(
  headers: Record<string, string | string[] | undefined> | Headers | undefined,
): number | undefined {
  if (!headers) {
    return undefined;
  }

  // Normalize headers access
  const getHeader = (name: string): string | undefined => {
    if (headers instanceof Headers) {
      return headers.get(name) ?? undefined;
    }
    const value = headers[name] ?? headers[name.toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
  };

  // Standard Retry-After
  const retryAfter = getHeader("Retry-After") ?? getHeader("retry-after");
  if (retryAfter) {
    return parseRetryAfter(retryAfter);
  }

  // Anthropic-specific: anthropic-ratelimit-tokens-reset or anthropic-ratelimit-requests-reset
  const anthropicTokensReset = getHeader("anthropic-ratelimit-tokens-reset");
  const anthropicRequestsReset = getHeader("anthropic-ratelimit-requests-reset");
  const resetHeader = anthropicTokensReset ?? anthropicRequestsReset;
  if (resetHeader) {
    // Anthropic uses ISO 8601 timestamps
    const resetTime = Date.parse(resetHeader);
    if (!Number.isNaN(resetTime)) {
      return Math.max(0, Math.ceil((resetTime - Date.now()) / 1000));
    }
  }

  // OpenAI-specific: x-ratelimit-reset-tokens or x-ratelimit-reset-requests (in seconds)
  const openaiReset =
    getHeader("x-ratelimit-reset-tokens") ?? getHeader("x-ratelimit-reset-requests");
  if (openaiReset) {
    // OpenAI uses duration strings like "1s" or "6m0s"
    const match = openaiReset.match(/^(?:(\d+)m)?(\d+)s$/);
    if (match) {
      const minutes = parseInt(match[1] ?? "0", 10);
      const seconds = parseInt(match[2] ?? "0", 10);
      return minutes * 60 + seconds;
    }
    // Try as plain number
    const asNum = parseRetryAfter(openaiReset);
    if (asNum !== undefined) {
      return asNum;
    }
  }

  return undefined;
}

/**
 * Determine what action to take when a rate limit is encountered.
 */
export function decideRateLimitAction(
  config: RateLimitConfig | undefined,
  info: RateLimitInfo,
): RateLimitDecision {
  const strategy = config?.strategy ?? "switch";
  const maxWait = config?.maxWaitSeconds ?? DEFAULT_MAX_WAIT_SECONDS;
  const retryAfter = info.retryAfterSeconds;

  // For billing errors (402), always switch - waiting won't help
  if (info.reason === "billing") {
    return {
      action: "switch",
      switchToModel: config?.backupModel,
    };
  }

  switch (strategy) {
    case "wait": {
      // If we have a retry-after and it's within our max wait time, wait
      if (retryAfter !== undefined && retryAfter <= maxWait) {
        return {
          action: "wait",
          waitSeconds: retryAfter,
        };
      }
      // Otherwise fall back to switch
      return {
        action: "switch",
        switchToModel: config?.backupModel,
      };
    }

    case "ask": {
      return {
        action: "ask",
        waitSeconds: retryAfter,
        switchToModel: config?.backupModel,
      };
    }

    case "switch":
    default: {
      return {
        action: "switch",
        switchToModel: config?.backupModel,
      };
    }
  }
}

/**
 * Check if an error represents a rate limit condition.
 *
 * Note: Message-based detection (for "credit", "billing", etc.) is only used
 * when a relevant HTTP status code (429, 402, or 5xx) is present, or when no
 * status is available (SDK errors). This prevents misclassifying unrelated
 * errors that happen to contain these words (e.g., "billing address invalid").
 */
export function isRateLimitError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }

  // Check status code
  const status =
    (err as { status?: number }).status ?? (err as { statusCode?: number }).statusCode;

  // Direct rate limit or billing status codes
  if (status === 429 || status === 402) {
    return true;
  }

  // For message-based detection, only trust it when we have a status code
  // that could plausibly be a rate limit/billing error (or no status at all
  // for SDK errors that don't expose status)
  const hasRelevantStatus =
    status === undefined || status === 429 || status === 402 || (status >= 500 && status < 600);

  const message = (err as { message?: string }).message ?? "";
  const lowerMessage = message.toLowerCase();

  // High-confidence patterns: these are specific to rate limiting
  if (
    lowerMessage.includes("rate limit") ||
    lowerMessage.includes("rate_limit") ||
    lowerMessage.includes("too many requests") ||
    lowerMessage.includes("quota exceeded")
  ) {
    return true;
  }

  // Lower-confidence patterns: require relevant status code to avoid false positives
  // (e.g., an error about "billing address validation failed" shouldn't trigger rate limit handling)
  if (hasRelevantStatus) {
    if (
      lowerMessage.includes("credit") ||
      lowerMessage.includes("billing") ||
      lowerMessage.includes("insufficient funds") ||
      lowerMessage.includes("payment required")
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Extract rate limit info from an error response.
 */
export function extractRateLimitInfo(
  err: unknown,
  context: { provider: string; model: string },
): RateLimitInfo | null {
  if (!isRateLimitError(err)) {
    return null;
  }

  const status =
    (err as { status?: number }).status ?? (err as { statusCode?: number }).statusCode;
  const headers = (err as { headers?: Record<string, string> }).headers;
  const retryAfterSeconds = extractRetryAfterFromHeaders(headers);

  // Determine reason
  let reason: FailoverReason = "rate_limit";
  if (status === 402) {
    reason = "billing";
  }
  const message = ((err as { message?: string }).message ?? "").toLowerCase();
  if (message.includes("billing") || message.includes("credit") || message.includes("payment")) {
    reason = "billing";
  }

  return {
    retryAfterSeconds,
    reason,
    provider: context.provider,
    model: context.model,
    status,
  };
}
