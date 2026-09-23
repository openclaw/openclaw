import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { getTelegramRuntime } from "./runtime.js";
import {
  normalizeCachedStickerForStore,
  TELEGRAM_STICKER_CACHE_MAX_ENTRIES,
  TELEGRAM_STICKER_CACHE_NAMESPACE,
  type CachedSticker,
} from "./sticker-cache-store.legacy-state.js";

export type { CachedSticker };

type TelegramStickerCacheStore = PluginStateKeyedStore<CachedSticker>;

function openStickerCacheStore(): TelegramStickerCacheStore {
  return getTelegramRuntime().state.openKeyedStore<CachedSticker>({
    namespace: TELEGRAM_STICKER_CACHE_NAMESPACE,
    maxEntries: TELEGRAM_STICKER_CACHE_MAX_ENTRIES,
  });
}

async function readStickerCacheStore<T>(
  operation: string,
  read: (store: TelegramStickerCacheStore) => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await read(openStickerCacheStore());
  } catch (err) {
    logVerbose(`telegram sticker cache ${operation} failed: ${String(err)}`);
    return fallback;
  }
}

/**
 * Get a cached sticker by its unique ID.
 */
export async function getCachedSticker(fileUniqueId: string): Promise<CachedSticker | null> {
  return readStickerCacheStore(
    "lookup",
    async (store) => (await store.lookup(fileUniqueId)) ?? null,
    null,
  );
}

/**
 * Add or update a sticker in the cache.
 */
export async function cacheSticker(sticker: CachedSticker): Promise<void> {
  await readStickerCacheStore(
    "register",
    (store) => store.register(sticker.fileUniqueId, normalizeCachedStickerForStore(sticker)),
    undefined,
  );
}

/**
 * Search cached stickers by text query (fuzzy match on description + emoji + setName).
 */
export async function searchStickers(query: string, limit = 10): Promise<CachedSticker[]> {
  const queryLower = normalizeLowercaseStringOrEmpty(query);
  const results: Array<{ sticker: CachedSticker; score: number }> = [];

  for (const { value: sticker } of await readStickerCacheStore(
    "entries",
    (store) => store.entries(),
    [],
  )) {
    let score = 0;
    const descLower = normalizeLowercaseStringOrEmpty(sticker.description);

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
    if (normalizeLowercaseStringOrEmpty(sticker.setName).includes(queryLower)) {
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
export async function getAllCachedStickers(): Promise<CachedSticker[]> {
  return readStickerCacheStore(
    "entries",
    async (store) => (await store.entries()).map((entry) => entry.value),
    [],
  );
}

/**
 * Get cache statistics.
 */
export async function getCacheStats(): Promise<{
  count: number;
  oldestAt?: string;
  newestAt?: string;
}> {
  const stickers = await getAllCachedStickers();
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
