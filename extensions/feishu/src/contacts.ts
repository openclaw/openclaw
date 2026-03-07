/**
 * Feishu contact search and auto-sync.
 *
 * Uses a local SQLite database (via sqlite3 CLI) for fast fuzzy lookups.
 * When a search returns no results, automatically syncs contacts from
 * the Feishu API and retries.
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
// SQLite helpers (via sqlite3 CLI)
// ---------------------------------------------------------------------------

function getDbPath(): string {
  return path.join(os.homedir(), ".openclaw", "data", "feishu-contacts.db");
}

function ensureDb(): void {
  const dbPath = getDbPath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  sqliteExec(`
    CREATE TABLE IF NOT EXISTS contacts (
      open_id TEXT PRIMARY KEY,
      name TEXT,
      en_name TEXT,
      email TEXT,
      mobile TEXT,
      department_name TEXT,
      department_id TEXT,
      job_title TEXT,
      status INTEGER,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_contacts_name ON contacts(name);
    CREATE INDEX IF NOT EXISTS idx_contacts_en_name ON contacts(en_name);
    CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email);
  `);
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
  ensureDb();
  _dbInitialized = true;
}

// ---------------------------------------------------------------------------
// Contact types
// ---------------------------------------------------------------------------

export type FeishuContact = {
  open_id: string;
  name: string;
  en_name: string;
  email: string;
  mobile: string;
  department_name: string;
  job_title: string;
};

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * Search contacts in the local SQLite database.
 */
export function searchContactsLocal(keyword: string): FeishuContact[] {
  initDb();
  const escaped = keyword.replace(/'/g, "''");
  const rows = sqliteQuery(
    `SELECT open_id, name, en_name, email, mobile, department_name, job_title FROM contacts WHERE name LIKE '%${escaped}%' OR en_name LIKE '%${escaped}%' OR email LIKE '%${escaped}%' ORDER BY name LIMIT 20`,
  );
  return rows.map(([open_id, name, en_name, email, mobile, department_name, job_title]) => ({
    open_id: open_id ?? "",
    name: name ?? "",
    en_name: en_name ?? "",
    email: email ?? "",
    mobile: mobile ?? "",
    department_name: department_name ?? "",
    job_title: job_title ?? "",
  }));
}

/**
 * Get total contact count in the database.
 */
export function getContactCount(): number {
  initDb();
  const raw = sqliteExec("SELECT COUNT(*) FROM contacts");
  return parseInt(raw, 10) || 0;
}

// ---------------------------------------------------------------------------
// Sync from Feishu API
// ---------------------------------------------------------------------------

/**
 * Sync all contacts from Feishu API into local SQLite.
 * Uses pagination (50 per page) to fetch all users.
 *
 * @returns The number of contacts synced, or an error message string.
 */
export async function syncContactsFromAPI(params: {
  cfg: ClawdbotConfig;
  accountId?: string;
  log?: (msg: string) => void;
}): Promise<{ count: number } | { error: string }> {
  const { cfg, accountId, log } = params;
  const account = resolveFeishuAccount({ cfg, accountId });
  if (!account.configured || !account.appId) {
    return { error: "飞书账号未配置 appId/appSecret" };
  }

  initDb();
  const client = createFeishuClient(account);

  let pageToken: string | undefined;
  let totalSynced = 0;

  try {
    do {
      const response = (await client.contact.user.list({
        params: {
          page_size: 50,
          user_id_type: "open_id",
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      })) as {
        code?: number;
        msg?: string;
        data?: {
          has_more?: boolean;
          page_token?: string;
          items?: Array<{
            open_id?: string;
            name?: string;
            en_name?: string;
            email?: string;
            mobile?: string;
            department_ids?: string[];
            job_title?: string;
            status?: { is_activated?: boolean };
          }>;
        };
      };

      if (response.code !== 0) {
        const permErr = checkPermissionError(
          response,
          account.appId,
          "contact:user.base:readonly",
          account.domain,
        );
        if (permErr) return { error: permErr };
        return { error: `飞书 API 错误: ${response.msg || `code ${response.code}`}` };
      }

      const items = response.data?.items ?? [];
      for (const user of items) {
        if (!user.open_id) continue;
        const esc = (s?: string) => (s ?? "").replace(/'/g, "''");
        sqliteExec(
          `INSERT OR REPLACE INTO contacts (open_id, name, en_name, email, mobile, department_name, department_id, job_title, status, updated_at) VALUES ('${esc(user.open_id)}', '${esc(user.name)}', '${esc(user.en_name)}', '${esc(user.email)}', '${esc(user.mobile)}', '${esc(user.department_ids?.[0])}', '${esc(user.department_ids?.[0])}', '${esc(user.job_title)}', ${user.status?.is_activated ? 1 : 0}, datetime('now'))`,
        );
        totalSynced++;
      }

      log?.(`feishu: synced ${totalSynced} contacts so far...`);

      pageToken = response.data?.has_more ? response.data.page_token : undefined;
    } while (pageToken);

    log?.(`feishu: contact sync complete, total ${totalSynced} contacts`);
    return { count: totalSynced };
  } catch (err) {
    const permErr = checkPermissionError(
      err,
      account.appId,
      "contact:user.base:readonly",
      account.domain,
    );
    if (permErr) return { error: permErr };
    return { error: `同步联系人失败: ${String(err)}` };
  }
}

/**
 * Search contacts with auto-sync on miss.
 * If local search returns no results, trigger a fresh sync from the API
 * and retry the search.
 */
export async function searchContactsOrSync(params: {
  keyword: string;
  cfg: ClawdbotConfig;
  accountId?: string;
  log?: (msg: string) => void;
}): Promise<{ results: FeishuContact[] } | { error: string }> {
  const { keyword, cfg, accountId, log } = params;

  // First, try local search
  const localResults = searchContactsLocal(keyword);
  if (localResults.length > 0) {
    return { results: localResults };
  }

  // No results — sync from API and retry
  log?.(`feishu: contact "${keyword}" not found locally, syncing from API...`);
  const syncResult = await syncContactsFromAPI({ cfg, accountId, log });
  if ("error" in syncResult) {
    return { error: syncResult.error };
  }

  // Retry search after sync
  const retryResults = searchContactsLocal(keyword);
  return { results: retryResults };
}
