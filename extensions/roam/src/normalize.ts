/** Strip known channel prefixes from a Roam target identifier. */
export function stripRoamTargetPrefix(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }

  let normalized = trimmed;

  const lower = normalized.toLowerCase();
  if (lower.startsWith("roam:")) {
    normalized = normalized.slice("roam:".length).trim();
  } else if (lower.startsWith("roam-hq:")) {
    normalized = normalized.slice("roam-hq:".length).trim();
  }

  // Strip sub-prefixes for target kind (case-insensitive)
  const subLower = normalized.toLowerCase();
  if (subLower.startsWith("group:")) {
    normalized = normalized.slice("group:".length).trim();
  } else if (subLower.startsWith("dm:")) {
    normalized = normalized.slice("dm:".length).trim();
  } else if (subLower.startsWith("user:")) {
    normalized = normalized.slice("user:".length).trim();
  }

  if (!normalized) {
    return undefined;
  }

  return normalized;
}

/** Normalize a raw target into the canonical "roam:<id>" format. */
export function normalizeRoamMessagingTarget(raw: string): string | undefined {
  const normalized = stripRoamTargetPrefix(raw);
  return normalized ? `roam:${normalized}` : undefined;
}

/** Check if a raw string looks like a Roam target identifier. */
export function looksLikeRoamTargetId(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) {
    return false;
  }

  if (/^(roam|roam-hq):/i.test(trimmed)) {
    return true;
  }

  // Bare UUID pattern
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed);
}
