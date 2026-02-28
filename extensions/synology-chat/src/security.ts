/**
 * Security module: token validation, rate limiting, input sanitization, user allowlist.
 */

import * as crypto from "node:crypto";

export type DmAuthorizationResult =
  | { allowed: true }
  | { allowed: false; reason: "disabled" | "allowlist-empty" | "not-allowlisted" };

/**
 * Validate webhook token using constant-time comparison.
 * Prevents timing attacks that could leak token bytes.
 */
export function validateToken(received: string, expected: string): boolean {
  if (!received || !expected) return false;

  // Use HMAC to normalize lengths before comparison,
  // preventing timing side-channel on token length.
  const key = "openclaw-token-cmp";
  const a = crypto.createHmac("sha256", key).update(received).digest();
  const b = crypto.createHmac("sha256", key).update(expected).digest();

  return crypto.timingSafeEqual(a, b);
}

/**
 * Check if a user ID is in the allowed list.
 * Allowlist mode must be explicit; empty lists should not match any user.
 */
export function checkUserAllowed(userId: string, allowedUserIds: string[]): boolean {
  if (allowedUserIds.length === 0) return false;
  return allowedUserIds.includes(userId);
}

/**
 * Resolve DM authorization for a sender across all DM policy modes.
 * Keeps policy semantics in one place so webhook/startup behavior stays consistent.
 */
export function authorizeUserForDm(
  userId: string,
  dmPolicy: "open" | "allowlist" | "disabled",
  allowedUserIds: string[],
): DmAuthorizationResult {
  if (dmPolicy === "disabled") {
    return { allowed: false, reason: "disabled" };
  }
  if (dmPolicy === "open") {
    return { allowed: true };
  }
  if (allowedUserIds.length === 0) {
    return { allowed: false, reason: "allowlist-empty" };
  }
  if (!checkUserAllowed(userId, allowedUserIds)) {
    return { allowed: false, reason: "not-allowlisted" };
  }
  return { allowed: true };
}

/**
 * Sanitize user input to prevent prompt injection attacks.
 * Filters known dangerous patterns and truncates long messages.
 */
export function sanitizeInput(text: string): string {
  const dangerousPatterns = [
    /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?)/gi,
    /you\s+are\s+now\s+/gi,
    /system:\s*/gi,
    /<\|.*?\|>/g, // special tokens
  ];

  let sanitized = text;
  for (const pattern of dangerousPatterns) {
    sanitized = sanitized.replace(pattern, "[FILTERED]");
  }

  const maxLength = 4000;
  if (sanitized.length > maxLength) {
    sanitized = sanitized.slice(0, maxLength) + "... [truncated]";
  }

  return sanitized;
}

/**
 * Sliding window rate limiter per user ID.
 */
export class RateLimiter {
  private requests: Map<string, number[]> = new Map();
  private limit: number;
  private windowMs: number;
  private lastCleanup = 0;
  private cleanupIntervalMs: number;

  constructor(limit = 30, windowSeconds = 60) {
    this.limit = limit;
    this.windowMs = windowSeconds * 1000;
    this.cleanupIntervalMs = this.windowMs * 5; // cleanup every 5 windows
  }

  /** Returns true if the request is allowed, false if rate-limited. */
  check(userId: string): boolean {
    const now = Date.now();
    const windowStart = now - this.windowMs;

    // Periodic cleanup of stale entries to prevent memory leak
    if (now - this.lastCleanup > this.cleanupIntervalMs) {
      this.cleanup(windowStart);
      this.lastCleanup = now;
    }

    let timestamps = this.requests.get(userId);
    if (timestamps) {
      timestamps = timestamps.filter((ts) => ts > windowStart);
    } else {
      timestamps = [];
    }

    if (timestamps.length >= this.limit) {
      this.requests.set(userId, timestamps);
      return false;
    }

    timestamps.push(now);
    this.requests.set(userId, timestamps);
    return true;
  }

  /** Remove entries with no recent activity. */
  private cleanup(windowStart: number): void {
    for (const [userId, timestamps] of this.requests) {
      const active = timestamps.filter((ts) => ts > windowStart);
      if (active.length === 0) {
        this.requests.delete(userId);
      } else {
        this.requests.set(userId, active);
      }
    }
  }
}
