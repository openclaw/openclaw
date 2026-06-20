import { createHash } from "node:crypto";
import fs from "node:fs";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { getTelegramRuntime } from "./runtime.js";

const TTL_MS = 24 * 60 * 60 * 1000;
export const TELEGRAM_POLL_CONTEXT_NAMESPACE = "telegram.poll-context";
export const TELEGRAM_POLL_CONTEXT_MAX_ENTRIES = 10_000;
const TELEGRAM_POLL_CONTEXT_STATE_KEY = Symbol.for("openclaw.telegramPollContextState");
const TELEGRAM_POLL_CONTEXT_STORE_FOR_TEST_KEY = Symbol.for(
  "openclaw.telegramPollContextStoreForTest",
);

export type TelegramPollContext = {
  accountId: string;
  chatId: string;
  question: string;
  options: string[];
  messageThreadId?: number;
  updatedAt: number;
};

type StoredTelegramPollContext = TelegramPollContext & {
  pollId: string;
  scopeKey: string;
};

type PollContextStore = Map<string, StoredTelegramPollContext>;
type PollContextPersistentStore = PluginStateSyncKeyedStore<StoredTelegramPollContext>;

type PollContextBucket = {
  scopeKey: string;
  store: PollContextStore;
};

type PollContextState = {
  bucketsByScope: Map<string, PollContextBucket>;
};

let pollContextStoreForTest: PollContextPersistentStore | undefined;

function getPollContextStoreForTest(): PollContextPersistentStore | undefined {
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  return (
    pollContextStoreForTest ??
    (globalStore[TELEGRAM_POLL_CONTEXT_STORE_FOR_TEST_KEY] as
      | PollContextPersistentStore
      | undefined)
  );
}

function getPollContextState(): PollContextState {
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  const existing = globalStore[TELEGRAM_POLL_CONTEXT_STATE_KEY] as PollContextState | undefined;
  if (existing) {
    return existing;
  }
  const state: PollContextState = {
    bucketsByScope: new Map(),
  };
  globalStore[TELEGRAM_POLL_CONTEXT_STATE_KEY] = state;
  return state;
}

function createPollContextStore(): PollContextStore {
  return new Map<string, StoredTelegramPollContext>();
}

function resolvePollContextStorePath(cfg?: Pick<OpenClawConfig, "session">): string {
  return `${resolveStorePath(cfg?.session?.store)}.telegram-poll-context.json`;
}

function resolvePollContextScopeKey(cfg?: Pick<OpenClawConfig, "session">): string {
  const storePath = resolveStorePath(cfg?.session?.store);
  return createHash("sha256").update(storePath, "utf8").digest("hex").slice(0, 24);
}

function buildContextKey(accountId: string, pollId: string): string {
  return `${accountId}:${pollId}`;
}

