/**
 * Authentication utilities for the voiceNode bridge.
 */

import crypto from "node:crypto";

/**
 * Validate a token using timing-safe comparison to prevent timing attacks.
 */
export function validateToken(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  if (provided.length !== expected.length) return false;

  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");

  return crypto.timingSafeEqual(a, b);
}
