/**
 * Directory adapter: implements ChannelDirectoryAdapter for the yuanbao channel.
 * Resolves usernames/display names to platform IDs using member module and directory cache.
 */

import { getMember } from "../../infra/cache/member.js";
import { createLog } from "../../logger.js";

export interface CachedUserEntry {
  userId: string;
  nickName?: string;
}

/**
 * Simple LRU cache for directory lookups.
 * Stores handle/name -> CachedUserEntry mappings with TTL expiration and max capacity.
 */
class DirectoryLRUCache {
  private readonly maxSize: number;
  private readonly ttlMs: number;
  private readonly cache = new Map<string, { entry: CachedUserEntry; expiresAt: number }>();

  constructor(maxSize = 2000, ttlMs = 30 * 60 * 1000) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  get(key: string): CachedUserEntry | undefined {
    const normalizedKey = key.toLowerCase();
    const item = this.cache.get(normalizedKey);
    if (!item) {
      return undefined;
    }
    if (Date.now() > item.expiresAt) {
      this.cache.delete(normalizedKey);
      return undefined;
    }
    // Move to end (most recently used)
    this.cache.delete(normalizedKey);
    this.cache.set(normalizedKey, item);
    return item.entry;
  }

  set(key: string, entry: CachedUserEntry): void {
    const normalizedKey = key.toLowerCase();
    // Delete existing entry to update position
    this.cache.delete(normalizedKey);
    // Evict oldest entry when over capacity
    if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }
    this.cache.set(normalizedKey, {
      entry,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  clear(): void {
    this.cache.clear();
  }
}

/** Global directory cache instance */
const directoryCache = new DirectoryLRUCache(2000, 30 * 60 * 1000);

/** Represents a resolved user or group directory entry */
export interface DirectoryEntry {
  kind: "user" | "group";
  userId: string;
  nickName: string;
}

/**
 * Resolve a username/display name to a platform user ID.
 *
 * Strategy: check directory cache first, then search group member lists (exact match preferred).
 * Returns null if not found.
 */
export function resolveUsername(
  nameOrHandle: string,
  accountId: string,
  groupCode = "",
): CachedUserEntry | null {
  if (!nameOrHandle.trim()) {
    return null;
  }

  const log = createLog("dm:directory");
  const query = nameOrHandle.trim();

  // 1. Check cache
  const cached = directoryCache.get(query);
  if (cached) {
    return cached;
  }

  // 2. Member list of groups the current account belongs to
  const member = getMember(accountId);
  const groupCodes = groupCode ? [groupCode] : member.listGroupCodes();

  for (const code of groupCodes) {
    const results = member.lookupUsers(code, query);
    if (results.length > 0) {
      // Pick exact match or first result
      const exactMatch = results.find(
        (u) =>
          u.nickName.toLowerCase() === query.toLowerCase() ||
          u.userId.toLowerCase() === query.toLowerCase(),
      );
      const best = exactMatch ?? results[0];
      const entry: CachedUserEntry = {
        userId: best.userId,
        nickName: best.nickName,
      };
      // Cache for subsequent lookups
      directoryCache.set(query, entry);
      directoryCache.set(best.nickName, entry);
      directoryCache.set(best.userId, entry);
      return entry;
    }
  }

  log.error("user not found", { query });
  return null;
}

/**
 * List all known peer users across all group chats under the current account.
 * Deduplicates by userId.
 */
export function listKnownPeers(accountId: string): DirectoryEntry[] {
  const member = getMember(accountId);
  const seen = new Set<string>();
  const entries: DirectoryEntry[] = [];

  const groupCodes = member.listGroupCodes();
  for (const groupCode of groupCodes) {
    const users = member.lookupUsers(groupCode);
    for (const u of users) {
      if (!seen.has(u.userId)) {
        seen.add(u.userId);
        entries.push({
          kind: "user",
          userId: u.userId,
          nickName: u.nickName,
        });
      }
    }
  }

  return entries;
}
