import { createHash } from "node:crypto";
import { createPluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";

const MAX_ENTRIES = 2_048;
const TOPIC_NAME_CACHE_STATE_KEY = Symbol.for("openclaw.telegramTopicNameCacheState");
const DEFAULT_TOPIC_NAME_CACHE_KEY = "__default__";
const TOPIC_NAME_STORE = createPluginStateSyncKeyedStore<TopicEntry & { scopeKey: string }>(
  "telegram",
  {
    namespace: "topic-names",
    maxEntries: 50_000,
  },
);

type TopicEntry = {
  name: string;
  iconColor?: number;
  iconCustomEmojiId?: string;
  closed?: boolean;
  updatedAt: number;
};

type TopicNameStore = Map<string, TopicEntry>;

type TopicNameStoreState = {
  lastUpdatedAt: number;
  store: TopicNameStore;
};

type TopicNameCacheState = {
  stores: Map<string, TopicNameStoreState>;
};

function getTopicNameCacheState(): TopicNameCacheState {
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  const existing = globalStore[TOPIC_NAME_CACHE_STATE_KEY] as TopicNameCacheState | undefined;
  if (existing) {
    return existing;
  }
  const state: TopicNameCacheState = { stores: new Map() };
  globalStore[TOPIC_NAME_CACHE_STATE_KEY] = state;
  return state;
}

export function resolveTopicNameCacheScope(scope: string): string {
  const trimmed = scope.trim();
  return trimmed ? `telegram-topic-names:${trimmed}` : DEFAULT_TOPIC_NAME_CACHE_KEY;
}

function topicEntryKey(
  scopeKey: string,
  chatId: number | string,
  threadId: number | string,
): string {
  return createHash("sha256")
    .update(`${scopeKey}\0${String(chatId)}\0${String(threadId)}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}

function evictOldest(store: TopicNameStore): string | undefined {
  if (store.size <= MAX_ENTRIES) {
    return undefined;
  }
  let oldestKey: string | undefined;
  let oldestTime = Infinity;
  for (const [key, entry] of store) {
    if (entry.updatedAt < oldestTime) {
      oldestTime = entry.updatedAt;
      oldestKey = key;
    }
  }
  if (oldestKey) {
    store.delete(oldestKey);
  }
  return oldestKey;
}

function isTopicEntry(value: unknown): value is TopicEntry {
  if (!value || typeof value !== "object") {
    return false;
  }
  const entry = value as Partial<TopicEntry>;
  return (
    typeof entry.name === "string" &&
    entry.name.length > 0 &&
    typeof entry.updatedAt === "number" &&
    Number.isFinite(entry.updatedAt)
  );
}

function readPersistedTopicNames(scopeKey: string): TopicNameStore {
  const entries = TOPIC_NAME_STORE.entries()
    .filter((entry) => entry.value.scopeKey === scopeKey && isTopicEntry(entry.value))
    .map((entry): [string, TopicEntry] => {
      const { scopeKey: _scopeKey, ...value } = entry.value;
      return [entry.key, value];
    })
    .toSorted(([, left], [, right]) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_ENTRIES);
  return new Map(entries);
}

function getTopicStoreState(scopeKey?: string): TopicNameStoreState {
  const state = getTopicNameCacheState();
  const stateKey = scopeKey ?? DEFAULT_TOPIC_NAME_CACHE_KEY;
  const existing = state.stores.get(stateKey);
  if (existing) {
    return existing;
  }
  const next = {
    lastUpdatedAt: 0,
    store: readPersistedTopicNames(stateKey),
  };
  next.lastUpdatedAt = Math.max(0, ...Array.from(next.store.values(), (entry) => entry.updatedAt));
  state.stores.set(stateKey, next);
  return next;
}

function getTopicStore(scopeKey?: string): TopicNameStore {
  return getTopicStoreState(scopeKey).store;
}

function nextUpdatedAt(scopeKey?: string): number {
  const state = getTopicStoreState(scopeKey);
  const now = Date.now();
  state.lastUpdatedAt = now > state.lastUpdatedAt ? now : state.lastUpdatedAt + 1;
  return state.lastUpdatedAt;
}

function removeTopicStore(scopeKey?: string): void {
  const state = getTopicNameCacheState();
  const stateKey = scopeKey ?? DEFAULT_TOPIC_NAME_CACHE_KEY;
  for (const entry of TOPIC_NAME_STORE.entries()) {
    if (entry.value.scopeKey === stateKey) {
      TOPIC_NAME_STORE.delete(entry.key);
    }
  }
  state.stores.delete(stateKey);
}

function persistTopicEntry(scopeKey: string, key: string, entry: TopicEntry): void {
  TOPIC_NAME_STORE.register(key, {
    scopeKey,
    name: entry.name,
    updatedAt: entry.updatedAt,
    ...(typeof entry.iconColor === "number" ? { iconColor: entry.iconColor } : {}),
    ...(typeof entry.iconCustomEmojiId === "string"
      ? { iconCustomEmojiId: entry.iconCustomEmojiId }
      : {}),
    ...(typeof entry.closed === "boolean" ? { closed: entry.closed } : {}),
  });
}

export function updateTopicName(
  chatId: number | string,
  threadId: number | string,
  patch: Partial<Omit<TopicEntry, "updatedAt">>,
  optionalScopeKey?: string,
): void {
  const scopeKey = optionalScopeKey ?? DEFAULT_TOPIC_NAME_CACHE_KEY;
  const cache = getTopicStore(scopeKey);
  const storeKey = topicEntryKey(scopeKey, chatId, threadId);
  const existing = cache.get(storeKey);
  const merged: TopicEntry = {
    name: patch.name ?? existing?.name ?? "",
    iconColor: patch.iconColor ?? existing?.iconColor,
    iconCustomEmojiId: patch.iconCustomEmojiId ?? existing?.iconCustomEmojiId,
    closed: patch.closed ?? existing?.closed,
    updatedAt: nextUpdatedAt(scopeKey),
  };
  if (!merged.name) {
    return;
  }
  cache.set(storeKey, merged);
  const evictedKey = evictOldest(cache);
  if (evictedKey) {
    TOPIC_NAME_STORE.delete(evictedKey);
  }
  persistTopicEntry(scopeKey, storeKey, merged);
}

export function getTopicName(
  chatId: number | string,
  threadId: number | string,
  optionalScopeKey?: string,
): string | undefined {
  const scopeKey = optionalScopeKey ?? DEFAULT_TOPIC_NAME_CACHE_KEY;
  const entry = getTopicStore(scopeKey).get(topicEntryKey(scopeKey, chatId, threadId));
  if (entry) {
    entry.updatedAt = nextUpdatedAt(scopeKey);
  }
  return entry?.name;
}

export function getTopicEntry(
  chatId: number | string,
  threadId: number | string,
  optionalScopeKey?: string,
): TopicEntry | undefined {
  const scopeKey = optionalScopeKey ?? DEFAULT_TOPIC_NAME_CACHE_KEY;
  return getTopicStore(scopeKey).get(topicEntryKey(scopeKey, chatId, threadId));
}

export function clearTopicNameCache(): void {
  const state = getTopicNameCacheState();
  for (const stateKey of state.stores.keys()) {
    removeTopicStore(stateKey === DEFAULT_TOPIC_NAME_CACHE_KEY ? undefined : stateKey);
  }
}

export function topicNameCacheSize(): number {
  return getTopicStore().size;
}

export function resetTopicNameCacheForTest(): void {
  getTopicNameCacheState().stores.clear();
}

export function resetTopicNameCacheStoreForTest(): void {
  getTopicNameCacheState().stores.clear();
  TOPIC_NAME_STORE.clear();
}
