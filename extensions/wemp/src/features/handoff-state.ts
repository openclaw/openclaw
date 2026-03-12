import { mkdirSync } from "node:fs";
import * as path from "node:path";
import { getWempDataRoot, readJsonFile, writeJsonFile } from "../storage.js";

const DATA_ROOT = getWempDataRoot();
const HANDOFF_DIR = "handoff-state";
const HANDOFF_ROOT = path.join(DATA_ROOT, HANDOFF_DIR);
const DEFAULT_TTL_MS = 30 * 60 * 1000;

interface HandoffPersistedRecord {
  active: boolean;
  expireAt: number;
  updatedAt: number;
}

export interface HandoffStateSnapshot {
  active: boolean;
  expireAt: number | null;
  updatedAt: number | null;
}

const handoffBySubject = new Map<string, HandoffPersistedRecord>();
const MAX_HANDOFF_CACHE_ENTRIES = 5_000;

function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}

function subjectKey(accountId: string, openId: string): string {
  return `${accountId}\u0000${openId}`;
}

function ensureAccountDir(accountId: string): void {
  mkdirSync(path.join(HANDOFF_ROOT, encodePathSegment(accountId)), { recursive: true });
}

function handoffStateFile(accountId: string, openId: string): string {
  return `${HANDOFF_DIR}/${encodePathSegment(accountId)}/${encodePathSegment(openId)}.json`;
}

function parseRecord(value: unknown): HandoffPersistedRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<HandoffPersistedRecord>;
  if (typeof record.active !== "boolean") return null;
  if (!Number.isFinite(record.expireAt)) return null;
  if (!Number.isFinite(record.updatedAt)) return null;
  return {
    active: record.active,
    expireAt: Math.trunc(record.expireAt!),
    updatedAt: Math.trunc(record.updatedAt!),
  };
}

function persist(accountId: string, openId: string, record: HandoffPersistedRecord): void {
  ensureAccountDir(accountId);
  writeJsonFile(handoffStateFile(accountId, openId), record);
}

function evictStaleEntries(now: number): void {
  if (handoffBySubject.size <= MAX_HANDOFF_CACHE_ENTRIES) return;
  // Evict expired or oldest entries.
  for (const [key, record] of handoffBySubject) {
    if (!record.active || record.expireAt <= now) handoffBySubject.delete(key);
    if (handoffBySubject.size <= MAX_HANDOFF_CACHE_ENTRIES) return;
  }
  // If still over limit, evict oldest by updatedAt.
  const entries = [...handoffBySubject.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
  const toRemove = entries.length - MAX_HANDOFF_CACHE_ENTRIES;
  for (let i = 0; i < toRemove; i++) handoffBySubject.delete(entries[i][0]);
}

function load(accountId: string, openId: string): HandoffPersistedRecord {
  const key = subjectKey(accountId, openId);
  const cached = handoffBySubject.get(key);
  if (cached) return cached;
  const parsed = parseRecord(readJsonFile<unknown>(handoffStateFile(accountId, openId), null));
  if (parsed) {
    handoffBySubject.set(key, parsed);
    return parsed;
  }
  const fallback: HandoffPersistedRecord = {
    active: false,
    expireAt: 0,
    updatedAt: 0,
  };
  handoffBySubject.set(key, fallback);
  return fallback;
}

function normalizeTtlMs(ttlMs?: number): number {
  if (!Number.isFinite(ttlMs)) return DEFAULT_TTL_MS;
  return Math.max(60_000, Math.floor(ttlMs!));
}

function clearExpired(
  record: HandoffPersistedRecord,
  accountId: string,
  openId: string,
  now: number,
): HandoffPersistedRecord {
  if (!record.active || record.expireAt > now) return record;
  const next: HandoffPersistedRecord = {
    active: false,
    expireAt: now,
    updatedAt: now,
  };
  handoffBySubject.set(subjectKey(accountId, openId), next);
  persist(accountId, openId, next);
  return next;
}

function toSnapshot(record: HandoffPersistedRecord): HandoffStateSnapshot {
  return {
    active: record.active,
    expireAt: record.active ? record.expireAt : null,
    updatedAt: record.updatedAt > 0 ? record.updatedAt : null,
  };
}

export function activateHandoffState(
  accountId: string,
  openId: string,
  ttlMs?: number,
): HandoffStateSnapshot {
  const now = Date.now();
  evictStaleEntries(now);
  const next: HandoffPersistedRecord = {
    active: true,
    expireAt: now + normalizeTtlMs(ttlMs),
    updatedAt: now,
  };
  handoffBySubject.set(subjectKey(accountId, openId), next);
  persist(accountId, openId, next);
  return toSnapshot(next);
}

export function clearHandoffState(accountId: string, openId: string): HandoffStateSnapshot {
  const now = Date.now();
  const next: HandoffPersistedRecord = {
    active: false,
    expireAt: now,
    updatedAt: now,
  };
  handoffBySubject.set(subjectKey(accountId, openId), next);
  persist(accountId, openId, next);
  return toSnapshot(next);
}

export function getHandoffState(
  accountId: string,
  openId: string,
  now = Date.now(),
): HandoffStateSnapshot {
  const record = clearExpired(load(accountId, openId), accountId, openId, now);
  return toSnapshot(record);
}
