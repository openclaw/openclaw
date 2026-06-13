// Feishu plugin module persists outbound card text for quoted-message hydration.
import { createHash } from "node:crypto";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { getFeishuRuntime } from "./runtime.js";

const OUTBOUND_CARD_CONTENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const STORE_MAX_ENTRIES = 20_000;
const MEMORY_MAX_SIZE = 2_000;
const STORE_NAMESPACE = "outbound-card-content";
const LEGACY_STREAMING_STORE_NAMESPACE = "streaming-card-content";

type FeishuOutboundCardContentEntry = {
  cardId?: string;
  messageId: string;
  accountId?: string;
  chatId?: string;
  text: string;
  updatedAt: number;
};

type RecordFeishuOutboundCardContentParams = {
  cardId?: string | null;
  messageId?: string | null;
  accountId?: string | null;
  chatId?: string | null;
  text?: string | null;
  updatedAt?: number;
  log?: (message: string) => void;
};

type LookupFeishuOutboundCardContentParams = {
  cardId?: string | null;
  messageId?: string | null;
  accountId?: string | null;
  log?: (message: string) => void;
};

type InvalidateFeishuOutboundCardContentParams = {
  messageId?: string | null;
  accountId?: string | null;
  log?: (message: string) => void;
};

const memory = new Map<string, FeishuOutboundCardContentEntry>();
const cachedStores = new Map<string, PluginStateSyncKeyedStore<FeishuOutboundCardContentEntry>>();

