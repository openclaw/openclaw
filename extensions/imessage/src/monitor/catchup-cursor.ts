import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";

export const DEFAULT_IMESSAGE_CATCHUP_MAX_AGE_MINUTES = 24 * 60;

export type IMessageCatchupConfig = {
  enabled?: boolean;
  maxAgeMinutes?: number;
};

export type IMessageCatchupCursor = {
  lastSeenRowid: number;
  updatedAt: string;
};

type IMessageCatchupCursorStore = {
  version: 1;
  accounts: Record<string, IMessageCatchupCursor>;
};

function normalizeAccountKey(accountId: string): string {
  return accountId.trim() || "default";
}

function isSafeRowid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isCursor(value: unknown): value is IMessageCatchupCursor {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return isSafeRowid(record.lastSeenRowid) && typeof record.updatedAt === "string";
}

function parseStore(value: unknown): IMessageCatchupCursorStore {
  if (!value || typeof value !== "object") {
    return { version: 1, accounts: {} };
  }
  const record = value as Record<string, unknown>;
  const accounts = record.accounts;
  if (!accounts || typeof accounts !== "object") {
    return { version: 1, accounts: {} };
  }
  const parsedAccounts: Record<string, IMessageCatchupCursor> = {};
  for (const [accountId, cursor] of Object.entries(accounts)) {
    if (isCursor(cursor)) {
      parsedAccounts[normalizeAccountKey(accountId)] = cursor;
    }
  }
  return { version: 1, accounts: parsedAccounts };
}

export function resolveIMessageCatchupCursorPath(stateDir = resolveStateDir(process.env)): string {
  return path.join(stateDir, "imessage", "catchup-cursors.json");
}

async function readStore(filePath: string): Promise<IMessageCatchupCursorStore> {
  try {
    return parseStore(JSON.parse(await fs.readFile(filePath, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { version: 1, accounts: {} };
    }
    return { version: 1, accounts: {} };
  }
}

async function writeStore(filePath: string, store: IMessageCatchupCursorStore): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const tempPath = path.join(dir, `.catchup-cursors.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(tempPath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tempPath, filePath);
}

export async function readIMessageCatchupCursor(params: {
  accountId: string;
  filePath?: string;
}): Promise<IMessageCatchupCursor | null> {
  const filePath = params.filePath ?? resolveIMessageCatchupCursorPath();
  const store = await readStore(filePath);
  return store.accounts[normalizeAccountKey(params.accountId)] ?? null;
}

export async function recordIMessageCatchupCursor(params: {
  accountId: string;
  messageId: number | null | undefined;
  filePath?: string;
}): Promise<void> {
  if (!isSafeRowid(params.messageId)) {
    return;
  }
  const filePath = params.filePath ?? resolveIMessageCatchupCursorPath();
  const store = await readStore(filePath);
  const accountKey = normalizeAccountKey(params.accountId);
  const existing = store.accounts[accountKey];
  if (existing && existing.lastSeenRowid >= params.messageId) {
    return;
  }
  store.accounts[accountKey] = {
    lastSeenRowid: params.messageId,
    updatedAt: new Date().toISOString(),
  };
  await writeStore(filePath, store);
}

export function resolveIMessageCatchupMaxAgeMinutes(config?: IMessageCatchupConfig): number {
  const value = config?.maxAgeMinutes;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    return DEFAULT_IMESSAGE_CATCHUP_MAX_AGE_MINUTES;
  }
  return value;
}

export function buildIMessageWatchSubscribeParams(params: {
  attachments: boolean;
  cursor?: IMessageCatchupCursor | null;
  catchup?: IMessageCatchupConfig;
  now?: Date;
}): Record<string, unknown> {
  const result: Record<string, unknown> = {
    attachments: params.attachments,
  };
  if (params.catchup?.enabled === false || !params.cursor) {
    return result;
  }
  const maxAgeMinutes = resolveIMessageCatchupMaxAgeMinutes(params.catchup);
  const now = params.now ?? new Date();
  result.since_rowid = params.cursor.lastSeenRowid;
  result.start = new Date(now.getTime() - maxAgeMinutes * 60_000).toISOString();
  return result;
}
