// Msteams plugin module implements conversation store state behavior.
import crypto from "node:crypto";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import {
  findPreferredDmConversationByUserId,
  mergeStoredConversationReference,
  normalizeStoredConversationId,
  parseStoredConversationTimestamp,
  toConversationStoreEntries,
} from "./conversation-store-helpers.js";
import type {
  MSTeamsConversationStore,
  MSTeamsConversationStoreEntry,
  StoredConversationReference,
} from "./conversation-store.js";
import { getMSTeamsRuntime } from "./runtime.js";
import {
  resolveMSTeamsSqliteStateEnv,
  toPluginJsonValue,
  withMSTeamsSqliteMutationLock,
} from "./sqlite-state.js";

export type MSTeamsLegacyConversationStoreData = {
  version: 1;
  conversations: Record<string, StoredConversationReference>;
};

export const MSTEAMS_CONVERSATIONS_LEGACY_FILENAME = "msteams-conversations.json";
export const MSTEAMS_CONVERSATIONS_NAMESPACE = "conversations";
const MSTEAMS_MAX_CONVERSATIONS = 1000;
export const MSTEAMS_SQLITE_MAX_CONVERSATION_ROWS = MSTEAMS_MAX_CONVERSATIONS + 1000;
const MSTEAMS_CONVERSATION_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const ACCOUNT_SCOPED_CONVERSATION_PREFIX = "\u0000openclaw:msteams:account:";
const ACCOUNT_SCOPED_CONVERSATION_SEPARATOR = "\u0000conversation:";
const CONVERSATION_MUTATION_KEY = "conversations";

type MSTeamsConversationStoreStateOptions = {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  ttlMs?: number;
  stateDir?: string;
  storePath?: string;
};

function createConversationStateStore(params?: MSTeamsConversationStoreStateOptions) {
  return getMSTeamsRuntime().state.openKeyedStore<StoredConversationReference>({
    namespace: MSTEAMS_CONVERSATIONS_NAMESPACE,
    maxEntries: MSTEAMS_SQLITE_MAX_CONVERSATION_ROWS,
    env: resolveMSTeamsSqliteStateEnv(params),
  });
}

export function normalizeMSTeamsLegacyConversationStore(
  value: MSTeamsLegacyConversationStoreData,
): MSTeamsLegacyConversationStoreData {
  if (
    value.version !== 1 ||
    !value.conversations ||
    typeof value.conversations !== "object" ||
    Array.isArray(value.conversations)
  ) {
    return { version: 1, conversations: {} };
  }
  return value;
}

export function buildMSTeamsConversationStateKey(conversationId: string): string {
  return crypto.createHash("sha256").update(conversationId).digest("hex");
}

export function prepareMSTeamsConversationReferenceForStorage(
  conversationId: string,
  reference: StoredConversationReference,
): StoredConversationReference {
  return {
    ...reference,
    conversation: {
      ...reference.conversation,
      id: conversationId,
    },
  };
}

function getStoredConversationId(reference: StoredConversationReference): string | null {
  const rawId = reference.conversation?.id;
  return rawId ? normalizeStoredConversationId(rawId) : null;
}

export function selectRetainedMSTeamsConversations(
  conversations: Record<string, StoredConversationReference>,
  ttlMs = MSTEAMS_CONVERSATION_TTL_MS,
): Array<[string, StoredConversationReference]> {
  const retained = Object.entries(conversations).filter(([, reference]) => {
    const lastSeenAt = parseStoredConversationTimestamp(reference.lastSeenAt);
    return lastSeenAt == null || Date.now() - lastSeenAt <= ttlMs;
  });
  if (retained.length <= MSTEAMS_MAX_CONVERSATIONS) {
    return retained;
  }
  retained.sort((a, b) => {
    const aTs = parseStoredConversationTimestamp(a[1].lastSeenAt) ?? 0;
    const bTs = parseStoredConversationTimestamp(b[1].lastSeenAt) ?? 0;
    return aTs - bTs || a[0].localeCompare(b[0]);
  });
  return retained.slice(retained.length - MSTEAMS_MAX_CONVERSATIONS);
}

