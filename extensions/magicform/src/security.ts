/**
 * Security module: token validation, rate limiting, input sanitization, allowlist.
 */

import * as crypto from "node:crypto";
import {
  createFixedWindowRateLimiter,
  type FixedWindowRateLimiter,
} from "openclaw/plugin-sdk/magicform";

export type AuthorizationResult =
  | { allowed: true }
  | { allowed: false; reason: "disabled" | "not-allowlisted" };

/**
 * Validate webhook token using constant-time comparison.
 * Prevents timing attacks that could leak token bytes.
 */
export function validateToken(received: string, expected: string): boolean {
  if (!received || !expected) return false;

  const key = "openclaw-token-cmp";
  const a = crypto.createHmac("sha256", key).update(received).digest();
  const b = crypto.createHmac("sha256", key).update(expected).digest();

  return crypto.timingSafeEqual(a, b);
}

/**
 * Check if a stack ID is in the allow_from list.
 * Empty allowFrom means allow all.
 */
export function authorizeStackId(
  stackId: string,
  allowFrom: string[],
): AuthorizationResult {
  if (allowFrom.length === 0) {
    return { allowed: true };
  }
  if (allowFrom.includes(stackId)) {
    return { allowed: true };
  }
  return { allowed: false, reason: "not-allowlisted" };
}

/**
 * Sanitize user input to prevent prompt injection attacks.
 */
export function sanitizeInput(text: string): string {
  const dangerousPatterns = [
    /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?)/gi,
    /you\s+are\s+now\s+/gi,
    /system:\s*/gi,
    /<\|.*?\|>/g,
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
 * Fixed window rate limiter per key.
 */
export class RateLimiter {
  private readonly limiter: FixedWindowRateLimiter;
  private readonly limit: number;

  constructor(limit = 60, windowSeconds = 60, maxTrackedKeys = 10_000) {
    this.limit = limit;
    this.limiter = createFixedWindowRateLimiter({
      windowMs: Math.max(1, Math.floor(windowSeconds * 1000)),
      maxRequests: Math.max(1, Math.floor(limit)),
      maxTrackedKeys: Math.max(1, Math.floor(maxTrackedKeys)),
    });
  }

  check(key: string): boolean {
    return !this.limiter.isRateLimited(key);
  }

  size(): number {
    return this.limiter.size();
  }

  clear(): void {
    this.limiter.clear();
  }

  maxRequests(): number {
    return this.limit;
  }
}
