import { mkdirSync } from "node:fs";
import * as path from "node:path";
import { getWempDataRoot, readJsonFile, writeJsonFile } from "../storage.js";
import {
  encodePathSegment,
  registerBeforeExitFlusher,
  resolvePersistDebounceMs,
} from "./feature-persist.js";

const ACCOUNT_DIR = "usage-limit";
const DATA_ROOT = getWempDataRoot();
const ACCOUNT_ROOT = path.join(DATA_ROOT, ACCOUNT_DIR);
const DEFAULT_PERSIST_DEBOUNCE_MS = 250;
const PERSIST_DEBOUNCE_MS = resolvePersistDebounceMs(
  process.env.WEMP_USAGE_LIMIT_PERSIST_DEBOUNCE_MS,
  process.env.WEMP_FEATURE_STORAGE_PERSIST_DEBOUNCE_MS,
  DEFAULT_PERSIST_DEBOUNCE_MS,
);

type UsageRecord = { messages: number; tokens: number; day: string };

const usageByAccount = new Map<string, Map<string, UsageRecord>>();
const MAX_USAGE_ENTRIES_PER_ACCOUNT = 5_000;
const pendingUsageByKey = new Map<
  string,
  { accountId: string; openId: string; record: UsageRecord }
>();
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function usageFile(accountId: string, openId: string): string {
  return `${ACCOUNT_DIR}/${encodePathSegment(accountId)}/${encodePathSegment(openId)}.json`;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function ensureAccountDir(accountId: string): void {
  mkdirSync(path.join(ACCOUNT_ROOT, encodePathSegment(accountId)), { recursive: true });
}

function isUsageRecord(value: unknown): value is UsageRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<UsageRecord>;
  return (
    Number.isFinite(record.messages) &&
    Number.isFinite(record.tokens) &&
    typeof record.day === "string"
  );
}

function getAccountUsage(accountId: string): Map<string, UsageRecord> {
  const cached = usageByAccount.get(accountId);
  if (cached) return cached;
  const next = new Map<string, UsageRecord>();
  usageByAccount.set(accountId, next);
  return next;
}

function readUsageFromFile(accountId: string, openId: string): UsageRecord | undefined {
  const record = readJsonFile<UsageRecord | null>(usageFile(accountId, openId), null);
  if (isUsageRecord(record)) return record;
  return undefined;
}

function persistUsage(accountId: string, openId: string, record: UsageRecord): void {
  ensureAccountDir(accountId);
  writeJsonFile(usageFile(accountId, openId), record);
}

function flushPersistNow(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (pendingUsageByKey.size === 0) return;
  const pending = [...pendingUsageByKey.values()];
  pendingUsageByKey.clear();
  for (const item of pending) {
    persistUsage(item.accountId, item.openId, item.record);
  }
}

function schedulePersist(): void {
  if (PERSIST_DEBOUNCE_MS <= 0) {
    flushPersistNow();
    return;
  }
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    flushPersistNow();
  }, PERSIST_DEBOUNCE_MS);
  (persistTimer as any)?.unref?.();
}

function queuePersistUsage(accountId: string, openId: string, record: UsageRecord): void {
  pendingUsageByKey.set(`${accountId}\u0000${openId}`, { accountId, openId, record });
  schedulePersist();
}

function loadUsage(accountId: string, openId: string): UsageRecord | undefined {
  const accountUsage = getAccountUsage(accountId);
  const cached = accountUsage.get(openId);
  if (cached) return cached;

  const record = readUsageFromFile(accountId, openId);
  if (record) {
    accountUsage.set(openId, record);
    return record;
  }

  return undefined;
}

function normalizeRecord(record?: UsageRecord): UsageRecord {
  const day = today();
  if (!record || record.day !== day) return { messages: 0, tokens: 0, day };
  return record;
}

export function recordUsage(accountId: string, openId: string, messageTokens = 0): void {
  const accountUsage = getAccountUsage(accountId);
  const prev = normalizeRecord(loadUsage(accountId, openId));
  const next = {
    day: prev.day,
    messages: prev.messages + 1,
    tokens: prev.tokens + Math.max(0, messageTokens),
  };
  accountUsage.set(openId, next);
  // Evict oldest entries when per-account map grows too large.
  if (accountUsage.size > MAX_USAGE_ENTRIES_PER_ACCOUNT) {
    const iter = accountUsage.keys();
    const first = iter.next();
    if (!first.done) accountUsage.delete(first.value);
  }
  queuePersistUsage(accountId, openId, next);
}

export function getUsage(accountId: string, openId: string): UsageRecord {
  return normalizeRecord(loadUsage(accountId, openId));
}

export function isUsageExceeded(
  accountId: string,
  openId: string,
  limits: { dailyMessages?: number; dailyTokens?: number },
): boolean {
  const current = getUsage(accountId, openId);
  if ((limits.dailyMessages || 0) > 0 && current.messages >= (limits.dailyMessages || 0))
    return true;
  if ((limits.dailyTokens || 0) > 0 && current.tokens >= (limits.dailyTokens || 0)) return true;
  return false;
}

registerBeforeExitFlusher("usage-limit", flushPersistNow);
