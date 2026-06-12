// Feishu plugin module persists streaming card text for quoted-message hydration.
import { createHash } from "node:crypto";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { getFeishuRuntime } from "./runtime.js";

const STREAMING_CARD_CONTENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const STORE_MAX_ENTRIES = 20_000;
const MEMORY_MAX_SIZE = 2_000;
const STORE_NAMESPACE = "streaming-card-content";

type FeishuStreamingCardContentEntry = {
  cardId: string;
  messageId: string;
  accountId?: string;
  chatId?: string;
  text: string;
  updatedAt: number;
};

type RecordFeishuStreamingCardContentParams = {
  cardId?: string | null;
  messageId?: string | null;
  accountId?: string | null;
  chatId?: string | null;
  text?: string | null;
  updatedAt?: number;
  log?: (message: string) => void;
};

type LookupFeishuStreamingCardContentParams = {
  cardId?: string | null;
  messageId?: string | null;
  accountId?: string | null;
  log?: (message: string) => void;
};

const memory = new Map<string, FeishuStreamingCardContentEntry>();
let cachedStore: PluginStateSyncKeyedStore<FeishuStreamingCardContentEntry> | null = null;

function normalizeId(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeOptional(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isFresh(entry: FeishuStreamingCardContentEntry | undefined, now = Date.now()): boolean {
  return Boolean(
    entry &&
    typeof entry.updatedAt === "number" &&
    Number.isFinite(entry.updatedAt) &&
    now - entry.updatedAt < STREAMING_CARD_CONTENT_TTL_MS,
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
  return account ? [`${kind}:${account}:${id}`, `${kind}:global:${id}`] : [`${kind}:global:${id}`];
}

function storeKey(rawKey: string): string {
  return createHash("sha256").update(rawKey, "utf8").digest("hex").slice(0, 32);
}

function openStore(): PluginStateSyncKeyedStore<FeishuStreamingCardContentEntry> {
  if (cachedStore) {
    return cachedStore;
  }
  cachedStore = getFeishuRuntime().state.openSyncKeyedStore<FeishuStreamingCardContentEntry>({
    namespace: STORE_NAMESPACE,
    maxEntries: STORE_MAX_ENTRIES,
    defaultTtlMs: STREAMING_CARD_CONTENT_TTL_MS,
  });
  return cachedStore;
}

function remember(rawKey: string, entry: FeishuStreamingCardContentEntry): void {
  memory.set(rawKey, entry);
  pruneMemory(entry.updatedAt);
}

function readMemory(rawKey: string): FeishuStreamingCardContentEntry | undefined {
  const entry = memory.get(rawKey);
  if (isFresh(entry)) {
    return entry;
  }
  memory.delete(rawKey);
  return undefined;
}

export function recordFeishuStreamingCardContent(
  params: RecordFeishuStreamingCardContentParams,
): boolean {
  const cardId = normalizeId(params.cardId);
  const messageId = normalizeId(params.messageId);
  if (!cardId || !messageId) {
    return false;
  }
  const updatedAt = params.updatedAt ?? Date.now();
  const entry: FeishuStreamingCardContentEntry = {
    cardId,
    messageId,
    accountId: normalizeOptional(params.accountId),
    chatId: normalizeOptional(params.chatId),
    text: typeof params.text === "string" ? params.text : "",
    updatedAt,
  };
  const rawKeys = [
    ...scopedRecordKeys("message", messageId, entry.accountId),
    ...scopedRecordKeys("card", cardId, entry.accountId),
  ];

  for (const rawKey of rawKeys) {
    remember(rawKey, entry);
  }

  try {
    const store = openStore();
    for (const rawKey of rawKeys) {
      store.register(storeKey(rawKey), entry, { ttlMs: STREAMING_CARD_CONTENT_TTL_MS });
    }
    return true;
  } catch (error) {
    params.log?.(`feishu-streaming-card-content: persistent state error: ${String(error)}`);
    return true;
  }
}

function lookupRawKey(
  rawKey: string,
  log?: (message: string) => void,
): FeishuStreamingCardContentEntry | undefined {
  const memoryEntry = readMemory(rawKey);
  if (memoryEntry) {
    return memoryEntry;
  }
  try {
    const entry = openStore().lookup(storeKey(rawKey));
    if (!entry || !isFresh(entry)) {
      return undefined;
    }
    remember(rawKey, entry);
    return entry;
  } catch (error) {
    log?.(`feishu-streaming-card-content: persistent lookup failed: ${String(error)}`);
    return undefined;
  }
}

export function lookupFeishuStreamingCardContent(
  params: LookupFeishuStreamingCardContentParams,
): FeishuStreamingCardContentEntry | undefined {
  const accountId = normalizeOptional(params.accountId);
  const messageId = normalizeId(params.messageId);
  const cardId = normalizeId(params.cardId);
  const rawKeys: string[] = [];
  if (messageId) {
    rawKeys.push(...scopedLookupKeys("message", messageId, accountId));
  }
  if (cardId) {
    rawKeys.push(...scopedLookupKeys("card", cardId, accountId));
  }

  for (const rawKey of rawKeys) {
    const entry = lookupRawKey(rawKey, params.log);
    if (entry?.text.trim()) {
      return entry;
    }
  }
  return undefined;
}

export const testingHooks = {
  resetFeishuStreamingCardContentIndexForTests() {
    memory.clear();
    cachedStore?.clear();
    cachedStore = null;
  },
  resetFeishuStreamingCardContentMemoryForTests() {
    memory.clear();
  },
};
