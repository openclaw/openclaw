/**
 * DingTalk webhook security: sign verification, rate limit, DM policy.
 * Sign: HMAC-SHA256(timestamp + "\\n" + appSecret, appSecret) then Base64.
 * @see https://open.dingtalk.com/document/robots/receive-message
 */

import * as crypto from "node:crypto";
import { createFixedWindowRateLimiter, type FixedWindowRateLimiter } from "openclaw/plugin-sdk";
import type { DingTalkDmPolicy } from "./types.js";

const MAX_TIMESTAMP_DRIFT_MS = 60 * 60 * 1000; // 1 hour

export type DmAuthorizationResult =
  | { allowed: true }
  | { allowed: false; reason: "disabled" | "allowlist-empty" | "not-allowlisted" };

/**
 * Verify DingTalk callback sign.
 * Header: timestamp (ms), sign (Base64 of HMAC-SHA256).
 * String to sign: timestamp + "\n" + appSecret.
 * Key for HMAC: appSecret.
 */
export function verifyDingTalkSign(params: {
  timestamp: string;
  sign: string;
  appSecret: string;
}): boolean {
  const { timestamp, sign, appSecret } = params;
  if (!timestamp || !sign || !appSecret) return false;
  const ts = parseInt(timestamp, 10);
  if (Number.isNaN(ts)) return false;
  const now = Date.now();
  if (Math.abs(now - ts) > MAX_TIMESTAMP_DRIFT_MS) return false;
  const stringToSign = `${timestamp}\n${appSecret}`;
  const hmac = crypto.createHmac("sha256", appSecret);
  hmac.update(stringToSign);
  const expected = hmac.digest("base64");
  try {
    return crypto.timingSafeEqual(Buffer.from(sign, "base64"), Buffer.from(expected, "base64"));
  } catch {
    return false;
  }
}

export function authorizeUserForDm(
  senderId: string,
  dmPolicy: DingTalkDmPolicy,
  allowFrom: string[],
): DmAuthorizationResult {
  if (dmPolicy === "open") return { allowed: true };
  if (dmPolicy === "allowlist" && allowFrom.length === 0) {
    return { allowed: false, reason: "allowlist-empty" };
  }
  if (dmPolicy === "allowlist" && !allowFrom.includes(senderId)) {
    return { allowed: false, reason: "not-allowlisted" };
  }
  if (dmPolicy === "pairing") {
    // Pairing: allowlist is managed by pairing store; here we only check if allowlist is used
    return { allowed: true };
  }
  return { allowed: true };
}

const rateLimiters = new Map<string, FixedWindowRateLimiter>();

export function getRateLimiter(accountId: string, limitPerMinute: number): FixedWindowRateLimiter {
  const key = `${accountId}:${limitPerMinute}`;
  let rl = rateLimiters.get(key);
  if (!rl) {
    rl = createFixedWindowRateLimiter({
      windowMs: 60_000,
      maxRequests: Math.max(1, limitPerMinute),
      maxTrackedKeys: 5000,
    });
    rateLimiters.set(key, rl);
  }
  return rl;
}

/** Returns true if request is allowed, false if rate-limited. */
export function checkRateLimit(limiter: FixedWindowRateLimiter, senderId: string): boolean {
  return !limiter.isRateLimited(senderId);
}

export function sanitizeInput(text: string): string {
  const maxLength = 4000;
  if (text.length > maxLength) {
    return text.slice(0, maxLength) + "... [truncated]";
  }
  return text;
}
