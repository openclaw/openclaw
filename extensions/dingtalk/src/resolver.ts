/**
 * 钉钉目标解析器
 *
 * 实现 ChannelResolverAdapter 接口，将用户名/昵称解析为钉钉 userId。
 * 通过遍历根部门用户列表按名字匹配实现。
 *
 * 解析策略:
 * - 如果输入已经是 userId 格式（纯数字长串），直接返回
 * - 如果输入带 user: 前缀，去掉前缀后处理
 * - 否则按名字在通讯录中搜索匹配
 */

import type { OpenClawConfig, ChannelResolveResult } from "openclaw/plugin-sdk/dingtalk";
import { resolveDingtalkCredentials } from "./config.js";
import type { UserInfo } from "./contact-management.js";
import { listDepartmentUsers } from "./contact-management.js";
import { dingtalkLogger } from "./logger.js";
import type { DingtalkConfig } from "./types.js";

/** 用户缓存条目 */
interface CachedUser {
  userid: string;
  name: string;
}

/** 缓存有效期（5 分钟） */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** 每页最大用户数 */
const PAGE_SIZE = 100;

/** 最大遍历页数（防止无限循环） */
const MAX_PAGES = 50;

/** 用户列表缓存 */
let cachedUsers: CachedUser[] = [];
let cacheTimestamp = 0;

/**
 * 判断输入是否已经是 userId 格式
 * 钉钉 userId 通常是纯数字长串（15-25 位）
 */
function isDingtalkUserId(input: string): boolean {
  return /^\d{10,}$/.test(input);
}

/**
 * 去除目标前缀
 */
function stripTargetPrefix(input: string): string {
  const trimmed = input.trim();
  if (trimmed.startsWith("user:")) {
    return trimmed.slice(5).trim();
  }
  if (trimmed.startsWith("@")) {
    return trimmed.slice(1).trim();
  }
  return trimmed;
}

/**
 * 从通讯录加载所有用户（根部门递归）
 * 使用分页遍历根部门（deptId=1）的所有用户
 */
async function loadAllUsers(cfg: DingtalkConfig): Promise<CachedUser[]> {
  const now = Date.now();
  if (cachedUsers.length > 0 && now - cacheTimestamp < CACHE_TTL_MS) {
    return cachedUsers;
  }

  dingtalkLogger.info("Loading user directory from root department for resolver");

  const users: CachedUser[] = [];
  let cursor: string | undefined;
  let pageCount = 0;

  try {
    do {
      const result = await listDepartmentUsers(cfg, "1", cursor, PAGE_SIZE);
      const userList = result.result?.list ?? [];

      for (const user of userList) {
        if (user.userid && user.name) {
          users.push({ userid: user.userid, name: user.name });
        }
      }

      cursor = result.result?.hasMore ? String(result.result.nextCursor) : undefined;
      pageCount++;
    } while (cursor && pageCount < MAX_PAGES);

    cachedUsers = users;
    cacheTimestamp = now;
    dingtalkLogger.info(`Loaded ${users.length} users from directory`);
  } catch (error) {
    dingtalkLogger.error(`Failed to load user directory: ${String(error)}`);
    // Return stale cache if available
    if (cachedUsers.length > 0) {
      return cachedUsers;
    }
    throw error;
  }

  return users;
}

/**
 * 按名字查找用户
 * 支持精确匹配和包含匹配
 */
function findUsersByName(users: CachedUser[], query: string): CachedUser[] {
  const normalizedQuery = query.trim().toLowerCase();

  // Exact match first
  const exactMatches = users.filter((user) => user.name.toLowerCase() === normalizedQuery);
  if (exactMatches.length > 0) {
    return exactMatches;
  }

  // Partial match fallback
  return users.filter((user) => user.name.toLowerCase().includes(normalizedQuery));
}

export type ResolveResult = ChannelResolveResult;

/**
 * 解析钉钉目标用户
 *
 * 实现 ChannelResolverAdapter.resolveTargets 接口
 */
export async function resolveDingtalkTargets(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  inputs: string[];
  kind: "user" | "group";
  runtime?: { error?: (msg: string) => void };
}): Promise<ResolveResult[]> {
  const { cfg, inputs, kind, runtime } = params;

  const results: ResolveResult[] = inputs.map((input) => ({
    input,
    resolved: false,
  }));

  // Groups are not supported for resolution yet
  if (kind === "group") {
    for (const entry of results) {
      entry.note = "DingTalk group resolution not yet supported";
    }
    return results;
  }

  const dingtalkCfg = cfg.channels?.dingtalk;
  if (!dingtalkCfg) {
    for (const entry of results) {
      entry.note = "DingTalk not configured";
    }
    return results;
  }

  const credentials = resolveDingtalkCredentials(dingtalkCfg);
  if (!credentials) {
    for (const entry of results) {
      entry.note = "DingTalk credentials missing";
    }
    return results;
  }

  // Separate already-resolved IDs from names that need lookup
  const pendingIndices: number[] = [];

  for (let index = 0; index < inputs.length; index++) {
    const cleaned = stripTargetPrefix(inputs[index] ?? "");
    if (!cleaned) {
      results[index]!.note = "empty input";
      continue;
    }

    if (isDingtalkUserId(cleaned)) {
      results[index]!.resolved = true;
      results[index]!.id = cleaned;
      continue;
    }

    pendingIndices.push(index);
  }

  if (pendingIndices.length === 0) {
    return results;
  }

  // Load user directory and resolve by name
  let allUsers: CachedUser[];
  try {
    allUsers = await loadAllUsers(dingtalkCfg);
  } catch (error) {
    const errorMessage = `DingTalk directory lookup failed: ${String(error)}`;
    runtime?.error?.(errorMessage);
    for (const index of pendingIndices) {
      results[index]!.note = "directory lookup failed";
    }
    return results;
  }

  for (const index of pendingIndices) {
    const cleaned = stripTargetPrefix(inputs[index] ?? "");
    const matches = findUsersByName(allUsers, cleaned);

    if (matches.length === 1) {
      results[index]!.resolved = true;
      results[index]!.id = matches[0]!.userid;
      results[index]!.name = matches[0]!.name;
    } else if (matches.length > 1) {
      // Ambiguous: multiple users with same name
      const names = matches
        .map((matchedUser) => `${matchedUser.name} (${matchedUser.userid})`)
        .join(", ");
      results[index]!.note = `ambiguous: ${names}`;
    } else {
      results[index]!.note = `no user found matching "${cleaned}"`;
    }
  }

  return results;
}
