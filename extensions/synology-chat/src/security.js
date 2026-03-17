import * as crypto from "node:crypto";
import {
  createFixedWindowRateLimiter
} from "openclaw/plugin-sdk/synology-chat";
function validateToken(received, expected) {
  if (!received || !expected) return false;
  const key = "openclaw-token-cmp";
  const a = crypto.createHmac("sha256", key).update(received).digest();
  const b = crypto.createHmac("sha256", key).update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}
function checkUserAllowed(userId, allowedUserIds) {
  if (allowedUserIds.length === 0) return false;
  return allowedUserIds.includes(userId);
}
function authorizeUserForDm(userId, dmPolicy, allowedUserIds) {
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
function sanitizeInput(text) {
  const dangerousPatterns = [
    /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?)/gi,
    /you\s+are\s+now\s+/gi,
    /system:\s*/gi,
    /<\|.*?\|>/g
    // special tokens
  ];
  let sanitized = text;
  for (const pattern of dangerousPatterns) {
    sanitized = sanitized.replace(pattern, "[FILTERED]");
  }
  const maxLength = 4e3;
  if (sanitized.length > maxLength) {
    sanitized = sanitized.slice(0, maxLength) + "... [truncated]";
  }
  return sanitized;
}
class RateLimiter {
  constructor(limit = 30, windowSeconds = 60, maxTrackedUsers = 5e3) {
    this.limit = limit;
    this.limiter = createFixedWindowRateLimiter({
      windowMs: Math.max(1, Math.floor(windowSeconds * 1e3)),
      maxRequests: Math.max(1, Math.floor(limit)),
      maxTrackedKeys: Math.max(1, Math.floor(maxTrackedUsers))
    });
  }
  /** Returns true if the request is allowed, false if rate-limited. */
  check(userId) {
    return !this.limiter.isRateLimited(userId);
  }
  /** Exposed for tests and diagnostics. */
  size() {
    return this.limiter.size();
  }
  /** Exposed for tests and account lifecycle cleanup. */
  clear() {
    this.limiter.clear();
  }
  /** Exposed for tests. */
  maxRequests() {
    return this.limit;
  }
}
export {
  RateLimiter,
  authorizeUserForDm,
  checkUserAllowed,
  sanitizeInput,
  validateToken
};