function normalizeId(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeMessageId(value: string | null | undefined): string | undefined {
  const trimmed = normalizeId(value);
  return trimmed && trimmed !== "unknown" ? trimmed : undefined;
}

function normalizeOptional(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeText(value: string | null | undefined): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  return value;
}

function isFresh(entry: FeishuOutboundCardContentEntry | undefined, now = Date.now()): boolean {
  return Boolean(
    entry &&
    typeof entry.updatedAt === "number" &&
    Number.isFinite(entry.updatedAt) &&
    now - entry.updatedAt < OUTBOUND_CARD_CONTENT_TTL_MS,
  );
}

function pruneMemory(now = Date.now()): void {
  for (const [key, entry] of memory) {
    if (!isFresh(entry, now)) {
      memory.delete(key);
    }
  }
  if (memory.size <= MEMORY_MAX_SIZE) {
    return;
  }
  const toRemove = Array.from(memory.entries())
    .toSorted(([, left], [, right]) => left.updatedAt - right.updatedAt)
    .slice(0, memory.size - MEMORY_MAX_SIZE);
  for (const [key] of toRemove) {
    memory.delete(key);
  }
}

function scopedRecordKeys(kind: "card" | "message", id: string, accountId?: string): string[] {
  const account = normalizeOptional(accountId);
  return [`${kind}:${account ?? "global"}:${id}`];
}

function scopedLookupKeys(kind: "card" | "message", id: string, accountId?: string): string[] {
  const account = normalizeOptional(accountId);
  return [`${kind}:${account ?? "global"}:${id}`];
}

function storeKey(rawKey: string): string {
  return createHash("sha256").update(rawKey, "utf8").digest("hex").slice(0, 32);
}

function memoryKey(namespace: string, rawKey: string): string {
  return `${namespace}:${rawKey}`;
}

function openStore(namespace: string): PluginStateSyncKeyedStore<FeishuOutboundCardContentEntry> {
  const cached = cachedStores.get(namespace);
  if (cached) {
    return cached;
  }
  const store = getFeishuRuntime().state.openSyncKeyedStore<FeishuOutboundCardContentEntry>({
    namespace,
    maxEntries: STORE_MAX_ENTRIES,
    defaultTtlMs: OUTBOUND_CARD_CONTENT_TTL_MS,
  });
  cachedStores.set(namespace, store);
  return store;
}

function remember(namespace: string, rawKey: string, entry: FeishuOutboundCardContentEntry): void {
  memory.set(memoryKey(namespace, rawKey), entry);
  pruneMemory(entry.updatedAt);
}

function readMemory(namespace: string, rawKey: string): FeishuOutboundCardContentEntry | undefined {
  const key = memoryKey(namespace, rawKey);
  const entry = memory.get(key);
  if (isFresh(entry)) {
    return entry;
  }
  memory.delete(key);
  return undefined;
}

function recordFeishuCardContent(
  namespace: string,
  params: RecordFeishuOutboundCardContentParams,
): boolean {
  const messageId = normalizeMessageId(params.messageId);
  const text = normalizeText(params.text);
  if (!messageId || !text) {
    return false;
  }
  const cardId = normalizeId(params.cardId);
  const updatedAt = params.updatedAt ?? Date.now();
  const entry: FeishuOutboundCardContentEntry = {
    ...(cardId ? { cardId } : {}),
    messageId,
    accountId: normalizeOptional(params.accountId),
    chatId: normalizeOptional(params.chatId),
    text,
    updatedAt,
  };
  const rawKeys = [
    ...scopedRecordKeys("message", messageId, entry.accountId),
    ...(cardId ? scopedRecordKeys("card", cardId, entry.accountId) : []),
  ];

  for (const rawKey of rawKeys) {
    remember(namespace, rawKey, entry);
  }

  try {
    const store = openStore(namespace);
    for (const rawKey of rawKeys) {
      store.register(storeKey(rawKey), entry, { ttlMs: OUTBOUND_CARD_CONTENT_TTL_MS });
    }
    return true;
  } catch (error) {
    params.log?.(`feishu-outbound-card-content: persistent state error: ${String(error)}`);
    return true;
  }
}

export function recordFeishuOutboundCardContent(
  params: RecordFeishuOutboundCardContentParams,
): boolean {
  return recordFeishuCardContent(STORE_NAMESPACE, params);
}

export function recordFeishuStreamingCardContent(
  params: RecordFeishuOutboundCardContentParams,
): boolean {
  if (typeof params.text === "string" && !params.text.trim()) {
    return invalidateFeishuOutboundCardContent(params);
  }
  return recordFeishuOutboundCardContent(params);
}

function isLookupMatch(params: {
  entry: FeishuOutboundCardContentEntry;
  kind: "card" | "message";
  id: string;
  accountId?: string;
}): boolean {
  const { entry, kind, id, accountId } = params;
  if (kind === "message" && entry.messageId !== id) {
    return false;
  }
  if (kind === "card" && entry.cardId !== id) {
    return false;
  }
  const entryAccount = normalizeOptional(entry.accountId);
  return accountId ? entryAccount === accountId : entryAccount === undefined;
}

function lookupRawKey(
  namespace: string,
  rawKey: string,
  match: { kind: "card" | "message"; id: string; accountId?: string },
  log?: (message: string) => void,
): FeishuOutboundCardContentEntry | undefined {
  const memoryEntry = readMemory(namespace, rawKey);
  if (memoryEntry && isLookupMatch({ entry: memoryEntry, ...match })) {
    return memoryEntry;
  }
  try {
    const entry = openStore(namespace).lookup(storeKey(rawKey));
    if (!entry || !isFresh(entry) || !isLookupMatch({ entry, ...match })) {
      return undefined;
    }
    remember(namespace, rawKey, entry);
    return entry;
  } catch (error) {
    log?.(`feishu-outbound-card-content: persistent lookup failed: ${String(error)}`);
    return undefined;
  }
}

function lookupFeishuCardContent(
  namespace: string,
  params: LookupFeishuOutboundCardContentParams,
): FeishuOutboundCardContentEntry | undefined {
  const accountId = normalizeOptional(params.accountId);
  const messageId = normalizeMessageId(params.messageId);
  const cardId = normalizeId(params.cardId);
  const rawKeys: Array<{ rawKey: string; kind: "card" | "message"; id: string }> = [];
  if (messageId) {
    rawKeys.push(
      ...scopedLookupKeys("message", messageId, accountId).map((rawKey) => ({
        rawKey,
        kind: "message" as const,
        id: messageId,
      })),
    );
  }
  if (cardId) {
    rawKeys.push(
      ...scopedLookupKeys("card", cardId, accountId).map((rawKey) => ({
        rawKey,
        kind: "card" as const,
        id: cardId,
      })),
    );
  }

  for (const { rawKey, kind, id } of rawKeys) {
    const entry = lookupRawKey(namespace, rawKey, { kind, id, accountId }, params.log);
    if (entry?.text.trim()) {
      return entry;
    }
  }
  return undefined;
}

export function lookupFeishuOutboundCardContent(
  params: LookupFeishuOutboundCardContentParams,
): FeishuOutboundCardContentEntry | undefined {
  return lookupFeishuCardContent(STORE_NAMESPACE, params);
}

export function lookupFeishuLegacyStreamingCardContent(
  params: LookupFeishuOutboundCardContentParams,
): FeishuOutboundCardContentEntry | undefined {
  return lookupFeishuCardContent(LEGACY_STREAMING_STORE_NAMESPACE, params);
}

export function lookupFeishuStreamingCardContent(
  params: LookupFeishuOutboundCardContentParams,
): FeishuOutboundCardContentEntry | undefined {
  return lookupFeishuOutboundCardContent(params) ?? lookupFeishuLegacyStreamingCardContent(params);
}

function shouldDeleteEntry(
  entry: FeishuOutboundCardContentEntry,
  messageId: string,
  accountId?: string,
): boolean {
  if (entry.messageId !== messageId) {
    return false;
  }
  const entryAccount = normalizeOptional(entry.accountId);
  if (!accountId) {
    return true;
  }
  return entryAccount === accountId || entryAccount === undefined;
}

function invalidateNamespace(
  namespace: string,
  params: { messageId: string; accountId?: string; log?: (message: string) => void },
): boolean {
  let deleted = false;
  const namespacePrefix = `${namespace}:`;
  for (const [key, entry] of Array.from(memory.entries())) {
    if (
      key.startsWith(namespacePrefix) &&
      shouldDeleteEntry(entry, params.messageId, params.accountId)
    ) {
      memory.delete(key);
      deleted = true;
    }
  }

  try {
    const store = openStore(namespace);
    for (const { key, value } of store.entries()) {
      if (shouldDeleteEntry(value, params.messageId, params.accountId)) {
        deleted = store.delete(key) || deleted;
      }
    }
  } catch (error) {
    params.log?.(`feishu-outbound-card-content: persistent delete failed: ${String(error)}`);
  }
  return deleted;
}

export function invalidateFeishuOutboundCardContent(
  params: InvalidateFeishuOutboundCardContentParams,
): boolean {
  const messageId = normalizeMessageId(params.messageId);
  if (!messageId) {
    return false;
  }
  const accountId = normalizeOptional(params.accountId);
  const deletedCurrent = invalidateNamespace(STORE_NAMESPACE, {
    messageId,
    accountId,
    log: params.log,
  });
  const deletedLegacy = invalidateNamespace(LEGACY_STREAMING_STORE_NAMESPACE, {
    messageId,
    accountId,
    log: params.log,
  });
  return deletedCurrent || deletedLegacy;
}

export const testingHooks = {
  resetFeishuStreamingCardContentIndexForTests() {
    memory.clear();
    for (const store of cachedStores.values()) {
      store.clear();
    }
    cachedStores.clear();
  },
  resetFeishuStreamingCardContentMemoryForTests() {
    memory.clear();
  },
  recordLegacyFeishuStreamingCardContentForTests(params: RecordFeishuOutboundCardContentParams) {
    return recordFeishuCardContent(LEGACY_STREAMING_STORE_NAMESPACE, params);
  },
};
