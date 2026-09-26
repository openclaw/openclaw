import { createHash } from "node:crypto";
import { resolveGlobalSingleton } from "openclaw/plugin-sdk/global-singleton";
import { getTelegramRuntime } from "./runtime.js";

const TELEGRAM_TOPIC_NAME_CACHE_MAX_ENTRIES = 2_048;
const STORE_NAMESPACE_PREFIX = "telegram.topic-name-cache";
const TOPIC_NAME_CACHE_STATE_KEY = Symbol.for("openclaw.telegramTopicNameCacheState");
const DEFAULT_TOPIC_NAME_CACHE_SCOPE = "default";

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
  hydrated: boolean;
  hydratePromise?: Promise<void>;
  persistentStore: TopicNamePersistentStore;
};

type TopicNameCacheState = {
  stores: Map<string, TopicNameStoreState>;
};

type TopicNamePersistentStore = {
  register(key: string, value: TopicEntry): Promise<void>;
  entries(): Promise<Array<{ key: string; value: TopicEntry }>>;
  delete(key: string): Promise<boolean>;
  clear(): Promise<void>;
};

function createTopicNameStoreState(namespace: string): TopicNameStoreState {
  return {
    lastUpdatedAt: 0,
    store: new Map(),
    hydrated: false,
    persistentStore: openTopicNamePersistentStore(namespace),
  };
}

function getTopicNameCacheState(): TopicNameCacheState {
  return resolveGlobalSingleton(TOPIC_NAME_CACHE_STATE_KEY, () => ({ stores: new Map() }));
}

function cacheKey(chatId: number | string, threadId: number | string): string {
  return `${chatId}:${threadId}`;
}

function resolveTopicNameCacheNamespace(scope: string): string {
  const hash = createHash("sha256").update(scope).digest("hex").slice(0, 16);
  return `${STORE_NAMESPACE_PREFIX}.${hash}`;
}

function openTopicNamePersistentStore(namespace: string): TopicNamePersistentStore {
  return getTelegramRuntime().state.openKeyedStore<TopicEntry>({
    namespace,
    maxEntries: TELEGRAM_TOPIC_NAME_CACHE_MAX_ENTRIES,
  });
}

function evictOldest(store: TopicNameStore): string | undefined {
  if (store.size <= TELEGRAM_TOPIC_NAME_CACHE_MAX_ENTRIES) {
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

function getTopicStoreState(scope?: string): TopicNameStoreState {
  const state = getTopicNameCacheState();
  const stateKey = scope ?? DEFAULT_TOPIC_NAME_CACHE_SCOPE;
  const existing = state.stores.get(stateKey);
  if (existing) {
    return existing;
  }
  const next = createTopicNameStoreState(resolveTopicNameCacheNamespace(stateKey));
  state.stores.set(stateKey, next);
  return next;
}

async function hydrateTopicStoreState(state: TopicNameStoreState): Promise<void> {
  if (state.hydrated) {
    return;
  }
  if (state.hydratePromise) {
    await state.hydratePromise;
    return;
  }
  state.hydratePromise = (async () => {
    const entries = await state.persistentStore.entries();
    for (const { key, value } of entries) {
      if (isTopicEntry(value)) {
        state.store.set(key, value);
      }
    }
    state.lastUpdatedAt = Math.max(
      0,
      ...Array.from(state.store.values(), (entry) => entry.updatedAt),
    );
    state.hydrated = true;
  })().finally(() => {
    state.hydratePromise = undefined;
  });
  await state.hydratePromise;
}

function nextUpdatedAt(scope?: string): number {
  const state = getTopicStoreState(scope);
  const now = Date.now();
  state.lastUpdatedAt = now > state.lastUpdatedAt ? now : state.lastUpdatedAt + 1;
  return state.lastUpdatedAt;
}

export async function updateTopicName(
  chatId: number | string,
  threadId: number | string,
  patch: Partial<Omit<TopicEntry, "updatedAt">>,
  scope?: string,
): Promise<void> {
  const state = getTopicStoreState(scope);
  await hydrateTopicStoreState(state);
  const key = cacheKey(chatId, threadId);
  const existing = state.store.get(key);
  const iconColor = patch.iconColor ?? existing?.iconColor;
  const iconCustomEmojiId = patch.iconCustomEmojiId ?? existing?.iconCustomEmojiId;
  const closed = patch.closed ?? existing?.closed;
  const merged: TopicEntry = {
    name: patch.name ?? existing?.name ?? "",
    updatedAt: nextUpdatedAt(scope),
    ...(iconColor !== undefined ? { iconColor } : {}),
    ...(iconCustomEmojiId !== undefined ? { iconCustomEmojiId } : {}),
    ...(closed !== undefined ? { closed } : {}),
  };
  if (!merged.name) {
    return;
  }
  state.store.set(key, merged);
  await state.persistentStore.register(key, merged);
  const evictedKey = evictOldest(state.store);
  if (evictedKey) {
    await state.persistentStore.delete(evictedKey);
  }
}

export async function getTopicName(
  chatId: number | string,
  threadId: number | string,
  scope?: string,
): Promise<string | undefined> {
  const state = getTopicStoreState(scope);
  await hydrateTopicStoreState(state);
  const key = cacheKey(chatId, threadId);
  const entry = state.store.get(key);
  if (entry) {
    entry.updatedAt = nextUpdatedAt(scope);
    await state.persistentStore.register(key, entry);
  }
  return entry?.name;
}
