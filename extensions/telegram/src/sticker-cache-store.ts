import { createPluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";

const STICKER_CACHE_STORE = createPluginStateSyncKeyedStore<CachedSticker>("telegram", {
  namespace: "sticker-cache",
  maxEntries: 10_000,
});

export interface CachedSticker {
  fileId: string;
  fileUniqueId: string;
  emoji?: string;
  setName?: string;
  description: string;
  cachedAt: string;
  receivedFrom?: string;
}

function normalizeStickerSearchText(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/**
 * Get a cached sticker by its unique ID.
 */
export function getCachedSticker(fileUniqueId: string): CachedSticker | null {
  return STICKER_CACHE_STORE.lookup(fileUniqueId) ?? null;
}

/**
 * Add or update a sticker in the cache.
 */
export function cacheSticker(sticker: CachedSticker): void {
  STICKER_CACHE_STORE.register(sticker.fileUniqueId, sticker);
}

/**
 * Search cached stickers by text query (fuzzy match on description + emoji + setName).
 */
export function searchStickers(query: string, limit = 10): CachedSticker[] {
  const queryLower = normalizeStickerSearchText(query);
  const results: Array<{ sticker: CachedSticker; score: number }> = [];

  for (const { value: sticker } of STICKER_CACHE_STORE.entries()) {
    let score = 0;
    const descLower = normalizeStickerSearchText(sticker.description);

    // Exact substring match in description
    if (descLower.includes(queryLower)) {
      score += 10;
    }

    // Word-level matching
    const queryWords = queryLower.split(/\s+/).filter(Boolean);
    const descWords = descLower.split(/\s+/);
    for (const qWord of queryWords) {
      if (descWords.some((dWord) => dWord.includes(qWord))) {
        score += 5;
      }
    }

    // Emoji match
    if (sticker.emoji && query.includes(sticker.emoji)) {
      score += 8;
    }

    // Set name match
    if (normalizeStickerSearchText(sticker.setName).includes(queryLower)) {
      score += 3;
    }

    if (score > 0) {
      results.push({ sticker, score });
    }
  }

  return results
    .toSorted((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => r.sticker);
}

/**
 * Get all cached stickers (for debugging/listing).
 */
export function getAllCachedStickers(): CachedSticker[] {
  return STICKER_CACHE_STORE.entries().map((entry) => entry.value);
}

/**
 * Get cache statistics.
 */
export function getCacheStats(): { count: number; oldestAt?: string; newestAt?: string } {
  const stickers = getAllCachedStickers();
  if (stickers.length === 0) {
    return { count: 0 };
  }
  const sorted = [...stickers].toSorted(
    (a, b) => new Date(a.cachedAt).getTime() - new Date(b.cachedAt).getTime(),
  );
  return {
    count: stickers.length,
    oldestAt: sorted[0]?.cachedAt,
    newestAt: sorted[sorted.length - 1]?.cachedAt,
  };
}

export function resetTelegramStickerCacheForTests(): void {
  STICKER_CACHE_STORE.clear();
}
