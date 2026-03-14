const MIN_DUPLICATE_TEXT_LENGTH = 10;

/**
 * Maximum number of recent delivered text hashes to retain for cross-turn
 * deduplication.  Keeps memory bounded while covering the typical window
 * where context compaction may cause the model to re-emit a previous reply.
 */
const RECENT_DELIVERED_MAX = 20;

/**
 * TTL for entries in the cross-turn dedup cache (1 hour).
 * After this period the entry is evicted and the same text can be delivered
 * again (which is desirable for intentionally repeated content).
 */
const RECENT_DELIVERED_TTL_MS = 60 * 60_000;

export type RecentDeliveredEntry = {
  hash: string;
  timestamp: number;
};

/**
 * Build a collision-resistant hash from the full normalised text of a
 * delivered assistant message.  Uses a fast non-cryptographic approach:
 * the first 200 normalised chars (for quick prefix screening) combined
 * with the total length and a simple 32-bit numeric hash of the full
 * string.  This avoids false positives when two responses share the same
 * opening paragraph but diverge later.
 */
export function buildDeliveredTextHash(text: string): string {
  const normalized = normalizeTextForComparison(text);
  if (normalized.length <= 200) {
    return normalized;
  }
  // 32-bit FNV-1a-inspired hash (Math.imul + >>> 0 operate on 32-bit integers).
  let h = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i++) {
    h ^= normalized.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // Combine prefix + length + full-text hash for uniqueness.
  return `${normalized.slice(0, 200)}|${normalized.length}|${(h >>> 0).toString(36)}`;
}

/**
 * Check whether `text` was recently delivered (cross-turn).
 */
export function isRecentlyDelivered(
  text: string,
  recentDelivered: RecentDeliveredEntry[],
  now?: number,
): boolean {
  const hash = buildDeliveredTextHash(text);
  if (!hash || hash.length < MIN_DUPLICATE_TEXT_LENGTH) {
    return false;
  }
  const currentTime = now ?? Date.now();
  return recentDelivered.some(
    (entry) => currentTime - entry.timestamp < RECENT_DELIVERED_TTL_MS && entry.hash === hash,
  );
}

/**
 * Record a delivered text in the rolling cache.
 */
export function recordDeliveredText(
  text: string,
  recentDelivered: RecentDeliveredEntry[],
  now?: number,
): void {
  const hash = buildDeliveredTextHash(text);
  if (!hash || hash.length < MIN_DUPLICATE_TEXT_LENGTH) {
    return;
  }
  const currentTime = now ?? Date.now();
  // Evict expired entries.
  for (let i = recentDelivered.length - 1; i >= 0; i--) {
    if (currentTime - recentDelivered[i].timestamp >= RECENT_DELIVERED_TTL_MS) {
      recentDelivered.splice(i, 1);
    }
  }
  // Avoid duplicate entries for the same hash.
  const existing = recentDelivered.findIndex((e) => e.hash === hash);
  if (existing >= 0) {
    recentDelivered[existing].timestamp = currentTime;
    return;
  }
  recentDelivered.push({ hash, timestamp: currentTime });
  // Trim oldest if over capacity.
  while (recentDelivered.length > RECENT_DELIVERED_MAX) {
    recentDelivered.shift();
  }
}

/**
 * Normalize text for duplicate comparison.
 * - Trims whitespace
 * - Lowercases
 * - Strips emoji (Emoji_Presentation and Extended_Pictographic)
 * - Collapses multiple spaces to single space
 */
export function normalizeTextForComparison(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\p{Emoji_Presentation}|\p{Extended_Pictographic}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function isMessagingToolDuplicateNormalized(
  normalized: string,
  normalizedSentTexts: string[],
): boolean {
  if (normalizedSentTexts.length === 0) {
    return false;
  }
  if (!normalized || normalized.length < MIN_DUPLICATE_TEXT_LENGTH) {
    return false;
  }
  return normalizedSentTexts.some((normalizedSent) => {
    if (!normalizedSent || normalizedSent.length < MIN_DUPLICATE_TEXT_LENGTH) {
      return false;
    }
    return normalized.includes(normalizedSent) || normalizedSent.includes(normalized);
  });
}

export function isMessagingToolDuplicate(text: string, sentTexts: string[]): boolean {
  if (sentTexts.length === 0) {
    return false;
  }
  const normalized = normalizeTextForComparison(text);
  if (!normalized || normalized.length < MIN_DUPLICATE_TEXT_LENGTH) {
    return false;
  }
  return isMessagingToolDuplicateNormalized(normalized, sentTexts.map(normalizeTextForComparison));
}
