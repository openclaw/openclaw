import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ClawdbotConfig } from "openclaw/plugin-sdk/feishu";
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

/** Execute SQL silently — returns empty string on error (safe for reads/schema). */
function sqliteExec(sql: string): string {
  const dbPath = getDbPath();
  try {
    return execFileSync("sqlite3", [dbPath], {
      encoding: "utf-8",
      input: sql,
      timeout: 10_000,
    }).trim();
  } catch {
    return "";
  }
}

/** Execute SQL strictly — throws on error (use for writes that must succeed). */
function sqliteExecStrict(sql: string): void {
  const dbPath = getDbPath();
  execFileSync("sqlite3", [dbPath], {
    encoding: "utf-8",
    input: sql,
    timeout: 10_000,
  });
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
 *
 * Two-tier strategy (mirrors feishu-ops/scripts/update-contacts.py):
 * 1. Try `/contact/v3/users` list API (simplest, needs contact:user.base:readonly)
 * 2. Fallback: collect department IDs → `/contact/v3/users/find_by_department`
 *    per department (works with narrower scopes)
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
    return { error: "Feishu account not configured (missing appId/appSecret)" };
  }

  initDb();
  const client = createFeishuClient(account);

  // --- Tier 1: Try users list API ---
  const listResult = await collectUsersViaListAPI(
    client,
    { appId: account.appId!, domain: account.domain },
    log,
  );
  let users = listResult.users;

  // --- Tier 2: Fallback to department traversal ---
  if (users.length === 0) {
    // If tier 1 returned an error and tier 2 also fails, surface the error
    if (listResult.error) {
      log?.(
        `feishu: list API failed (${listResult.error}), falling back to department traversal...`,
      );
    } else {
      log?.("feishu: list API returned 0 users, falling back to department traversal...");
    }
    const deptIds = await collectDepartmentIds(client, log);
    users = await collectUsersByDepartment(client, deptIds, log);

    // If both tiers returned 0 users and tier 1 had an error, surface it
    if (users.length === 0 && listResult.error) {
      return { error: listResult.error };
    }
  }

  // Insert into SQLite
  const syncedOpenIds = new Set<string>();
  let totalSynced = 0;
  for (const user of users) {
    if (!user.open_id) continue;
    const esc = (s?: string) => (s ?? "").replace(/'/g, "''");
    sqliteExecStrict(
      `INSERT OR REPLACE INTO contacts (open_id, name, en_name, email, mobile, department_name, department_id, job_title, status, updated_at) VALUES ('${esc(user.open_id)}', '${esc(user.name)}', '${esc(user.en_name)}', '${esc(user.email)}', '${esc(user.mobile)}', '${esc(user.department_id)}', '${esc(user.department_id)}', '${esc(user.job_title)}', ${user.is_activated ? 1 : 0}, datetime('now'))`,
    );
    syncedOpenIds.add(user.open_id);
    totalSynced++;
  }

  // Prune stale contacts not present in the latest sync snapshot
  if (totalSynced > 0) {
    try {
      const placeholders = [...syncedOpenIds].map((id) => `'${id.replace(/'/g, "''")}'`).join(",");
      sqliteExecStrict(`DELETE FROM contacts WHERE open_id NOT IN (${placeholders})`);
    } catch (err) {
      log?.(`feishu: warning — failed to prune stale contacts: ${String(err)}`);
    }
  }

  log?.(`feishu: contact sync complete, total ${totalSynced} contacts`);
  return { count: totalSynced };
}

type RawUser = {
  open_id: string;
  name?: string;
  en_name?: string;
  email?: string;
  mobile?: string;
  department_id?: string;
  job_title?: string;
  is_activated?: boolean;
};

