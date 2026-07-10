// Signal plugin module tracks native-reply quote authors for durable sends.
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeSignalMessagingTarget } from "./normalize.js";
import { getOptionalSignalRuntime } from "./runtime.js";

const PERSISTENT_NAMESPACE = "signal.reply-authors.v1";
const PERSISTENT_MAX_ENTRIES = 5000;
const DEFAULT_REPLY_AUTHOR_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type SignalReplyAuthorRecord = {
  author: string;
  accountId: string;
  conversationKey: string;
  replyToId: string;
  registeredAt: number;
};

type MemoryReplyAuthorRecord = SignalReplyAuthorRecord & {
  expiresAt: number;
};

const memoryReplyAuthors = new Map<string, MemoryReplyAuthorRecord>();
let persistentStoreDisabled = false;

function openSignalReplyAuthorStore() {
  if (persistentStoreDisabled) {
    return undefined;
  }
  const runtime = getOptionalSignalRuntime();
  try {
    return runtime?.state.openKeyedStore<SignalReplyAuthorRecord>({
      namespace: PERSISTENT_NAMESPACE,
      maxEntries: PERSISTENT_MAX_ENTRIES,
      defaultTtlMs: DEFAULT_REPLY_AUTHOR_TTL_MS,
    });
  } catch (error) {
    persistentStoreDisabled = true;
    runtime?.logging
      .getChildLogger({ plugin: "signal", feature: "reply-author-state" })
      .warn("Signal persistent reply author state unavailable", { error: String(error) });
    return undefined;
  }
}

function buildSignalReplyAuthorStoreKey(params: {
  accountId?: string | null;
  to: string;
  replyToId?: string | null;
}): string | undefined {
  const conversationKey = normalizeSignalMessagingTarget(params.to);
  const replyToId = normalizeOptionalString(params.replyToId);
  if (!conversationKey || !replyToId) {
    return undefined;
  }
  const accountKey = normalizeLowercaseStringOrEmpty(
    normalizeOptionalString(params.accountId) ?? DEFAULT_ACCOUNT_ID,
  );
  return `account=${accountKey}|to=${conversationKey}|id=${replyToId}`;
}

function pruneMemoryReplyAuthors(now = Date.now()): void {
  for (const [key, record] of memoryReplyAuthors) {
    if (record.expiresAt <= now) {
      memoryReplyAuthors.delete(key);
    }
  }
  while (memoryReplyAuthors.size > PERSISTENT_MAX_ENTRIES) {
    const oldestKey = memoryReplyAuthors.keys().next().value;
    if (!oldestKey) {
      break;
    }
    memoryReplyAuthors.delete(oldestKey);
  }
}

export async function registerSignalReplyAuthorForInboundMessage(params: {
  accountId?: string | null;
  to: string;
  replyToId?: string | null;
  author?: string | null;
}): Promise<void> {
  const store = openSignalReplyAuthorStore();
  const key = buildSignalReplyAuthorStoreKey(params);
  const author = normalizeOptionalString(params.author);
  const conversationKey = normalizeSignalMessagingTarget(params.to);
  const replyToId = normalizeOptionalString(params.replyToId);
  const accountKey = normalizeLowercaseStringOrEmpty(
    normalizeOptionalString(params.accountId) ?? DEFAULT_ACCOUNT_ID,
  );
  if (!store || !key || !author || !conversationKey || !replyToId) {
    if (key && author && conversationKey && replyToId) {
      const registeredAt = Date.now();
      memoryReplyAuthors.set(key, {
        author,
        accountId: accountKey,
        conversationKey,
        replyToId,
        registeredAt,
        expiresAt: registeredAt + DEFAULT_REPLY_AUTHOR_TTL_MS,
      });
      pruneMemoryReplyAuthors(registeredAt);
    }
    return;
  }
  const registeredAt = Date.now();
  memoryReplyAuthors.set(key, {
    author,
    accountId: accountKey,
    conversationKey,
    replyToId,
    registeredAt,
    expiresAt: registeredAt + DEFAULT_REPLY_AUTHOR_TTL_MS,
  });
  pruneMemoryReplyAuthors(registeredAt);
  try {
    await store.register(key, {
      author,
      accountId: accountKey,
      conversationKey,
      replyToId,
      registeredAt,
    });
  } catch (error) {
    getOptionalSignalRuntime()
      ?.logging.getChildLogger({ plugin: "signal", feature: "reply-author-state" })
      .warn("Signal persistent reply author state failed", { error: String(error) });
  }
}

export async function resolveSignalReplyAuthorWithPersistence(params: {
  accountId?: string | null;
  to: string;
  replyToId?: string | null;
}): Promise<string | undefined> {
  const store = openSignalReplyAuthorStore();
  const key = buildSignalReplyAuthorStoreKey(params);
  if (!key) {
    return undefined;
  }
  if (!store) {
    pruneMemoryReplyAuthors();
    return normalizeOptionalString(memoryReplyAuthors.get(key)?.author);
  }
  pruneMemoryReplyAuthors();
  const memoryAuthor = normalizeOptionalString(memoryReplyAuthors.get(key)?.author);
  if (memoryAuthor) {
    return memoryAuthor;
  }
  try {
    return normalizeOptionalString((await store.lookup(key))?.author);
  } catch (error) {
    getOptionalSignalRuntime()
      ?.logging.getChildLogger({ plugin: "signal", feature: "reply-author-state" })
      .warn("Signal persistent reply author lookup failed", { error: String(error) });
    return undefined;
  }
}

export async function clearSignalReplyAuthorsForTest(): Promise<void> {
  memoryReplyAuthors.clear();
  persistentStoreDisabled = false;
  await openSignalReplyAuthorStore()?.clear();
}
