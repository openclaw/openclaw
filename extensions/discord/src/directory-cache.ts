import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/routing";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
  normalizeOptionalStringifiedId,
} from "openclaw/plugin-sdk/text-runtime";

const DISCORD_DIRECTORY_CACHE_MAX_ENTRIES = 4000;
const DISCORD_DISCRIMINATOR_SUFFIX = /#\d{4}$/;

const DIRECTORY_HANDLE_CACHE = new Map<string, Map<string, string>>();

function normalizeAccountCacheKey(accountId?: string | null): string {
  const normalized = normalizeAccountId(accountId ?? DEFAULT_ACCOUNT_ID);
  return normalized || DEFAULT_ACCOUNT_ID;
}

function normalizeSnowflake(value: string | number | bigint): string | null {
  const text = normalizeOptionalStringifiedId(value) ?? "";
  if (!/^\d+$/.test(text)) {
    return null;
  }
  return text;
}

function normalizeHandleKey(raw: string): string | null {
  let handle = normalizeOptionalString(raw) ?? "";
  if (!handle) {
    return null;
  }
  if (handle.startsWith("@")) {
    handle = normalizeOptionalString(handle.slice(1)) ?? "";
  }
  if (!handle || /\s/.test(handle)) {
    return null;
  }
  return normalizeLowercaseStringOrEmpty(handle);
}

function ensureAccountCache(accountId?: string | null): Map<string, string> {
  const cacheKey = normalizeAccountCacheKey(accountId);
  const existing = DIRECTORY_HANDLE_CACHE.get(cacheKey);
  if (existing) {
    return existing;
  }
  const created = new Map<string, string>();
  DIRECTORY_HANDLE_CACHE.set(cacheKey, created);
  return created;
}

function setCacheEntry(cache: Map<string, string>, key: string, userId: string): void {
  if (cache.has(key)) {
    cache.delete(key);
  }
  cache.set(key, userId);
  if (cache.size <= DISCORD_DIRECTORY_CACHE_MAX_ENTRIES) {
    return;
  }
  const oldest = cache.keys().next();
  if (!oldest.done) {
    cache.delete(oldest.value);
  }
}

export function rememberDiscordDirectoryUser(params: {
  accountId?: string | null;
  userId: string | number | bigint;
  handles: Array<string | null | undefined>;
}): void {
  const userId = normalizeSnowflake(params.userId);
  if (!userId) {
    return;
  }
  const cache = ensureAccountCache(params.accountId);
  for (const candidate of params.handles) {
    if (typeof candidate !== "string") {
      continue;
    }
    const handle = normalizeHandleKey(candidate);
    if (!handle) {
      continue;
    }
    setCacheEntry(cache, handle, userId);
    const withoutDiscriminator = handle.replace(DISCORD_DISCRIMINATOR_SUFFIX, "");
    if (withoutDiscriminator && withoutDiscriminator !== handle) {
      setCacheEntry(cache, withoutDiscriminator, userId);
    }
  }
}

export function resolveDiscordDirectoryUserId(params: {
  accountId?: string | null;
  handle: string;
}): string | undefined {
  const handle = normalizeHandleKey(params.handle);
  if (!handle) {
    return undefined;
  }
  const withoutDiscriminator = handle.replace(DISCORD_DISCRIMINATOR_SUFFIX, "");
  const altHandle =
    withoutDiscriminator && withoutDiscriminator !== handle ? withoutDiscriminator : null;

  // First: check the account-specific sub-map.
  const cache = DIRECTORY_HANDLE_CACHE.get(normalizeAccountCacheKey(params.accountId));
  if (cache) {
    const direct = cache.get(handle);
    if (direct) {
      return direct;
    }
    if (altHandle) {
      const alt = cache.get(altHandle);
      if (alt) {
        return alt;
      }
    }
  }

  // Fallback: check ALL account sub-maps. In a multi-bot gateway where all
  // bots run in the same process, another account's preflight may have already
  // cached the target handle. This cross-account fallback enables bot→bot
  // @mention rewriting even when the sending bot hasn't directly processed a
  // message from the target user.
  const ownKey = normalizeAccountCacheKey(params.accountId);
  for (const [key, subMap] of DIRECTORY_HANDLE_CACHE) {
    if (key === ownKey) {
      continue;
    }
    const found = subMap.get(handle) ?? (altHandle ? subMap.get(altHandle) : undefined);
    if (found) {
      return found;
    }
  }

  return undefined;
}

export function __resetDiscordDirectoryCacheForTest(): void {
  DIRECTORY_HANDLE_CACHE.clear();
}
