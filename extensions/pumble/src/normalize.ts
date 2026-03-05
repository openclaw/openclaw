/**
 * Target normalization for Pumble messaging.
 *
 * Supported formats:
 * - "channel:ID"   → post to channel by ID
 * - "user:ID"      → DM by user ID
 * - "pumble:ID"    → alias for user:ID
 * - "#channel"     → post to channel (resolve name → ID)
 * - "user@email"   → DM by email
 * - plain ID       → treated as channel:ID
 */
export function normalizePumbleMessagingTarget(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("channel:")) {
    return trimmed;
  }
  if (lower.startsWith("user:")) {
    return trimmed;
  }
  if (lower.startsWith("pumble:")) {
    return `user:${trimmed.slice("pumble:".length).trim()}`;
  }
  if (trimmed.startsWith("#")) {
    const name = trimmed.slice(1).trim();
    return name ? `channel:${name}` : undefined;
  }
  if (trimmed.includes("@")) {
    return `user:${trimmed}`;
  }
  return `channel:${trimmed}`;
}

export function looksLikePumbleTargetId(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) {
    return false;
  }
  const lower = trimmed.toLowerCase();
  if (lower.startsWith("user:") || lower.startsWith("channel:") || lower.startsWith("pumble:")) {
    return true;
  }
  if (trimmed.startsWith("#")) {
    return true;
  }
  if (trimmed.includes("@")) {
    return true;
  }
  // Plain alphanumeric ID (8+ chars)
  return /^[a-zA-Z0-9]{8,}$/.test(trimmed);
}
