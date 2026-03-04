/**
 * QQ Bot callback security: Ed25519 signature verification.
 * Public/private key derived from clientSecret (repeat to 32 bytes = Ed25519 seed).
 * @see https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/sign.html
 */

import { getPublicKeyAsync, signAsync, verifyAsync } from "@noble/ed25519";
import { createFixedWindowRateLimiter, type FixedWindowRateLimiter } from "openclaw/plugin-sdk";
import type { QQDmPolicy } from "./types.js";

const ED25519_SEED_SIZE = 32;

function repeatToSeed(secret: string): Uint8Array {
  let s = secret;
  while (s.length < ED25519_SEED_SIZE) {
    s += s;
  }
  return new TextEncoder().encode(s.slice(0, ED25519_SEED_SIZE));
}

/** Verify QQ callback: message = timestamp + body, signature from X-Signature-Ed25519 (hex). */
export async function verifyQQSignature(params: {
  timestamp: string;
  body: string;
  signatureHex: string;
  clientSecret: string;
}): Promise<boolean> {
  const { timestamp, body, signatureHex, clientSecret } = params;
  if (!timestamp || !signatureHex || !clientSecret) return false;
  const sig = hexDecode(signatureHex);
  if (sig.length !== 64) return false;
  const message = new TextEncoder().encode(timestamp + body);
  const seed = repeatToSeed(clientSecret);
  const publicKey = await getPublicKeyAsync(seed);
  return verifyAsync(sig, message, publicKey);
}

/** Sign for QQ callback verification response (op=13). */
export async function signQQVerification(
  plainToken: string,
  clientSecret: string,
): Promise<string> {
  const seed = repeatToSeed(clientSecret);
  const message = new TextEncoder().encode(plainToken);
  const sig = await signAsync(message, seed);
  return hexEncode(sig);
}

function hexDecode(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function hexEncode(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export type QQDmAuthorizationResult =
  | { allowed: true }
  | { allowed: false; reason: "allowlist-empty" | "not-allowlisted" };

export function authorizeUserForQQ(
  senderId: string,
  dmPolicy: QQDmPolicy,
  allowFrom: string[],
): QQDmAuthorizationResult {
  if (dmPolicy === "open") return { allowed: true };
  if (dmPolicy === "allowlist" && allowFrom.length === 0) {
    return { allowed: false, reason: "allowlist-empty" };
  }
  if (dmPolicy === "allowlist" && !allowFrom.includes(senderId)) {
    return { allowed: false, reason: "not-allowlisted" };
  }
  return { allowed: true };
}

const rateLimiters = new Map<string, FixedWindowRateLimiter>();

export function getQQRateLimiter(
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

export function checkQQRateLimit(limiter: FixedWindowRateLimiter, senderId: string): boolean {
  return !limiter.isRateLimited(senderId);
}
