import { mkdirSync } from "node:fs";
import * as path from "node:path";
import { readJsonFile, writeJsonFile, getWempDataRoot } from "../storage.js";
import {
  encodePathSegment,
  registerBeforeExitFlusher,
  resolvePersistDebounceMs,
} from "./feature-persist.js";

const ACCOUNT_DIR = "assistant-toggle";
const ACCOUNT_ROOT = path.join(getWempDataRoot(), ACCOUNT_DIR);
const DEFAULT_PERSIST_DEBOUNCE_MS = 250;
const PERSIST_DEBOUNCE_MS = resolvePersistDebounceMs(
  process.env.WEMP_ASSISTANT_TOGGLE_PERSIST_DEBOUNCE_MS,
  process.env.WEMP_FEATURE_STORAGE_PERSIST_DEBOUNCE_MS,
  DEFAULT_PERSIST_DEBOUNCE_MS,
);

const stateByOpenId = new Map<string, boolean>();
const MAX_TOGGLE_CACHE_ENTRIES = 10_000;
const pendingPersistByOpenId = new Map<
  string,
  { accountId: string; openId: string; enabled: boolean }
>();
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function ensureOpenIdDir(accountId: string): void {
  mkdirSync(path.join(ACCOUNT_ROOT, encodePathSegment(accountId)), { recursive: true });
}

function openIdFile(accountId: string, openId: string): string {
  return `${ACCOUNT_DIR}/${encodePathSegment(accountId)}/${encodePathSegment(openId)}.json`;
}

function cacheKey(accountId: string, openId: string): string {
  return `${accountId}\u0000${openId}`;
}

function readOpenIdState(accountId: string, openId: string): boolean | undefined {
  const persisted = readJsonFile<unknown>(openIdFile(accountId, openId), null);
  return typeof persisted === "boolean" ? persisted : undefined;
}

function persistOpenIdState(accountId: string, openId: string, enabled: boolean): void {
  ensureOpenIdDir(accountId);
  writeJsonFile(openIdFile(accountId, openId), enabled);
}

function flushPersistNow(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (pendingPersistByOpenId.size === 0) return;
  const pending = [...pendingPersistByOpenId.values()];
  pendingPersistByOpenId.clear();
  for (const item of pending) {
    persistOpenIdState(item.accountId, item.openId, item.enabled);
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

function queuePersist(accountId: string, openId: string, enabled: boolean): void {
  pendingPersistByOpenId.set(cacheKey(accountId, openId), { accountId, openId, enabled });
  schedulePersist();
}

function loadOpenIdState(accountId: string, openId: string): boolean {
  const key = cacheKey(accountId, openId);
  const cached = stateByOpenId.get(key);
  if (cached !== undefined) return cached;

  const isolated = readOpenIdState(accountId, openId);
  if (isolated !== undefined) {
    stateByOpenId.set(key, isolated);
    return isolated;
  }

  stateByOpenId.set(key, false);
  return false;
}

export function isAssistantEnabled(accountId: string, openId: string): boolean {
  return loadOpenIdState(accountId, openId);
}

export function setAssistantEnabled(accountId: string, openId: string, enabled: boolean): void {
  stateByOpenId.set(cacheKey(accountId, openId), enabled);
  // Evict oldest entries when cache grows too large.
  if (stateByOpenId.size > MAX_TOGGLE_CACHE_ENTRIES) {
    const iter = stateByOpenId.keys();
    const first = iter.next();
    if (!first.done) stateByOpenId.delete(first.value);
  }
  queuePersist(accountId, openId, enabled);
}

registerBeforeExitFlusher("assistant-toggle", flushPersistNow);
