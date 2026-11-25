import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
import { normalizeAccountId } from "openclaw/plugin-sdk/routing";
import { discordDirectoryCacheState } from "./directory-cache-state.js";
import { normalizeDiscordHandleKey, normalizeDiscordSnowflake } from "./target-parsing.js";

const DISCORD_DIRECTORY_CACHE_MAX_ENTRIES = 4000;
const DISCORD_DISCRIMINATOR_SUFFIX = /#\d{4}$/;

function ensureAccountCache(accountId?: string | null): Map<string, string | null> {
  const cacheKey = normalizeAccountId(accountId);
  const existing = discordDirectoryCacheState.handlesByAccount.get(cacheKey);
  if (existing) {
    return existing;
  }
  const created = new Map<string, string | null>();
  discordDirectoryCacheState.handlesByAccount.set(cacheKey, created);
  return created;
}

function setCacheEntry(cache: Map<string, string | null>, key: string, userId: string): void {
  const previous = cache.get(key);
  cache.delete(key);
  // Keep observed collisions unresolved until eviction; configured aliases still take precedence.
  cache.set(key, previous === undefined || previous === userId ? userId : null);
  pruneMapToMaxSize(cache, DISCORD_DIRECTORY_CACHE_MAX_ENTRIES);
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
  return cache.get(handle) ?? undefined;
}
