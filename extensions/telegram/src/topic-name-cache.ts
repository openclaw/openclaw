import { createHash } from "node:crypto";
import { resolveGlobalSingleton } from "openclaw/plugin-sdk/global-singleton";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { getTelegramRuntime } from "./runtime.js";
import { resolveTelegramTargetChatType } from "./targets.js";

const TELEGRAM_TOPIC_NAME_CACHE_MAX_ENTRIES = 2_048;
const STORE_NAMESPACE_PREFIX = "telegram.topic-name-cache";
const TOPIC_NAME_CACHE_STATE_KEY = Symbol.for("openclaw.telegramTopicNameCacheState");
const DEFAULT_TOPIC_NAME_CACHE_SCOPE = "default";

type TopicEntry = {
  name: string;
  /** Telegram observed an implicit creation name, not a user-selected title. */
  isNameImplicit?: boolean;
  creatorUserId?: number;
  iconColor?: number;
  iconCustomEmojiId?: string;
  closed?: boolean;
  updatedAt: number;
};

type TopicNameStore = Map<string, TopicEntry>;

type TopicNameStoreState = {
  lastUpdatedAt: number;
  store: TopicNameStore;
  hydratePromise?: Promise<void>;
  mutationTail?: Promise<void>;
  legacyImportAttempts?: number;
  persistentStore: PluginStateKeyedStore<TopicEntry>;
  /** Full cache scope (store path plus account suffix) backing this state. */
  scopeKey: string;
};

type TopicNameCacheState = {
  stores: Map<string, TopicNameStoreState>;
};

function cacheKey(chatId: number | string, threadId: number | string): string {
  return `${chatId}:${threadId}`;
}

export function resolveTelegramDirectTopicNameCacheScope(scope: string, accountId: string): string {
  return scope + "\u0000telegram-account:" + accountId;
}

/** Match inbound metadata namespaces using an already resolved Telegram chat ID. */
export function resolveTelegramTopicNameCacheScope(
  scope: string,
  accountId: string,
  chatId: string,
): string {
  return resolveTelegramTargetChatType(chatId) === "direct"
    ? resolveTelegramDirectTopicNameCacheScope(scope, accountId)
    : scope;
}

