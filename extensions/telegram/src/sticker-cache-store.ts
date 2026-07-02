// Telegram plugin module implements sticker cache store behavior.
import path from "node:path";
import { loadJsonFile } from "openclaw/plugin-sdk/json-store";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { getTelegramRuntime } from "./runtime.js";

const CACHE_VERSION = 2;
const STICKER_DESCRIPTION_POLICY = "memory-disabled";
export const TELEGRAM_STICKER_CACHE_NAMESPACE = "telegram.sticker-cache";
export const TELEGRAM_STICKER_CACHE_MAX_ENTRIES = 10_000;

export interface CachedSticker {
  fileId: string;
  fileUniqueId: string;
  emoji?: string;
  setName?: string;
  description: string;
  cachedAt: string;
  receivedFrom?: string;
}

export type StickerDescriptionPolicy = typeof STICKER_DESCRIPTION_POLICY;

export type CachedStickerStoreEntry = CachedSticker & {
  descriptionPolicy?: StickerDescriptionPolicy;
};

interface StickerCache {
  version: number;
  stickers: Record<string, CachedStickerStoreEntry>;
}

type TelegramStickerCacheStore = PluginStateSyncKeyedStore<CachedStickerStoreEntry>;

let stickerCacheStoreForTest: TelegramStickerCacheStore | undefined;

function getCacheFile(): string {
  return path.join(resolveStateDir(), "telegram", "sticker-cache.json");
}

function openStickerCacheStore(): TelegramStickerCacheStore {
  return (
    stickerCacheStoreForTest ??
    getTelegramRuntime().state.openSyncKeyedStore<CachedStickerStoreEntry>({
      namespace: TELEGRAM_STICKER_CACHE_NAMESPACE,
      maxEntries: TELEGRAM_STICKER_CACHE_MAX_ENTRIES,
    })
  );
}

function loadCache(): StickerCache {
  return loadCacheFile(getCacheFile());
}

function normalizeStickerSearchText(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function normalizeCachedStickerForStore(sticker: CachedSticker): CachedStickerStoreEntry {
  return {
    fileId: sticker.fileId,
    fileUniqueId: sticker.fileUniqueId,
    description: sticker.description,
    cachedAt: sticker.cachedAt,
    descriptionPolicy: STICKER_DESCRIPTION_POLICY,
    ...(sticker.emoji !== undefined ? { emoji: sticker.emoji } : {}),
    ...(sticker.setName !== undefined ? { setName: sticker.setName } : {}),
    ...(sticker.receivedFrom !== undefined ? { receivedFrom: sticker.receivedFrom } : {}),
  };
}

function normalizeCurrentCachedStickerStoreEntry(
  sticker: CachedStickerStoreEntry | undefined,
): CachedStickerStoreEntry | null {
  if (!sticker || sticker.descriptionPolicy !== STICKER_DESCRIPTION_POLICY) {
    return null;
  }
  return normalizeCachedStickerForStore(sticker);
}

function normalizeCachedStickerForRead(
  sticker: CachedStickerStoreEntry | undefined,
): CachedSticker | null {
  const current = normalizeCurrentCachedStickerStoreEntry(sticker);
  if (!current) {
    return null;
  }
  return {
    fileId: current.fileId,
    fileUniqueId: current.fileUniqueId,
    description: current.description,
    cachedAt: current.cachedAt,
    ...(current.emoji !== undefined ? { emoji: current.emoji } : {}),
    ...(current.setName !== undefined ? { setName: current.setName } : {}),
    ...(current.receivedFrom !== undefined ? { receivedFrom: current.receivedFrom } : {}),
  };
}

function readStickerCacheStore<T>(
  operation: string,
  read: (store: TelegramStickerCacheStore) => T,
  fallback: T,
): T {
  try {
    return read(openStickerCacheStore());
  } catch (err) {
    logVerbose(`telegram sticker cache ${operation} failed: ${String(err)}`);
    return fallback;
  }
}

/**
 * Get a cached sticker by its unique ID.
 */
export function getCachedSticker(fileUniqueId: string): CachedSticker | null {
  return readStickerCacheStore(
    "lookup",
    (store) => normalizeCachedStickerForRead(store.lookup(fileUniqueId)),
    null,
  );
}

/**
 * Add or update a sticker in the cache.
 */
export function cacheSticker(sticker: CachedSticker): void {
  readStickerCacheStore(
    "register",
    (store) => {
      store.register(sticker.fileUniqueId, normalizeCachedStickerForStore(sticker));
    },
    undefined,
  );
}

/**
 * Search cached stickers by text query (fuzzy match on description + emoji + setName).
 */
export function searchStickers(query: string, limit = 10): CachedSticker[] {
  const queryLower = normalizeStickerSearchText(query);
  const results: Array<{ sticker: CachedSticker; score: number }> = [];

  for (const sticker of readStickerCacheStore(
    "entries",
    (store) =>
      store
        .entries()
        .map((entry) => normalizeCachedStickerForRead(entry.value))
        .filter((entry): entry is CachedSticker => entry !== null),
    [],
  )) {
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
  return readStickerCacheStore(
    "entries",
    (store) =>
      store
        .entries()
        .map((entry) => normalizeCachedStickerForRead(entry.value))
        .filter((entry): entry is CachedSticker => entry !== null),
    [],
  );
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

export function setTelegramStickerCacheStoreForTest(
  store: TelegramStickerCacheStore | undefined,
): void {
  stickerCacheStoreForTest = store;
}

export function clearTelegramStickerCacheForTest(): void {
  openStickerCacheStore().clear();
}

export function listTelegramLegacyStickerCacheEntries(
  params: {
    persistedPath?: string;
  } = {},
): Array<{ key: string; value: CachedStickerStoreEntry }> {
  const cache = params.persistedPath ? loadCacheFile(params.persistedPath) : loadCache();
  return Object.entries(cache.stickers).flatMap(([key, value]) => {
    const sticker = normalizeCurrentCachedStickerStoreEntry(value);
    return sticker ? [{ key, value: sticker }] : [];
  });
}

function loadCacheFile(filePath: string): StickerCache {
  const data = loadJsonFile(filePath);
  if (!data || typeof data !== "object") {
    return { version: CACHE_VERSION, stickers: {} };
  }
  const cache = data as StickerCache;
  if (cache.version !== CACHE_VERSION) {
    return { version: CACHE_VERSION, stickers: {} };
  }
  return cache;
}
