/**
 * List Feishu groups (chats) that the bot is a member of.
 *
 * Caches results in the local SQLite contacts database for quick lookups.
 * Uses sqlite3 CLI to avoid native dependency.
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ClawdbotConfig } from "openclaw/plugin-sdk";
import { resolveFeishuAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { checkPermissionError } from "./permissions.js";

// ---------------------------------------------------------------------------
// SQLite helpers (via sqlite3 CLI — shared DB with contacts)
// ---------------------------------------------------------------------------

function getDbPath(): string {
  return path.join(os.homedir(), ".openclaw", "data", "feishu-contacts.db");
}

function sqliteExec(sql: string): string {
  const dbPath = getDbPath();
  try {
    return execSync(`sqlite3 "${dbPath}" "${sql.replace(/"/g, '\\"')}"`, {
      encoding: "utf-8",
      timeout: 10_000,
    }).trim();
  } catch {
    return "";
  }
}

function sqliteQuery(sql: string): string[][] {
  const raw = sqliteExec(sql);
  if (!raw) return [];
  return raw.split("\n").map((line) => line.split("|"));
}

let _dbInitialized = false;

function initDb(): void {
  if (_dbInitialized) return;
  const dbPath = getDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  sqliteExec(`
    CREATE TABLE IF NOT EXISTS groups (
      chat_id TEXT PRIMARY KEY,
      name TEXT,
      description TEXT,
      owner_id TEXT,
      member_count INTEGER,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  _dbInitialized = true;
}

export type FeishuGroup = {
  chat_id: string;
  name: string;
  description: string;
  owner_id: string;
  member_count: number;
};

/**
 * List groups from local cache.
 */
export function listGroupsLocal(): FeishuGroup[] {
  initDb();
  const rows = sqliteQuery(
    "SELECT chat_id, name, description, owner_id, member_count FROM groups ORDER BY name",
  );
  return rows.map(([chat_id, name, description, owner_id, member_count]) => ({
    chat_id: chat_id ?? "",
    name: name ?? "",
    description: description ?? "",
    owner_id: owner_id ?? "",
    member_count: parseInt(member_count ?? "0", 10) || 0,
  }));
}

/**
 * Search groups by name in local cache.
 */
export function searchGroupsLocal(keyword: string): FeishuGroup[] {
  initDb();
  const escaped = keyword.replace(/'/g, "''");
  const rows = sqliteQuery(
    `SELECT chat_id, name, description, owner_id, member_count FROM groups WHERE name LIKE '%${escaped}%' ORDER BY name LIMIT 20`,
  );
  return rows.map(([chat_id, name, description, owner_id, member_count]) => ({
    chat_id: chat_id ?? "",
    name: name ?? "",
    description: description ?? "",
    owner_id: owner_id ?? "",
    member_count: parseInt(member_count ?? "0", 10) || 0,
  }));
}

/**
 * Sync bot's groups from Feishu API into local SQLite.
 */
export async function syncGroupsFromAPI(params: {
  cfg: ClawdbotConfig;
  accountId?: string;
  log?: (msg: string) => void;
}): Promise<{ count: number } | { error: string }> {
  const { cfg, accountId, log } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  if (!account.configured || !account.appId) {
    return { error: "Feishu account not configured (missing appId/appSecret)" };
  }

  initDb();
  const client = createFeishuClient(account);

  let pageToken: string | undefined;
  let totalSynced = 0;

  try {
    do {
      const response = (await client.im.chat.list({
        params: {
          page_size: 50,
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      })) as {
        code?: number;
        msg?: string;
        data?: {
          has_more?: boolean;
          page_token?: string;
          items?: Array<{
            chat_id?: string;
            name?: string;
            description?: string;
            owner_id?: string;
            member_count?: string;
          }>;
        };
      };

      if (response.code !== 0) {
        const permErr = checkPermissionError(
          response,
          account.appId,
          "im:chat:readonly",
          account.domain,
        );
        if (permErr) return { error: permErr };
        return { error: `Feishu API error: ${response.msg || `code ${response.code}`}` };
      }

      const items = response.data?.items ?? [];
      for (const group of items) {
        if (!group.chat_id) continue;
        const esc = (s?: string) => (s ?? "").replace(/'/g, "''");
        sqliteExec(
          `INSERT OR REPLACE INTO groups (chat_id, name, description, owner_id, member_count, updated_at) VALUES ('${esc(group.chat_id)}', '${esc(group.name)}', '${esc(group.description)}', '${esc(group.owner_id)}', ${Number(group.member_count) || 0}, datetime('now'))`,
        );
        totalSynced++;
      }

      pageToken = response.data?.has_more ? response.data.page_token : undefined;
    } while (pageToken);

    log?.(`feishu: group sync complete, total ${totalSynced} groups`);
    return { count: totalSynced };
  } catch (err) {
    const permErr = checkPermissionError(err, account.appId, "im:chat:readonly", account.domain);
    if (permErr) return { error: permErr };
    return { error: `Group sync failed: ${String(err)}` };
  }
}

/**
 * List groups with auto-sync: if local cache is empty, sync from API first.
 */
export async function listGroupsOrSync(params: {
  cfg: ClawdbotConfig;
  accountId?: string;
  log?: (msg: string) => void;
}): Promise<{ results: FeishuGroup[] } | { error: string }> {
  const local = listGroupsLocal();
  if (local.length > 0) {
    return { results: local };
  }

  const syncResult = await syncGroupsFromAPI(params);
  if ("error" in syncResult) {
    return { error: syncResult.error };
  }

  return { results: listGroupsLocal() };
}

/**
 * Search groups by keyword with auto-sync.
 * If no match found after sync, returns a hint to add the bot to the group.
 */
export async function searchGroupsOrSync(params: {
  keyword: string;
  cfg: ClawdbotConfig;
  accountId?: string;
  log?: (msg: string) => void;
}): Promise<{ results: FeishuGroup[] } | { error: string }> {
  const { keyword, cfg, accountId, log } = params;

  // First, try local search
  let results = searchGroupsLocal(keyword);
  if (results.length > 0) {
    return { results };
  }

  // Sync from API and retry
  log?.(`feishu: group "${keyword}" not found locally, syncing from API...`);
  const syncResult = await syncGroupsFromAPI({ cfg, accountId, log });
  if ("error" in syncResult) {
    return { error: syncResult.error };
  }

  results = searchGroupsLocal(keyword);
  if (results.length > 0) {
    return { results };
  }

  // Still not found — bot is not in any matching group
  const allGroups = listGroupsLocal();
  const groupList =
    allGroups.length > 0
      ? `Bot is currently in these groups:\n${allGroups.map((g) => `  - ${g.name} (${g.chat_id})`).join("\n")}`
      : "Bot is not in any group.";

  return {
    error:
      `No group matching "${keyword}" found. The bot can only send messages to groups it has joined.\n` +
      `Please add the bot to the target group first, then retry.\n\n${groupList}`,
  };
}