function resolveTopicNameCacheNamespace(scope: string): string {
  const hash = createHash("sha256").update(scope).digest("hex").slice(0, 16);
  return `${STORE_NAMESPACE_PREFIX}.${hash}`;
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

// Legacy import and inbound updates share the same bounded namespace. Serialize
// their retention decision with the write so a background copy cannot evict or
// overwrite a newer inbound name or creator fact while awaiting storage.
function mutateTopicStore<T>(state: TopicNameStoreState, run: () => Promise<T>): Promise<T> {
  const result = (state.mutationTail ?? Promise.resolve()).then(run);
  state.mutationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

async function persistTopicEntry(
  state: TopicNameStoreState,
  key: string,
  entry: TopicEntry,
): Promise<void> {
  state.store.set(key, entry);
  const evictedKey = evictOldest(state.store);
  // Delete before registering: the backing store's insertion-order cap must
  // not evict a fresh account row on behalf of an older imported row.
  try {
    if (evictedKey) {
      await state.persistentStore.delete(evictedKey);
    }
    if (evictedKey !== key) {
      await state.persistentStore.register(key, entry);
    }
  } catch (error) {
    state.hydratePromise = undefined;
    throw error;
  }
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
  const state = resolveGlobalSingleton<TopicNameCacheState>(TOPIC_NAME_CACHE_STATE_KEY, () => ({
    stores: new Map(),
  }));
  const stateKey = scope ?? DEFAULT_TOPIC_NAME_CACHE_SCOPE;
  const existing = state.stores.get(stateKey);
  if (existing) {
    return existing;
  }
  const namespace = resolveTopicNameCacheNamespace(stateKey);
  const next: TopicNameStoreState = {
    lastUpdatedAt: 0,
    store: new Map(),
    scopeKey: stateKey,
    persistentStore: getTelegramRuntime().state.openKeyedStore<TopicEntry>({
      namespace,
      maxEntries: TELEGRAM_TOPIC_NAME_CACHE_MAX_ENTRIES,
    }),
  };
  state.stores.set(stateKey, next);
  return next;
}

const LEGACY_ACCOUNT_SCOPE_MARKER = "\0telegram-account:";

function hydrateTopicStoreState(state: TopicNameStoreState): Promise<void> {
  state.hydratePromise ??= (async () => {
    await mutateTopicStore(state, async () => {
      const entries = await state.persistentStore.entries();
      state.store.clear();
      for (const { key, value } of entries) {
        if (isTopicEntry(value)) {
          state.store.set(key, value);
        }
      }
      state.lastUpdatedAt = Math.max(
        0,
        ...Array.from(state.store.values(), (entry) => entry.updatedAt),
      );
    });
    // Upgrade path: pre-4302875118 installs persisted topic names under the
    // bare session-store-path namespace. Every production caller now derives
    // the scope with the account id appended, which would hide those entries
    // forever (Telegram cannot recover topic ownership later). The copy is
    // resumable, idempotent, and chunked, and it runs off the inbound path so
    // lookups below never await it (Codex 4304709767, 4304709769).
    if (state.scopeKey.includes(LEGACY_ACCOUNT_SCOPE_MARKER)) {
      kickLegacyTopicEntryImport(state);
    }
  })().catch((error: unknown) => {
    state.hydratePromise = undefined;
    throw error;
  });
  return state.hydratePromise;
}

const LEGACY_IMPORT_CHUNK = 32;
const LEGACY_IMPORT_YIELD_MS = 25;
const LEGACY_IMPORT_MAX_ATTEMPTS = 3;

/**
 * Resumable, idempotent upgrade copy of the pre-account-scoped topic
 * namespace (Codex 4304709767): a crash or a rejected register after some
 * rows were copied must not lose the remaining rows (their creatorUserId
 * facts are unrecoverable from Telegram), so existing account rows retain
 * their current state while missing ownership is backfilled. Copies
 * in bounded chunks with pauses between them so bulk legacy writes never
 * monopolise the state store's write lane against concurrent inbound lookups
 * (Codex 4304709769).
 */
async function importLegacyTopicEntries(state: TopicNameStoreState): Promise<void> {
  const markerIndex = state.scopeKey.indexOf(LEGACY_ACCOUNT_SCOPE_MARKER);
  if (markerIndex <= 0) {
    return;
  }
  const legacyScope = state.scopeKey.slice(0, markerIndex);
  const legacyEntries = await getTopicStoreState(legacyScope).persistentStore.entries();
  let copied = 0;
  for (const { key, value } of legacyEntries) {
    if (!isTopicEntry(value)) {
      continue;
    }
    // Durable idempotency: a row copied by a previous (possibly crashed) run
    // persists in the account-scoped store even when this run's memory map
    // has not observed it; re-copying would clobber a newer rename.
    await mutateTopicStore(state, async () => {
      const cached = state.store.get(key);
      const durable = cached ?? (await state.persistentStore.lookup(key));
      if (isTopicEntry(durable)) {
        if (durable.creatorUserId === undefined && value.creatorUserId !== undefined) {
          await persistTopicEntry(state, key, { ...durable, creatorUserId: value.creatorUserId });
        } else if (!cached) {
          await persistTopicEntry(state, key, durable);
        }
        return;
      }
      await persistTopicEntry(state, key, value);
    });
    copied += 1;
    if (copied % LEGACY_IMPORT_CHUNK === 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, LEGACY_IMPORT_YIELD_MS);
      });
    }
  }
}

/** Runs the background legacy import once per hydration, attempt-capped. */
function kickLegacyTopicEntryImport(state: TopicNameStoreState): void {
  if ((state.legacyImportAttempts ?? 0) >= LEGACY_IMPORT_MAX_ATTEMPTS) {
    return;
  }
  state.legacyImportAttempts = (state.legacyImportAttempts ?? 0) + 1;
  void importLegacyTopicEntries(state)
    .then(() => {
      // Completed: the cap check makes later hydrations skip re-kicking.
      state.legacyImportAttempts = LEGACY_IMPORT_MAX_ATTEMPTS;
    })
    .catch((error: unknown) => {
      // Resumable per key: the next cache operation re-hydrates and retries
      // the remaining rows, bounded by the attempt cap.
      console.warn(`telegram topic-name-cache: legacy import attempt failed: ${String(error)}`);
      state.hydratePromise = undefined;
    });
}

