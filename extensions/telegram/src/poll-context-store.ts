import fs from "node:fs";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { replaceFileAtomicSync } from "openclaw/plugin-sdk/security-runtime";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";

const TTL_MS = 24 * 60 * 60 * 1000;
const TELEGRAM_POLL_CONTEXT_STATE_KEY = Symbol.for("openclaw.telegramPollContextState");

export type TelegramPollContext = {
  accountId: string;
  chatId: string;
  question: string;
  options: string[];
  messageThreadId?: number;
  updatedAt: number;
};

type PollContextStore = Map<string, TelegramPollContext>;

type PollContextBucket = {
  persistedPath: string;
  store: PollContextStore;
};

type PollContextState = {
  bucketsByPath: Map<string, PollContextBucket>;
};

function getPollContextState(): PollContextState {
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  const existing = globalStore[TELEGRAM_POLL_CONTEXT_STATE_KEY] as PollContextState | undefined;
  if (existing) {
    return existing;
  }
  const state: PollContextState = {
    bucketsByPath: new Map(),
  };
  globalStore[TELEGRAM_POLL_CONTEXT_STATE_KEY] = state;
  return state;
}

function createPollContextStore(): PollContextStore {
  return new Map<string, TelegramPollContext>();
}

function resolvePollContextStorePath(cfg?: Pick<OpenClawConfig, "session">): string {
  return `${resolveStorePath(cfg?.session?.store)}.telegram-poll-context.json`;
}

function buildContextKey(accountId: string, pollId: string): string {
  return `${accountId}:${pollId}`;
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

function readPersistedPollContexts(filePath: string): PollContextStore {
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
      if (now - value.updatedAt > TTL_MS) {
        continue;
      }
      store.set(key, value);
    }
    return store;
  } catch (error) {
    logVerbose(`telegram: failed to read poll-context cache: ${String(error)}`);
    return createPollContextStore();
  }
}

function getPollContextBucket(cfg?: Pick<OpenClawConfig, "session">): PollContextBucket {
  const state = getPollContextState();
  const persistedPath = resolvePollContextStorePath(cfg);
  const existing = state.bucketsByPath.get(persistedPath);
  if (existing) {
    return existing;
  }
  const bucket = {
    persistedPath,
    store: readPersistedPollContexts(persistedPath),
  };
  state.bucketsByPath.set(persistedPath, bucket);
  return bucket;
}

function persistPollContexts(bucket: PollContextBucket): void {
  const { store, persistedPath } = bucket;
  cleanupExpired(store, Date.now());
  if (store.size === 0) {
    fs.rmSync(persistedPath, { force: true });
    return;
  }
  replaceFileAtomicSync({
    filePath: persistedPath,
    content: JSON.stringify(Object.fromEntries(store)),
    tempPrefix: ".telegram-poll-context",
  });
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
    logVerbose(`telegram: failed to persist poll-context cache: ${String(error)}`);
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
  return bucket.store.get(buildContextKey(accountId, normalizedPollId));
}

export function clearTelegramPollContextCache(): void {
  const state = getPollContextState();
  for (const bucket of state.bucketsByPath.values()) {
    bucket.store.clear();
    fs.rmSync(bucket.persistedPath, { force: true });
  }
  state.bucketsByPath.clear();
}

export function resetTelegramPollContextCacheForTest(): void {
  getPollContextState().bucketsByPath.clear();
}
