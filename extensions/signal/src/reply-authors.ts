// Signal plugin module tracks native-reply quote authors for durable sends.
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import type { MediaPlaceholderTextFact } from "openclaw/plugin-sdk/channel-inbound";
import {
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

function openSignalReplyAuthorStore() {
  if (signalReplyAuthorState.persistentStoreDisabled) {
    return undefined;
  }
  const runtime = getOptionalSignalRuntime();
  try {
    return runtime?.state.openKeyedStore<SignalReplyContextRecord>({
      namespace: PERSISTENT_NAMESPACE,
      maxEntries: PERSISTENT_MAX_ENTRIES,
      defaultTtlMs: DEFAULT_REPLY_AUTHOR_TTL_MS,
    });
  } catch (error) {
    signalReplyAuthorState.persistentStoreDisabled = true;
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

function pruneMemoryReplyContexts(now = Date.now()): void {
  for (const [key, record] of memoryReplyContexts) {
    if (record.expiresAt <= now) {
      memoryReplyContexts.delete(key);
    }
  }
  while (memoryReplyContexts.size > PERSISTENT_MAX_ENTRIES) {
    const oldestKey = memoryReplyContexts.keys().next().value;
    if (!oldestKey) {
      break;
    }
    memoryReplyContexts.delete(oldestKey);
  }
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

function resolveSourceTimestamp(value: number | null | undefined): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : Date.now();
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
  const key = buildSignalReplyAuthorStoreKey(params);
  const author = normalizeOptionalString(params.author);
  const body = normalizeOptionalString(params.body);
  const media = params.media?.map((entry) => ({
    contentType: normalizeOptionalString(entry.contentType),
    kind: entry.kind ?? undefined,
  }));
  const conversationKey = normalizeSignalMessagingTarget(params.to);
  const replyToId = normalizeOptionalString(params.replyToId);
  const accountKey = normalizeLowercaseStringOrEmpty(
    normalizeOptionalString(params.accountId) ?? DEFAULT_ACCOUNT_ID,
  );
  const sourceTimestamp = resolveSourceTimestamp(params.sourceTimestamp);
  if (!key || !author || !conversationKey || !replyToId) {
    return;
  }
  const registeredAt = Date.now();
  const record = {
    kind: "resolved" as const,
    author,
    ...(body ? { body } : {}),
    ...(media?.length ? { media } : {}),
    accountId: accountKey,
    conversationKey,
    replyToId,
    sourceTimestamp,
    registeredAt,
  };
  const expiresAt = registeredAt + DEFAULT_REPLY_AUTHOR_TTL_MS;
  if (!store) {
    const next = mergeReplyContext(memoryReplyContexts.get(key), record);
    memoryReplyContexts.set(key, { ...next, expiresAt });
    pruneMemoryReplyContexts(registeredAt);
    return;
  }
  const usesComparisons = Boolean(store.observe && store.compareAndApply);
  if (!store.update && !usesComparisons) {
    const next = mergeReplyContext(memoryReplyContexts.get(key), record);
    memoryReplyContexts.set(key, { ...next, expiresAt });
    pruneMemoryReplyContexts(registeredAt);
    signalReplyAuthorState.persistentStoreDisabled = true;
    getOptionalSignalRuntime()
      ?.logging.getChildLogger({ plugin: "signal", feature: "reply-author-state" })
      .warn("Signal persistent reply author state lacks atomic updates");
    return;
  }
  const cachedBeforeUpdate = memoryReplyContexts.get(key);
  const cacheReplyContext = (next: SignalReplyContextRecord | undefined) => {
    const current = memoryReplyContexts.get(key);
    const changedDuringUpdate = usesComparisons && current !== cachedBeforeUpdate;
    if (!next) {
      if (!changedDuringUpdate) {
        memoryReplyContexts.delete(key);
      }
      return;
    }
    // Async adapters may settle committed comparisons out of order. Reconcile only
    // concurrent live publications, never an untouched or expired cached record.
    const concurrent =
      changedDuringUpdate && current && current.expiresAt > registeredAt ? current : undefined;
    memoryReplyContexts.set(key, {
      ...(concurrent ? mergeReplyContext(concurrent, next) : next),
      expiresAt: Math.max(expiresAt, concurrent?.expiresAt ?? expiresAt),
    });
  };
  let updateEvaluated = false;
  let nextRecord: SignalReplyContextRecord | undefined;
  try {
    let updated = false;
    if (store.observe && store.compareAndApply) {
      let observation = await store.observe(key);
      for (;;) {
        updateEvaluated = true;
        nextRecord = mergeReplyContext(observation.value, record);
        const result = await store.compareAndApply(key, observation.comparison, {
          operation: "update",
          // Retained values still refresh the row's age and TTL, as update did.
          action: "set",
          value: nextRecord,
        });
        if (result.status !== "conflict") {
          updated = result.status === "applied";
          break;
        }
        observation = result.current;
      }
    } else if (store.update) {
      // Published 2026.9.4 hosts lack comparisons; remove at a supporting host floor.
      updated = await store.update(key, (current) => {
        updateEvaluated = true;
        nextRecord = mergeReplyContext(current, record);
        return nextRecord;
      });
    }
    cacheReplyContext(updated ? nextRecord : undefined);
    pruneMemoryReplyContexts(registeredAt);
  } catch (error) {
    if (!updateEvaluated) {
      try {
        nextRecord = mergeReplyContext(await store.lookup(key), record);
      } catch {
        nextRecord = undefined;
      }
    }
    const next = nextRecord;
    if (next || updateEvaluated) {
      cacheReplyContext(next);
    }
    pruneMemoryReplyContexts(registeredAt);
    getOptionalSignalRuntime()
      ?.logging.getChildLogger({ plugin: "signal", feature: "reply-author-state" })
      .warn("Signal persistent reply author state failed", { error: String(error) });
  }
}

export async function resolveSignalReplyContextWithPersistence(params: {
  accountId?: string | null;
  to: string;
  replyToId?: string | null;
}): Promise<SignalPersistedReplyContext | undefined> {
  const store = openSignalReplyAuthorStore();
  const key = buildSignalReplyAuthorStoreKey(params);
  if (!key) {
    return undefined;
  }
  if (!store) {
    pruneMemoryReplyContexts();
    return resolveReplyContext(memoryReplyContexts.get(key));
  }
  pruneMemoryReplyContexts();
  const memoryContext = resolveReplyContext(memoryReplyContexts.get(key));
  if (memoryContext) {
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
