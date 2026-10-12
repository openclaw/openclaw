// Signal plugin module tracks native-reply quote authors for durable sends.
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import type { MediaPlaceholderTextFact } from "openclaw/plugin-sdk/channel-inbound";
import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import {
  asPositiveSafeInteger,
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeSignalMessagingTarget } from "./normalize.js";
import { signalReplyAuthorState, type SignalReplyContextRecord } from "./reply-authors-state.js";
import { getOptionalSignalRuntime } from "./runtime.js";

const PERSISTENT_NAMESPACE = "signal.reply-authors.v1";
const PERSISTENT_MAX_ENTRIES = 5000;
const DEFAULT_REPLY_AUTHOR_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type SignalPersistedReplyContext =
  | { author: string; body?: string; media?: MediaPlaceholderTextFact[]; ambiguous?: never }
  | { ambiguous: true; author?: never; body?: never };

const { memoryReplyContexts } = signalReplyAuthorState;
const replyContextWrites = new KeyedAsyncQueue();

function openSignalReplyAuthorStore() {
  const runtime = getOptionalSignalRuntime();
  try {
    return runtime?.state.openKeyedStoreV2<SignalReplyContextRecord>({
      namespace: PERSISTENT_NAMESPACE,
      maxEntries: PERSISTENT_MAX_ENTRIES,
      defaultTtlMs: DEFAULT_REPLY_AUTHOR_TTL_MS,
    });
  } catch (error) {
    runtime?.logging
      .getChildLogger({ plugin: "signal", feature: "reply-author-state" })
      .warn("Signal persistent reply author state unavailable", { error: String(error) });
    return undefined;
  }
}

function resolveSignalReplyIdentity(params: {
  accountId?: string | null;
  to: string;
  replyToId?: string | null;
}) {
  const conversationKey = normalizeSignalMessagingTarget(params.to);
  const replyToId = normalizeOptionalString(params.replyToId);
  if (!conversationKey || !replyToId) {
    return undefined;
  }
  const accountKey = normalizeLowercaseStringOrEmpty(
    normalizeOptionalString(params.accountId) ?? DEFAULT_ACCOUNT_ID,
  );
  return {
    key: `account=${accountKey}|to=${conversationKey}|id=${replyToId}`,
    accountId: accountKey,
    conversationKey,
    replyToId,
  };
}

function pruneMemoryReplyContexts(now = Date.now()): void {
  for (const [key, record] of memoryReplyContexts) {
    if (record.expiresAt <= now) {
      memoryReplyContexts.delete(key);
    }
  }
  pruneMapToMaxSize(memoryReplyContexts, PERSISTENT_MAX_ENTRIES);
}

function resolveReplyContext(
  record: SignalReplyContextRecord | undefined,
): SignalPersistedReplyContext | undefined {
  if (!record) {
    return undefined;
  }
  if (record.kind === "ambiguous") {
    return { ambiguous: true };
  }
  const author = normalizeOptionalString(record.author);
  if (!author) {
    return undefined;
  }
  const body = normalizeOptionalString(record.body);
  const media = record.media;
  return {
    author,
    ...(body ? { body } : {}),
    ...(media?.length ? { media } : {}),
  };
}

function mergeReplyContext(
  current: SignalReplyContextRecord | undefined,
  next: SignalReplyContextRecord,
): SignalReplyContextRecord {
  if (!current) {
    return next;
  }
  if (current.kind === "ambiguous") {
    return current;
  }
  if (next.kind === "ambiguous") {
    return next;
  }
  if (current.author !== next.author) {
    const { author: _author, body: _body, media: _media, ...identity } = next;
    return { ...identity, kind: "ambiguous" };
  }
  return next.sourceTimestamp >= current.sourceTimestamp ? next : current;
}

export async function registerSignalReplyContext(params: {
  accountId?: string | null;
  to: string;
  replyToId?: string | null;
  author?: string | null;
  body?: string | null;
  media?: readonly MediaPlaceholderTextFact[] | null;
  sourceTimestamp?: number | null;
}): Promise<void> {
  const store = openSignalReplyAuthorStore();
  const identity = resolveSignalReplyIdentity(params);
  const author = normalizeOptionalString(params.author);
  const body = normalizeOptionalString(params.body);
  const media = params.media?.map((entry) => ({
    contentType: normalizeOptionalString(entry.contentType),
    kind: entry.kind ?? undefined,
  }));
  const sourceTimestamp = asPositiveSafeInteger(params.sourceTimestamp) ?? Date.now();
  if (!identity || !author) {
    return;
  }
  const { key, ...replyIdentity } = identity;
  const registeredAt = Date.now();
  const record = {
    kind: "resolved" as const,
    author,
    ...(body ? { body } : {}),
    ...(media?.length ? { media } : {}),
    ...replyIdentity,
    sourceTimestamp,
    registeredAt,
  };
  const expiresAt = registeredAt + DEFAULT_REPLY_AUTHOR_TTL_MS;
  await replyContextWrites.enqueue(key, async () => {
    const cached = memoryReplyContexts.get(key);
    let next = mergeReplyContext(
      cached && cached.expiresAt > registeredAt ? cached : undefined,
      record,
    );
    try {
      if (store) {
        next = mergeReplyContext(await store.lookup(key), next);
        await store.register(key, next);
      }
    } catch (error) {
      getOptionalSignalRuntime()
        ?.logging.getChildLogger({ plugin: "signal", feature: "reply-author-state" })
        .warn("Signal persistent reply author state failed", { error: String(error) });
    }
    // The plugin serializes its own writes; foreign writes during this read/write are best effort.
    memoryReplyContexts.set(key, { ...next, expiresAt });
    pruneMemoryReplyContexts(registeredAt);
  });
}

export async function resolveSignalReplyContextWithPersistence(params: {
  accountId?: string | null;
  to: string;
  replyToId?: string | null;
}): Promise<SignalPersistedReplyContext | undefined> {
  const store = openSignalReplyAuthorStore();
  const key = resolveSignalReplyIdentity(params)?.key;
  if (!key) {
    return undefined;
  }
  pruneMemoryReplyContexts();
  const memoryContext = resolveReplyContext(memoryReplyContexts.get(key));
  if (!store || memoryContext) {
    return memoryContext;
  }
  try {
    return resolveReplyContext(await store.lookup(key));
  } catch (error) {
    getOptionalSignalRuntime()
      ?.logging.getChildLogger({ plugin: "signal", feature: "reply-author-state" })
      .warn("Signal persistent reply author lookup failed", { error: String(error) });
    return undefined;
  }
}
