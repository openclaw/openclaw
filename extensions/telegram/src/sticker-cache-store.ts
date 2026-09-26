import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { getTelegramRuntime } from "./runtime.js";

const TELEGRAM_STICKER_CACHE_NAMESPACE = "telegram.sticker-cache";
const TELEGRAM_STICKER_CACHE_MAX_ENTRIES = 10_000;

export interface CachedSticker {
  fileId: string;
  fileUniqueId: string;
  emoji?: string;
  setName?: string;
  description: string;
  cachedAt: string;
  receivedFrom?: string;
}

type TelegramStickerCacheStore = PluginStateKeyedStore<CachedSticker>;

function normalizeCachedStickerForStore(sticker: CachedSticker): CachedSticker {
  return {
    fileId: sticker.fileId,
    fileUniqueId: sticker.fileUniqueId,
    description: sticker.description,
    cachedAt: sticker.cachedAt,
    ...(sticker.emoji !== undefined ? { emoji: sticker.emoji } : {}),
    ...(sticker.setName !== undefined ? { setName: sticker.setName } : {}),
    ...(sticker.receivedFrom !== undefined ? { receivedFrom: sticker.receivedFrom } : {}),
  };
}

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

export async function getCachedSticker(fileUniqueId: string): Promise<CachedSticker | null> {
  return readStickerCacheStore(
    "lookup",
    async (store) => (await store.lookup(fileUniqueId)) ?? null,
    null,
  );
}

export async function cacheSticker(sticker: CachedSticker): Promise<void> {
  await readStickerCacheStore(
    "register",
    (store) => store.register(sticker.fileUniqueId, normalizeCachedStickerForStore(sticker)),
    undefined,
  );
}

export async function searchStickers(query: string, limit = 10): Promise<CachedSticker[]> {
  const queryLower = normalizeLowercaseStringOrEmpty(query);
  const queryWords = queryLower.split(/\s+/).filter(Boolean);
  const results: Array<{ sticker: CachedSticker; score: number }> = [];

  for (const { value: sticker } of await readStickerCacheStore(
    "entries",
    (store) => store.entries(),
    [],
  )) {
    let score = 0;
    const descLower = normalizeLowercaseStringOrEmpty(sticker.description);

    if (descLower.includes(queryLower)) {
      score += 10;
    }

    const descWords = descLower.split(/\s+/);
    for (const qWord of queryWords) {
      if (descWords.some((dWord) => dWord.includes(qWord))) {
        score += 5;
      }
    }

    if (sticker.emoji && query.includes(sticker.emoji)) {
      score += 8;
    }

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

export async function getAllCachedStickers(): Promise<CachedSticker[]> {
  return readStickerCacheStore(
    "entries",
    async (store) => (await store.entries()).map((entry) => entry.value),
    [],
  );
}

export async function getCacheStats(): Promise<{
  count: number;
  oldestAt?: string;
  newestAt?: string;
}> {
  const stickers = await getAllCachedStickers();
  if (stickers.length === 0) {
    return { count: 0 };
  }
  const sorted = stickers.toSorted(
    (a, b) => new Date(a.cachedAt).getTime() - new Date(b.cachedAt).getTime(),
  );
  return {
    count: stickers.length,
    oldestAt: sorted[0]?.cachedAt,
    newestAt: sorted[sorted.length - 1]?.cachedAt,
  };
}
