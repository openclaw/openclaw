/**
 * Anthropic billing attribution header for OAuth (subscription) providers.
 *
 * When using the anthropic-subscription provider (OAuth token), Anthropic's
 * backend needs a billing attribution header in the system prompt to route
 * usage to plan quota instead of extra usage billing. Without this, OAuth
 * requests are billed as "extra usage" at API rates.
 *
 * The attribution header must appear as its own line/block in the system
 * prompt, starting with "x-anthropic-billing-header:".
 */

import { createHash } from "node:crypto";

/**
 * Hardcoded salt — must match the server-side validation.
 */
const FINGERPRINT_SALT = "59cf53e54c78";

/**
 * Computes a 3-character fingerprint for attribution.
 * Algorithm: SHA256(SALT + msg[4] + msg[7] + msg[20] + version)[:3]
 */
function computeFingerprint(messageText: string, version: string): string {
  const indices = [4, 7, 20];
  const chars = indices.map((i) => messageText[i] || "0").join("");
  const input = `${FINGERPRINT_SALT}${chars}${version}`;
  const hash = createHash("sha256").update(input).digest("hex");
  return hash.slice(0, 3);
}

/**
 * Build the attribution header line for the system prompt.
 *
 * @param firstUserMessage - Text of the first user message (for fingerprinting)
 * @param version - Claude Code version string
 * @returns Attribution header string, or empty string if inputs are missing
 */
export function getAttributionHeader(firstUserMessage: string, version: string): string {
  const fingerprint = computeFingerprint(firstUserMessage, version);
  return `x-anthropic-billing-header: cc_version=${version}.${fingerprint}; cc_entrypoint=cli;`;
}
