// Telegram plugin module caches resolved reply media by file id.
import { existsSync } from "node:fs";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import type { TelegramMediaKind } from "./bot/helpers.js";
import { getTelegramRuntime } from "./runtime.js";

export const TELEGRAM_REPLY_MEDIA_CACHE_NAMESPACE = "telegram.reply-media-cache";
export const TELEGRAM_REPLY_MEDIA_CACHE_MAX_ENTRIES = 2_000;

export type CachedReplyMedia = {
  fileId: string;
  path: string;
  kind: TelegramMediaKind;
  contentType?: string;
  cachedAt: string;
};

type TelegramReplyMediaCacheStore = PluginStateSyncKeyedStore<CachedReplyMedia>;

function openReplyMediaCacheStore(): TelegramReplyMediaCacheStore {
  return getTelegramRuntime().state.openSyncKeyedStore<CachedReplyMedia>({
    namespace: TELEGRAM_REPLY_MEDIA_CACHE_NAMESPACE,
    maxEntries: TELEGRAM_REPLY_MEDIA_CACHE_MAX_ENTRIES,
  });
}

function readReplyMediaCacheStore<T>(
  operation: string,
  read: (store: TelegramReplyMediaCacheStore) => T,
  fallback: T,
): T {
  try {
    return read(openReplyMediaCacheStore());
  } catch (err) {
    logVerbose(`telegram reply media cache ${operation} failed: ${String(err)}`);
    return fallback;
  }
}

function cacheKey(accountId: string, fileId: string): string {
  return `${accountId}:${fileId}`;
}

/**
 * Resolved media for an already-downloaded quoted file, or null.
 *
 * A Telegram file id maps to immutable content, so the only way a hit goes bad
 * is the saved file being reclaimed. Misses on a reclaimed path rather than
 * handing back a dangling reference, and the caller re-downloads.
 */
export function readCachedReplyMedia(params: {
  accountId: string;
  fileId: string;
}): CachedReplyMedia | null {
  const entry = readReplyMediaCacheStore(
    "lookup",
    (store) => store.lookup(cacheKey(params.accountId, params.fileId)) ?? null,
    null,
  );
  if (!entry) {
    return null;
  }
  if (!existsSync(entry.path)) {
    logVerbose(`telegram reply media cache: dropping reclaimed path for ${params.fileId}`);
    return null;
  }
  return entry;
}

/** Records a successful reply-media download for reuse by later quotes. */
export function rememberReplyMedia(params: {
  accountId: string;
  fileId: string;
  path: string;
  kind: TelegramMediaKind;
  contentType?: string;
  cachedAt: string;
}): void {
  readReplyMediaCacheStore(
    "register",
    (store) => {
      store.register(cacheKey(params.accountId, params.fileId), {
        fileId: params.fileId,
        path: params.path,
        kind: params.kind,
        cachedAt: params.cachedAt,
        ...(params.contentType !== undefined ? { contentType: params.contentType } : {}),
      });
    },
    undefined,
  );
}
