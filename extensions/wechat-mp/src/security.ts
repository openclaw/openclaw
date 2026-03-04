/**
 * WeChat MP: GET verification (signature), rate limit, DM policy.
 */

import * as crypto from "node:crypto";
import { createFixedWindowRateLimiter, type FixedWindowRateLimiter } from "openclaw/plugin-sdk";
import type { WeChatMPDmPolicy } from "./types.js";

/** Verify WeChat GET: signature = sha1(sorted([token, timestamp, nonce]).join('')). */
export function verifyWeChatMPSignature(params: {
  token: string;
  timestamp: string;
  nonce: string;
  signature: string;
}): boolean {
  const { token, timestamp, nonce, signature } = params;
  if (!token || !signature) return false;
  const arr = [token, timestamp, nonce].sort();
  const str = arr.join("");
  const hash = crypto.createHash("sha1").update(str).digest("hex");
  const sigBuf = Buffer.from(signature, "utf8");
  const hashBuf = Buffer.from(hash, "utf8");
  if (sigBuf.length !== hashBuf.length) return false;
  return crypto.timingSafeEqual(sigBuf, hashBuf);
}

export type WeChatMPDmAuthorizationResult =
  | { allowed: true }
  | { allowed: false; reason: "allowlist-empty" | "not-allowlisted" };

export function authorizeUserForWeChatMP(
  openId: string,
  dmPolicy: WeChatMPDmPolicy,
  allowFrom: string[],
): WeChatMPDmAuthorizationResult {
  if (dmPolicy === "open") return { allowed: true };
  if (dmPolicy === "allowlist" && allowFrom.length === 0) {
    return { allowed: false, reason: "allowlist-empty" };
  }
  if (dmPolicy === "allowlist" && !allowFrom.includes(openId)) {
    return { allowed: false, reason: "not-allowlisted" };
  }
  return { allowed: true };
}

const rateLimiters = new Map<string, FixedWindowRateLimiter>();

export function getWeChatMPRateLimiter(
  accountId: string,
  limitPerMinute: number,
): FixedWindowRateLimiter {
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

export function checkWeChatMPRateLimit(limiter: FixedWindowRateLimiter, openId: string): boolean {
  return !limiter.isRateLimited(openId);
}
