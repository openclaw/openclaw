import { createHash } from "node:crypto";
import { normalizeAccountId } from "openclaw/plugin-sdk/account-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveGlobalSingleton } from "openclaw/plugin-sdk/global-singleton";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import type { ConversationLabelRefinementState } from "openclaw/plugin-sdk/reply-dispatch-runtime";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { resolveTelegramAccountOwnerAgentId } from "./account-owner.js";
import { resolveDefaultTelegramAccountId } from "./accounts.js";
import { getTelegramRuntime } from "./runtime.js";

const TELEGRAM_TOPIC_NAME_CACHE_MAX_ENTRIES = 2_048;
const STORE_NAMESPACE_PREFIX = "telegram.topic-name-cache";
const TOPIC_NAME_CACHE_STATE_KEY = Symbol.for("openclaw.telegramTopicNameCacheState");
const DEFAULT_TOPIC_NAME_CACHE_SCOPE = "default";

type TopicEntry = {
  name: string;
  isNameImplicit?: boolean;
  creatorUserId?: number;
  iconColor?: number;
  iconCustomEmojiId?: string;
  closed?: boolean;
  labelState?: ConversationLabelRefinementState;
  nameRevision?: number;
  updatedAt: number;
};

type TopicNameStore = Map<string, TopicEntry>;

type TopicNameStoreState = {
  lastUpdatedAt: number;
  store: TopicNameStore;
  hydratePromise?: Promise<void>;
  persistentStore: PluginStateKeyedStore<TopicEntry>;
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

export function resolveTelegramTopicNameCacheScope(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  direct: boolean;
}): string {
  const accountId = normalizeAccountId(
    params.accountId ?? resolveDefaultTelegramAccountId(params.cfg),
  );
  const scope = resolveStorePath(params.cfg.session?.store, {
    agentId: resolveTelegramAccountOwnerAgentId({ cfg: params.cfg, accountId }),
  });
  return params.direct ? resolveTelegramDirectTopicNameCacheScope(scope, accountId) : scope;
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
    persistentStore: getTelegramRuntime().state.openKeyedStore<TopicEntry>({
      namespace,
      maxEntries: TELEGRAM_TOPIC_NAME_CACHE_MAX_ENTRIES,
    }),
  };
  state.stores.set(stateKey, next);
  return next;
}

function hydrateTopicStoreState(state: TopicNameStoreState): Promise<void> {
  state.hydratePromise ??= (async () => {
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
  })().catch((error: unknown) => {
    state.hydratePromise = undefined;
    throw error;
  });
  return state.hydratePromise;
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
  const creatorUserId = patch.creatorUserId ?? existing?.creatorUserId;
  const labelState = patch.labelState ?? existing?.labelState;
  // A name update supersedes creation provenance, including a human edit.
  const isNameImplicit =
    patch.name !== undefined
      ? patch.isNameImplicit
      : (patch.isNameImplicit ?? existing?.isNameImplicit);
  const nameRevision =
    patch.name !== undefined ? (existing?.nameRevision ?? 0) + 1 : existing?.nameRevision;
  const merged: TopicEntry = {
    name: patch.name ?? existing?.name ?? "",
    updatedAt: nextUpdatedAt(scope),
    ...(nameRevision !== undefined ? { nameRevision } : {}),
    ...(labelState !== undefined ? { labelState } : {}),
    ...(isNameImplicit ? { isNameImplicit } : {}),
    ...(iconColor !== undefined ? { iconColor } : {}),
    ...(iconCustomEmojiId !== undefined ? { iconCustomEmojiId } : {}),
    ...(closed !== undefined ? { closed } : {}),
    ...(creatorUserId !== undefined ? { creatorUserId } : {}),
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

/** Returns a snapshot without refreshing access time or mutating persisted metadata. */
export async function getTopicLabelMetadata(
  chatId: number | string,
  threadId: number | string,
  scope?: string,
): Promise<
  | {
      name: string;
      nameRevision: number;
      isNameImplicit?: boolean;
      labelState?: ConversationLabelRefinementState;
    }
  | undefined
> {
  const state = getTopicStoreState(scope);
  await hydrateTopicStoreState(state);
  const entry = state.store.get(cacheKey(chatId, threadId));
  return entry
    ? {
        name: entry.name,
        nameRevision: entry.nameRevision ?? 0,
        isNameImplicit: entry.isNameImplicit,
        labelState: entry.labelState,
      }
    : undefined;
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

export async function recordTopicCreation(
  chatId: number | string,
  threadId: number | string,
  creation: Pick<
    TopicEntry,
    "name" | "isNameImplicit" | "creatorUserId" | "iconColor" | "iconCustomEmojiId"
  >,
  scope?: string,
): Promise<void> {
  const state = getTopicStoreState(scope);
  await hydrateTopicStoreState(state);
  // A late creation service message must not undo a subsequent rename or close.
  const patch = state.store.has(cacheKey(chatId, threadId))
    ? { creatorUserId: creation.creatorUserId }
    : { ...creation, closed: false };
  await updateTopicName(chatId, threadId, patch, scope);
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
