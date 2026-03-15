import { normalizeE164 } from "openclaw/plugin-sdk/twilio-sms";

/**
 * Normalize a phone number target for Twilio SMS.
 * Delegates to E.164 normalization.
 */
export function normalizeTwilioSmsTarget(raw: string): string {
  return normalizeE164(raw);
}

/**
 * Check if a raw string looks like a valid Twilio SMS target (phone number).
 */
export function looksLikeTwilioSmsTargetId(raw: string): boolean {
  const trimmed = raw.trim();
  return /^\+?[1-9]\d{1,14}$/.test(trimmed);
}

/**
 * Normalize an allowlist entry for Twilio SMS.
 * Strips the optional `twilio-sms:` prefix and normalizes to E.164.
 */
export function normalizeTwilioSmsAllowEntry(entry: string): string {
  return normalizeE164(entry.replace(/^twilio-sms:/i, ""));
}
