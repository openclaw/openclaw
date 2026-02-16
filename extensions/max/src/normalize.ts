/**
 * MAX target ID normalization utilities.
 *
 * MAX chat IDs are numerical (similar to Telegram). Targets can be:
 * - Direct chat: numerical user ID
 * - Group chat: numerical group/chat ID
 * - Prefixed: "max:<id>" or "MAX:<id>"
 */

/** Detect if a string looks like a MAX target ID. */
export function looksLikeMaxTargetId(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) {
    return false;
  }
  // Numerical IDs (positive or negative for groups)
  if (/^-?\d+$/.test(trimmed)) {
    return true;
  }
  // Prefixed: "max:12345"
  if (/^max:/i.test(trimmed)) {
    return true;
  }
  return false;
}

/** Normalize a MAX messaging target to canonical form. */
export function normalizeMaxMessagingTarget(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  // Strip "max:" prefix
  const stripped = trimmed.replace(/^max:/i, "").trim();
  if (!stripped) {
    return undefined;
  }
  // Must be a valid numerical ID
  if (/^-?\d+$/.test(stripped)) {
    return stripped;
  }
  return undefined;
}