function pollContextEntryKey(scopeKey: string, accountId: string, pollId: string): string {
  return createHash("sha256")
    .update(`${scopeKey}\0${accountId}\0${pollId}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}

function openPollContextStore(): PollContextPersistentStore {
  return (
    getPollContextStoreForTest() ??
    getTelegramRuntime().state.openSyncKeyedStore<StoredTelegramPollContext>({
      namespace: TELEGRAM_POLL_CONTEXT_NAMESPACE,
      maxEntries: TELEGRAM_POLL_CONTEXT_MAX_ENTRIES,
    })
  );
}

function cleanupExpired(store: PollContextStore, now: number): void {
  for (const [key, entry] of store) {
    if (now - entry.updatedAt > TTL_MS) {
      store.delete(key);
    }
  }
}

function isTelegramPollContext(value: unknown): value is TelegramPollContext {
  if (!value || typeof value !== "object") {
    return false;
  }
  const context = value as Partial<TelegramPollContext>;
  return (
    typeof context.accountId === "string" &&
    typeof context.chatId === "string" &&
    typeof context.question === "string" &&
    Array.isArray(context.options) &&
    context.options.every((option) => typeof option === "string") &&
    typeof context.updatedAt === "number" &&
    Number.isFinite(context.updatedAt)
  );
}

function readLegacyPollContexts(filePath: string): PollContextStore {
  if (!fs.existsSync(filePath)) {
    return createPollContextStore();
  }
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const now = Date.now();
    const store = createPollContextStore();
    for (const [key, value] of Object.entries(parsed)) {
      if (!isTelegramPollContext(value)) {
        continue;
      }
      const pollId = key.split(":").slice(1).join(":").trim();
      if (!pollId || now - value.updatedAt > TTL_MS) {
        continue;
      }
      store.set(key, {
        ...value,
        pollId,
      });
    }
    return store;
  } catch (error) {
    logVerbose(`telegram: failed to read legacy poll-context cache: ${String(error)}`);
    return createPollContextStore();
  }
}

function readPersistedPollContexts(scopeKey: string): PollContextStore {
  const now = Date.now();
  const store = createPollContextStore();
  try {
    for (const entry of openPollContextStore().entries()) {
      if (entry.value.scopeKey !== scopeKey || now - entry.value.updatedAt > TTL_MS) {
        continue;
      }
      store.set(buildContextKey(entry.value.accountId, entry.value.pollId), entry.value);
    }
  } catch (error) {
    logVerbose(`telegram: failed to read poll-context store: ${String(error)}`);
  }
  return store;
}

function persistPollContexts(bucket: PollContextBucket): void {
  const { store, scopeKey } = bucket;
  const now = Date.now();
  cleanupExpired(store, now);
  for (const entry of store.values()) {
    const ttlMs = TTL_MS - Math.max(0, now - entry.updatedAt);
    if (ttlMs <= 0) {
      continue;
    }
    openPollContextStore().register(
      pollContextEntryKey(scopeKey, entry.accountId, entry.pollId),
      entry,
      { ttlMs },
    );
  }
}

function migrateLegacyPollContexts(
  bucket: PollContextBucket,
  cfg?: Pick<OpenClawConfig, "session">,
): void {
  const legacyPath = resolvePollContextStorePath(cfg);
  if (!fs.existsSync(legacyPath)) {
    return;
  }
  const legacyStore = readLegacyPollContexts(legacyPath);
  if (legacyStore.size === 0) {
    fs.rmSync(legacyPath, { force: true });
    return;
  }
  for (const [key, entry] of legacyStore) {
    if (!bucket.store.has(key)) {
      bucket.store.set(key, {
        ...entry,
        scopeKey: bucket.scopeKey,
      });
    }
  }
  try {
    persistPollContexts(bucket);
    fs.rmSync(legacyPath, { force: true });
  } catch (error) {
    logVerbose(`telegram: failed to migrate legacy poll-context cache: ${String(error)}`);
  }
}

function getPollContextBucket(cfg?: Pick<OpenClawConfig, "session">): PollContextBucket {
  const state = getPollContextState();
  const scopeKey = resolvePollContextScopeKey(cfg);
  const existing = state.bucketsByScope.get(scopeKey);
  if (existing) {
    return existing;
  }
  const bucket = {
    scopeKey,
    store: readPersistedPollContexts(scopeKey),
  };
  migrateLegacyPollContexts(bucket, cfg);
  state.bucketsByScope.set(scopeKey, bucket);
  return bucket;
}

export function recordTelegramPollContext(
  pollId: string,
  params: {
    accountId: string;
    chatId: string | number;
    question: string;
    options: string[];
    messageThreadId?: number;
  },
  cfg?: Pick<OpenClawConfig, "session">,
): void {
  const normalizedPollId = pollId.trim();
  if (!normalizedPollId) {
    return;
  }
  const bucket = getPollContextBucket(cfg);
  bucket.store.set(buildContextKey(params.accountId, normalizedPollId), {
    scopeKey: bucket.scopeKey,
    pollId: normalizedPollId,
    accountId: params.accountId,
    chatId: String(params.chatId),
    question: params.question,
    options: [...params.options],
    ...(params.messageThreadId !== undefined ? { messageThreadId: params.messageThreadId } : {}),
    updatedAt: Date.now(),
  });
  try {
    persistPollContexts(bucket);
  } catch (error) {
    logVerbose(`telegram: failed to persist poll-context store: ${String(error)}`);
  }
}

export function getTelegramPollContext(
  accountId: string,
  pollId: string,
  cfg?: Pick<OpenClawConfig, "session">,
): TelegramPollContext | undefined {
  const normalizedPollId = pollId.trim();
  if (!normalizedPollId) {
    return undefined;
  }
  const bucket = getPollContextBucket(cfg);
  cleanupExpired(bucket.store, Date.now());
  const entry = bucket.store.get(buildContextKey(accountId, normalizedPollId));
  if (!entry) {
    return undefined;
  }
  const { pollId: _pollId, scopeKey: _scopeKey, ...context } = entry;
  return context;
}

export function clearTelegramPollContextCache(): void {
  const state = getPollContextState();
  for (const bucket of state.bucketsByScope.values()) {
    bucket.store.clear();
  }
  state.bucketsByScope.clear();
  openPollContextStore().clear();
}

export function resetTelegramPollContextCacheForTest(): void {
  getPollContextState().bucketsByScope.clear();
}

export function setTelegramPollContextStoreForTest(
  store: PollContextPersistentStore | undefined,
): void {
  pollContextStoreForTest = store;
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  if (store) {
    globalStore[TELEGRAM_POLL_CONTEXT_STORE_FOR_TEST_KEY] = store;
  } else {
    delete globalStore[TELEGRAM_POLL_CONTEXT_STORE_FOR_TEST_KEY];
  }
}
