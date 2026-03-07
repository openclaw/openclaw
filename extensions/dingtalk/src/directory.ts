/**
 * DingTalk directory adapter
 *
 * Implements ChannelDirectoryAdapter interface, provides:
 * - listPeers: list known users from config (allowFrom / dms)
 * - listPeersLive: query department users in real-time via contact API, supports name matching
 * - listGroups: list known groups from config
 *
 * Used by core target-resolver to resolve usernames (e.g. "Wang Ning") to userId
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk/dingtalk";
import { resolveDingtalkCredentials } from "./config.js";
import { listDepartmentUsers, listDepartments } from "./contact-management.js";
import { dingtalkLogger } from "./logger.js";
import type { DingtalkConfig } from "./types.js";

export interface DirectoryEntry {
  kind: "user" | "group";
  id: string;
  name?: string;
}

// In-memory cache for live directory results (5 min TTL)
let cachedPeers: DirectoryEntry[] | null = null;
let cachedPeersTimestamp = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

function resolveDingtalkConfig(cfg: OpenClawConfig): DingtalkConfig | undefined {
  return cfg.channels?.dingtalk as DingtalkConfig | undefined;
}

export async function listDingtalkDirectoryPeers(params: {
  cfg: OpenClawConfig;
  query?: string | null;
  limit?: number | null;
  accountId?: string | null;
}): Promise<DirectoryEntry[]> {
  const dingtalkCfg = resolveDingtalkConfig(params.cfg);
  if (!dingtalkCfg) return [];

  const query = params.query?.trim().toLowerCase() || "";
  const ids = new Set<string>();

  for (const entry of dingtalkCfg.allowFrom ?? []) {
    const trimmed = String(entry).trim();
    if (trimmed && trimmed !== "*") {
      ids.add(trimmed);
    }
  }

  return Array.from(ids)
    .filter((id) => (query ? id.toLowerCase().includes(query) : true))
    .slice(0, params.limit && params.limit > 0 ? params.limit : undefined)
    .map((id) => ({ kind: "user" as const, id }));
}

/**
 * Fetch all users from a department tree recursively.
 * Starts from root department (deptId=1) and traverses sub-departments.
 */
async function fetchAllDepartmentUsers(dingtalkCfg: DingtalkConfig): Promise<DirectoryEntry[]> {
  const results: DirectoryEntry[] = [];
  const visitedDepts = new Set<string>();
  const departmentQueue: string[] = ["1"];

  while (departmentQueue.length > 0) {
    const deptId = departmentQueue.shift()!;
    if (visitedDepts.has(deptId)) continue;
    visitedDepts.add(deptId);

    // Fetch users in this department with pagination
    let cursor: string | undefined;
    let hasMore = true;

    while (hasMore) {
      try {
        const response = await listDepartmentUsers(dingtalkCfg, deptId, cursor, 100);
        const userList = response.result?.list ?? [];

        for (const user of userList) {
          if (user.userid && user.name) {
            results.push({
              kind: "user",
              id: user.userid,
              name: user.name,
            });
          }
        }

        hasMore = response.result?.hasMore ?? false;
        cursor =
          response.result?.nextCursor != null ? String(response.result.nextCursor) : undefined;
      } catch (error) {
        dingtalkLogger.error(
          `Failed to list users in department ${deptId}: ${error instanceof Error ? error.message : String(error)}`,
        );
        hasMore = false;
      }
    }

    // Fetch sub-departments
    try {
      const subDepts = await listDepartments(dingtalkCfg, deptId);
      for (const dept of subDepts.result ?? []) {
        if (dept.deptId != null) {
          departmentQueue.push(String(dept.deptId));
        }
      }
    } catch (error) {
      dingtalkLogger.error(
        `Failed to list sub-departments of ${deptId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return results;
}

/**
 * List peers via live DingTalk contact API.
 * Traverses the organization tree starting from root department,
 * caches results for 5 minutes to avoid excessive API calls.
 */
export async function listDingtalkDirectoryPeersLive(params: {
  cfg: OpenClawConfig;
  query?: string | null;
  limit?: number | null;
  accountId?: string | null;
}): Promise<DirectoryEntry[]> {
  const dingtalkCfg = resolveDingtalkConfig(params.cfg);
  if (!dingtalkCfg) return listDingtalkDirectoryPeers(params);

  const credentials = resolveDingtalkCredentials(dingtalkCfg);
  if (!credentials) return listDingtalkDirectoryPeers(params);

  const now = Date.now();
  if (cachedPeers && now - cachedPeersTimestamp < CACHE_TTL_MS) {
    return filterPeers(cachedPeers, params.query, params.limit);
  }

  try {
    dingtalkLogger.info("Fetching organization directory for target resolution");
    const allUsers = await fetchAllDepartmentUsers(dingtalkCfg);

    // Deduplicate by userid (users can appear in multiple departments)
    const uniqueUsers = new Map<string, DirectoryEntry>();
    for (const user of allUsers) {
      if (!uniqueUsers.has(user.id)) {
        uniqueUsers.set(user.id, user);
      }
    }

    cachedPeers = Array.from(uniqueUsers.values());
    cachedPeersTimestamp = now;

    dingtalkLogger.info(`Directory loaded: ${cachedPeers.length} users`);
    return filterPeers(cachedPeers, params.query, params.limit);
  } catch (error) {
    dingtalkLogger.error(
      `Failed to fetch directory: ${error instanceof Error ? error.message : String(error)}`,
    );
    return listDingtalkDirectoryPeers(params);
  }
}

/**
 * List groups from static config (groupAllowFrom keys)
 */
export async function listDingtalkDirectoryGroups(params: {
  cfg: OpenClawConfig;
  query?: string | null;
  limit?: number | null;
  accountId?: string | null;
}): Promise<DirectoryEntry[]> {
  const dingtalkCfg = resolveDingtalkConfig(params.cfg);
  if (!dingtalkCfg) return [];

  const query = params.query?.trim().toLowerCase() || "";
  const ids = new Set<string>();

  for (const entry of dingtalkCfg.groupAllowFrom ?? []) {
    const trimmed = String(entry).trim();
    if (trimmed && trimmed !== "*") {
      ids.add(trimmed);
    }
  }

  return Array.from(ids)
    .filter((id) => (query ? id.toLowerCase().includes(query) : true))
    .slice(0, params.limit && params.limit > 0 ? params.limit : undefined)
    .map((id) => ({ kind: "group" as const, id }));
}

function filterPeers(
  peers: DirectoryEntry[],
  query?: string | null,
  limit?: number | null,
): DirectoryEntry[] {
  if (!query?.trim()) {
    return limit && limit > 0 ? peers.slice(0, limit) : peers;
  }

  const normalizedQuery = query.trim().toLowerCase();
  const filtered = peers.filter((peer) => {
    const idMatch = peer.id.toLowerCase().includes(normalizedQuery);
    const nameMatch = peer.name?.toLowerCase().includes(normalizedQuery) ?? false;
    return idMatch || nameMatch;
  });

  return limit && limit > 0 ? filtered.slice(0, limit) : filtered;
}