export function createMSTeamsConversationStoreState(
  params?: MSTeamsConversationStoreStateOptions,
): MSTeamsConversationStore {
  const ttlMs = params?.ttlMs ?? MSTEAMS_CONVERSATION_TTL_MS;
  const conversationStore = createConversationStateStore(params);

  const isExpired = (reference: StoredConversationReference): boolean => {
    const lastSeenAt = parseStoredConversationTimestamp(reference.lastSeenAt);
    // Preserve migrated legacy entries that have no lastSeenAt until they're seen again.
    return lastSeenAt != null && Date.now() - lastSeenAt > ttlMs;
  };

  const lookupStored = async (
    conversationId: string,
  ): Promise<StoredConversationReference | null> => {
    const normalizedId = normalizeStoredConversationId(conversationId);
    const value = await conversationStore.lookup(buildMSTeamsConversationStateKey(normalizedId));
    if (!value) {
      return null;
    }
    if (isExpired(value)) {
      return null;
    }
    return value;
  };

  const entries = async (): Promise<Array<[string, StoredConversationReference]>> => {
    const rows = await conversationStore.entries();
    const kept: Array<[string, StoredConversationReference]> = [];
    for (const row of rows) {
      if (isExpired(row.value)) {
        continue;
      }
      const conversationId = getStoredConversationId(row.value);
      if (conversationId) {
        kept.push([conversationId, row.value]);
      }
    }
    return kept;
  };

  const lookup = async (conversationId: string): Promise<StoredConversationReference | null> => {
    return await lookupStored(conversationId);
  };

  const register = async (
    conversationId: string,
    reference: StoredConversationReference,
  ): Promise<void> => {
    const normalizedId = normalizeStoredConversationId(conversationId);
    await conversationStore.register(
      buildMSTeamsConversationStateKey(normalizedId),
      toPluginJsonValue(prepareMSTeamsConversationReferenceForStorage(normalizedId, reference)),
    );
    const rows = [];
    for (const row of await conversationStore.entries()) {
      if (isExpired(row.value)) {
        await conversationStore.delete(row.key);
        continue;
      }
      rows.push(row);
    }
    if (rows.length <= MSTEAMS_MAX_CONVERSATIONS) {
      return;
    }
    const sorted = rows.toSorted((a, b) => {
      const aTs = parseStoredConversationTimestamp(a.value.lastSeenAt) ?? 0;
      const bTs = parseStoredConversationTimestamp(b.value.lastSeenAt) ?? 0;
      const aId = getStoredConversationId(a.value) ?? a.key;
      const bId = getStoredConversationId(b.value) ?? b.key;
      return aTs - bTs || aId.localeCompare(bId);
    });
    for (const row of sorted.slice(0, rows.length - MSTEAMS_MAX_CONVERSATIONS)) {
      await conversationStore.delete(row.key);
    }
  };

  const list = async (): Promise<MSTeamsConversationStoreEntry[]> => {
    return toConversationStoreEntries(await entries());
  };

  const get = async (conversationId: string): Promise<StoredConversationReference | null> => {
    return await lookup(conversationId);
  };

  const findPreferredDmByUserId = async (
    id: string,
  ): Promise<MSTeamsConversationStoreEntry | null> => {
    return findPreferredDmConversationByUserId(await list(), id);
  };

  const upsert = async (
    conversationId: string,
    reference: StoredConversationReference,
  ): Promise<void> => {
    const normalizedId = normalizeStoredConversationId(conversationId);
    await withMSTeamsSqliteMutationLock(params, CONVERSATION_MUTATION_KEY, async () => {
      const existing = await lookupStored(normalizedId);
      await register(
        normalizedId,
        mergeStoredConversationReference(
          existing ?? undefined,
          reference,
          new Date().toISOString(),
        ),
      );
    });
  };

  const remove = async (conversationId: string): Promise<boolean> => {
    const normalizedId = normalizeStoredConversationId(conversationId);
    return await withMSTeamsSqliteMutationLock(params, CONVERSATION_MUTATION_KEY, async () => {
      return await conversationStore.delete(buildMSTeamsConversationStateKey(normalizedId));
    });
  };

  return {
    upsert,
    get,
    list,
    remove,
    findPreferredDmByUserId,
  };
}

export function createAccountScopedMSTeamsConversationStore(
  store: MSTeamsConversationStore,
  accountId: string,
): MSTeamsConversationStore {
  const isAccountScopedId = (conversationId: string) =>
    conversationId.startsWith(ACCOUNT_SCOPED_CONVERSATION_PREFIX);
  if (accountId === DEFAULT_ACCOUNT_ID) {
    const listDefault = async () =>
      (await store.list()).filter((entry) => !isAccountScopedId(entry.conversationId));
    return {
      upsert: store.upsert,
      get: async (conversationId) =>
        isAccountScopedId(conversationId) ? null : await store.get(conversationId),
      remove: async (conversationId) =>
        isAccountScopedId(conversationId) ? false : await store.remove(conversationId),
      list: listDefault,
      findPreferredDmByUserId: async (id) =>
        findPreferredDmConversationByUserId(await listDefault(), id),
    };
  }
  const prefix = `${ACCOUNT_SCOPED_CONVERSATION_PREFIX}${encodeURIComponent(accountId)}${ACCOUNT_SCOPED_CONVERSATION_SEPARATOR}`;
  const scopedId = (conversationId: string) => `${prefix}${conversationId}`;
  const unscopedId = (conversationId: string) =>
    conversationId.startsWith(prefix) ? conversationId.slice(prefix.length) : conversationId;
  const unscopedReference = (reference: Awaited<ReturnType<MSTeamsConversationStore["get"]>>) =>
    reference
      ? {
          ...reference,
          conversation: reference.conversation
            ? {
                ...reference.conversation,
                id: unscopedId(reference.conversation.id ?? ""),
              }
            : reference.conversation,
        }
      : null;
  const listScoped = async () =>
    (await store.list())
      .filter((entry) => entry.conversationId.startsWith(prefix))
      .map((entry) => {
        return Object.assign({}, entry, {
          conversationId: unscopedId(entry.conversationId),
          reference: unscopedReference(entry.reference) ?? entry.reference,
        });
      });
  return {
    upsert: async (conversationId, reference) =>
      await store.upsert(scopedId(conversationId), reference),
    get: async (conversationId) => unscopedReference(await store.get(scopedId(conversationId))),
    remove: async (conversationId) => await store.remove(scopedId(conversationId)),
    list: listScoped,
    findPreferredDmByUserId: async (id) =>
      findPreferredDmConversationByUserId(await listScoped(), id),
  };
}
