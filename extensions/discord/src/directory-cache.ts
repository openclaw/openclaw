import { normalizeAccountId } from "openclaw/plugin-sdk/routing";
import {
  normalizeOptionalString,
  normalizeOptionalStringifiedId,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { discordDirectoryCacheState } from "./directory-cache-state.js";

const DISCORD_DIRECTORY_CACHE_MAX_ENTRIES = 4000;
const DISCORD_DISCRIMINATOR_SUFFIX = /#\d{4}$/;

export function normalizeDiscordSnowflake(value: string | number | bigint): string | null {
  const text = normalizeOptionalStringifiedId(value) ?? "";
  if (!/^\d+$/.test(text)) {
    return null;
  }
  return text;
}

export function normalizeDiscordHandleKey(raw: string): string | null {
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
  return handle.toLowerCase();
}

function ensureAccountCache(accountId?: string | null): Map<string, string> {
  const cacheKey = normalizeAccountId(accountId);
  const existing = discordDirectoryCacheState.handlesByAccount.get(cacheKey);
  if (existing) {
    return existing;
  }
  const created = new Map<string, string>();
  discordDirectoryCacheState.handlesByAccount.set(cacheKey, created);
  return created;
}

function setCacheEntry(cache: Map<string, string>, key: string, userId: string): void {
  cache.delete(key);
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
  const userId = normalizeDiscordSnowflake(params.userId);
  if (!userId) {
    return;
  }
  const cache = ensureAccountCache(params.accountId);
  for (const candidate of params.handles) {
    if (typeof candidate !== "string") {
      continue;
    }
    const handle = normalizeDiscordHandleKey(candidate);
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
  const cache = discordDirectoryCacheState.handlesByAccount.get(
    normalizeAccountId(params.accountId),
  );
  if (!cache) {
    return undefined;
  }
  const handle = normalizeDiscordHandleKey(params.handle);
  if (!handle) {
    return undefined;
  }
  const direct = cache.get(handle);
  if (direct) {
    return direct;
  }
  const withoutDiscriminator = handle.replace(DISCORD_DISCRIMINATOR_SUFFIX, "");
  if (!withoutDiscriminator || withoutDiscriminator === handle) {
    return undefined;
  }
  return cache.get(withoutDiscriminator);
}