/** Tier 1: Use /contact/v3/users (requires contact:user.base:readonly) */
async function collectUsersViaListAPI(
  client: ReturnType<typeof createFeishuClient>,
  account: { appId: string; domain?: string },
  log?: (msg: string) => void,
): Promise<{ users: RawUser[]; error?: string }> {
  const users: RawUser[] = [];
  let pageToken: string | undefined;

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
        const errorMsg =
          permErr || `Feishu list API error: ${response.msg || `code ${response.code}`}`;
        log?.(`feishu: list API error: ${errorMsg}`);
        return { users: [], error: errorMsg };
      }

      for (const u of response.data?.items ?? []) {
        if (!u.open_id) continue;
        users.push({
          open_id: u.open_id,
          name: u.name,
          en_name: u.en_name,
          email: u.email,
          mobile: u.mobile,
          department_id: u.department_ids?.[0],
          job_title: u.job_title,
          is_activated: u.status?.is_activated,
        });
      }

      log?.(`feishu: list API fetched ${users.length} contacts so far...`);
      pageToken = response.data?.has_more ? response.data.page_token : undefined;
    } while (pageToken);
  } catch (err) {
    const errorMsg = `Feishu list API failed: ${String(err)}`;
    log?.(`feishu: ${errorMsg}`);
    return { users: [], error: errorMsg };
  }

  return { users };
}

/** Collect all department IDs by traversing from root (0). */
async function collectDepartmentIds(
  client: ReturnType<typeof createFeishuClient>,
  log?: (msg: string) => void,
): Promise<string[]> {
  const deptIds: string[] = ["0"];
  const seen = new Set<string>(["0"]);
  const queue = ["0"];

  while (queue.length > 0 && deptIds.length < 1000) {
    const parentId = queue.shift()!;
    let pageToken: string | undefined;

    try {
      do {
        const response = (await (client as any).contact.department.children({
          path: { department_id: parentId },
          params: {
            department_id_type: "open_department_id",
            user_id_type: "open_id",
            fetch_child: true,
            page_size: 50,
            ...(pageToken ? { page_token: pageToken } : {}),
          },
        })) as {
          code?: number;
          data?: {
            has_more?: boolean;
            page_token?: string;
            items?: Array<{ open_department_id?: string }>;
          };
        };

        if (response.code !== 0) break;

        for (const d of response.data?.items ?? []) {
          const did = d.open_department_id;
          if (did && !seen.has(did)) {
            seen.add(did);
            deptIds.push(did);
            queue.push(did);
          }
        }

        pageToken = response.data?.has_more ? response.data.page_token : undefined;
      } while (pageToken);
    } catch {
      // Permission denied for this department, skip
    }
  }

  log?.(`feishu: collected ${deptIds.length} departments`);
  return deptIds;
}

/** Tier 2: Fetch users per department via /find_by_department. */
async function collectUsersByDepartment(
  client: ReturnType<typeof createFeishuClient>,
  deptIds: string[],
  log?: (msg: string) => void,
): Promise<RawUser[]> {
  const users = new Map<string, RawUser>();

  for (const deptId of deptIds) {
    let pageToken: string | undefined;
    try {
      do {
        const response = (await (client as any).contact.user.findByDepartment({
          params: {
            department_id: deptId,
            user_id_type: "open_id",
            page_size: 50,
            ...(deptId !== "0" ? { department_id_type: "open_department_id" } : {}),
            ...(pageToken ? { page_token: pageToken } : {}),
          },
        })) as {
          code?: number;
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

        if (response.code !== 0) break;

        for (const u of response.data?.items ?? []) {
          if (!u.open_id) continue;
          const old = users.get(u.open_id);
          users.set(u.open_id, {
            open_id: u.open_id,
            name: u.name ?? old?.name,
            en_name: u.en_name ?? old?.en_name,
            email: u.email ?? old?.email,
            mobile: u.mobile ?? old?.mobile,
            department_id: u.department_ids?.[0] ?? old?.department_id,
            job_title: u.job_title ?? old?.job_title,
            is_activated: u.status?.is_activated ?? old?.is_activated,
          });
        }

        pageToken = response.data?.has_more ? response.data.page_token : undefined;
      } while (pageToken);
    } catch {
      // Permission denied for this department, skip
    }
  }

  log?.(`feishu: department traversal fetched ${users.size} unique contacts`);
  return [...users.values()];
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
