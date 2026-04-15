/**
 * Directory adapter
 *
 * 为元宝频道实现标准的 ChannelDirectoryAdapter 接口。
 * 使用 member 模块和Directory缓存将用户名/展示名称解析为平台 ID。
 */

import { getMember } from "../../infra/cache/member.js";
import { createLog } from "../../logger.js";

// ============ 缓存类型 ============

export interface CachedUserEntry {
  userId: string;
  nickName?: string;
}

// ============ LRU 缓存实现 ============

/**
 * 简单的 LRU 缓存，用于Directory查找。
 *
 * 存储 handle/name → CachedUserEntry 映射，
 * 支持 TTL 过期和最大容量限制。
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
    // 移到末尾（最近使用）
    this.cache.delete(normalizedKey);
    this.cache.set(normalizedKey, item);
    return item.entry;
  }

  set(key: string, entry: CachedUserEntry): void {
    const normalizedKey = key.toLowerCase();
    // 删除已有条目以更新位置
    this.cache.delete(normalizedKey);
    // 超过容量时淘汰最旧条目
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

// ============ 单例缓存 ============

/** 全局Directory缓存实例 */
const directoryCache = new DirectoryLRUCache(2000, 30 * 60 * 1000);

// ============ 类型定义 ============

/** 表示已解析的用户或群组的Directory条目 */
export interface DirectoryEntry {
  kind: "user" | "group";
  userId: string;
  nickName: string;
}

// ============ 解析逻辑 ============

/**
 * 将用户名/展示名称解析为平台User ID。
 *
 * Parsing strategy:
 * 1. 优先检查Directory缓存（快速路径）
 * 2. 遍历当前账号所在群聊的成员列表进行搜索（精确匹配优先）
 * 3. 未匹配到则返回 null
 *
 * @param nameOrHandle - 待解析的用户名或展示名称
 * @param accountId - Account ID，用于定位 Member 实例
 * @param groupCode - 群号，用于定位群成员列表
 * @returns 已解析的用户条目，未找到时返回 null
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

  // 1. 检查缓存
  const cached = directoryCache.get(query);
  if (cached) {
    return cached;
  }

  // 2. 当前账号所在群聊的成员列表
  const member = getMember(accountId);
  const groupCodes = groupCode ? [groupCode] : member.listGroupCodes();

  for (const code of groupCodes) {
    const results = member.lookupUsers(code, query);
    if (results.length > 0) {
      // 选取精确匹配或首个结果
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
      // 缓存以备后续查找
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
 *
 * 遍历所有群聊的成员列表并按 userId 去重。
 *
 * @param accountId - Account ID，用于定位 Member 实例
 * @returns 表示已知用户的Directory条目数组
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