function nextUpdatedAt(scope?: string): number {
  const state = getTopicStoreState(scope);
  const now = Date.now();
  state.lastUpdatedAt = now > state.lastUpdatedAt ? now : state.lastUpdatedAt + 1;
  return state.lastUpdatedAt;
}

async function updateTopicNameWithPatch(
  chatId: number | string,
  threadId: number | string,
  resolvePatch: (existing: TopicEntry | undefined) => Partial<Omit<TopicEntry, "updatedAt">>,
  scope?: string,
): Promise<void> {
  const state = getTopicStoreState(scope);
  await hydrateTopicStoreState(state);
  await mutateTopicStore(state, async () => {
    const key = cacheKey(chatId, threadId);
    const existing = state.store.get(key);
    const patch = resolvePatch(existing);
    const iconColor = patch.iconColor ?? existing?.iconColor;
    const iconCustomEmojiId = patch.iconCustomEmojiId ?? existing?.iconCustomEmojiId;
    const closed = patch.closed ?? existing?.closed;
    const creatorUserId = patch.creatorUserId ?? existing?.creatorUserId;
    const merged: TopicEntry = {
      name: patch.name ?? existing?.name ?? "",
      updatedAt: nextUpdatedAt(scope),
      isNameImplicit:
        patch.isNameImplicit ?? (patch.name !== undefined ? false : existing?.isNameImplicit),
      ...(iconColor !== undefined ? { iconColor } : {}),
      ...(iconCustomEmojiId !== undefined ? { iconCustomEmojiId } : {}),
      ...(closed !== undefined ? { closed } : {}),
      ...(creatorUserId !== undefined ? { creatorUserId } : {}),
    };
    if (!merged.name) {
      return;
    }
    await persistTopicEntry(state, key, merged);
  });
}

export async function updateTopicName(
  chatId: number | string,
  threadId: number | string,
  patch: Partial<Omit<TopicEntry, "updatedAt">>,
  scope?: string,
): Promise<void> {
  await updateTopicNameWithPatch(chatId, threadId, () => patch, scope);
}

export async function getTopicName(
  chatId: number | string,
  threadId: number | string,
  scope?: string,
): Promise<string | undefined> {
  const state = getTopicStoreState(scope);
  await hydrateTopicStoreState(state);
  return mutateTopicStore(state, async () => {
    const key = cacheKey(chatId, threadId);
    const entry = state.store.get(key);
    if (entry) {
      entry.updatedAt = nextUpdatedAt(scope);
      await state.persistentStore.register(key, entry);
    }
    return entry?.name;
  });
}

export async function recordTopicCreation(
  chatId: number | string,
  threadId: number | string,
  creation: Pick<
    TopicEntry,
    "name" | "creatorUserId" | "iconColor" | "iconCustomEmojiId" | "isNameImplicit"
  >,
  scope?: string,
): Promise<void> {
  // Decide after preceding mutations settle: a late creation service message
  // must not undo a queued rename or close that has not reached the cache yet.
  await updateTopicNameWithPatch(
    chatId,
    threadId,
    (existing) =>
      existing ? { creatorUserId: creation.creatorUserId } : { ...creation, closed: false },
    scope,
  );
}

export async function getTopicCreatorUserId(
  chatId: number | string,
  threadId: number | string,
  scope?: string,
): Promise<number | undefined> {
  const state = getTopicStoreState(scope);
  await hydrateTopicStoreState(state);
  return state.store.get(cacheKey(chatId, threadId))?.creatorUserId;
}

/** Unknown legacy names are never treated as platform placeholders. */
export async function isTopicNameImplicit(
  chatId: number | string,
  threadId: number | string,
  scope?: string,
): Promise<boolean> {
  const state = getTopicStoreState(scope);
  await hydrateTopicStoreState(state);
  return state.store.get(cacheKey(chatId, threadId))?.isNameImplicit === true;
}
