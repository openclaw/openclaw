import { createPluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
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
import { toPluginJsonValue, withMSTeamsSqliteStateEnv } from "./sqlite-state.js";

const MAX_CONVERSATIONS = 1000;
const CONVERSATION_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const CONVERSATION_STORE = createPluginStateKeyedStore<StoredConversationReference>("msteams", {
  namespace: "conversations",
  maxEntries: MAX_CONVERSATIONS,
});

export function createMSTeamsConversationStoreState(params?: {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  ttlMs?: number;
  stateDir?: string;
}): MSTeamsConversationStore {
  const ttlMs = params?.ttlMs ?? CONVERSATION_TTL_MS;

  const isExpired = (reference: StoredConversationReference): boolean => {
    const lastSeenAt = parseStoredConversationTimestamp(reference.lastSeenAt);
    // Preserve migrated legacy entries that have no lastSeenAt until they're seen again.
    return lastSeenAt != null && Date.now() - lastSeenAt > ttlMs;
  };

  const entries = async (): Promise<Array<[string, StoredConversationReference]>> =>
    await withMSTeamsSqliteStateEnv(params, async () => {
      const rows = await CONVERSATION_STORE.entries();
      const kept: Array<[string, StoredConversationReference]> = [];
      for (const row of rows) {
        if (isExpired(row.value)) {
          await CONVERSATION_STORE.delete(row.key);
          continue;
        }
        kept.push([row.key, row.value]);
      }
      return kept;
    });

  const lookup = async (conversationId: string): Promise<StoredConversationReference | null> =>
    await withMSTeamsSqliteStateEnv(params, async () => {
      const normalizedId = normalizeStoredConversationId(conversationId);
      const value = await CONVERSATION_STORE.lookup(normalizedId);
      if (!value) {
        return null;
      }
      if (isExpired(value)) {
        await CONVERSATION_STORE.delete(normalizedId);
        return null;
      }
      return value;
    });

  const register = async (
    conversationId: string,
    reference: StoredConversationReference,
  ): Promise<void> =>
    await withMSTeamsSqliteStateEnv(params, async () => {
      await CONVERSATION_STORE.register(conversationId, toPluginJsonValue(reference));
      const rows = await CONVERSATION_STORE.entries();
      if (rows.length > MAX_CONVERSATIONS) {
        const sorted = rows.toSorted((a, b) => {
          const aTs = parseStoredConversationTimestamp(a.value.lastSeenAt) ?? a.createdAt;
          const bTs = parseStoredConversationTimestamp(b.value.lastSeenAt) ?? b.createdAt;
          return aTs - bTs || a.key.localeCompare(b.key);
        });
        for (const row of sorted.slice(0, rows.length - MAX_CONVERSATIONS)) {
          await CONVERSATION_STORE.delete(row.key);
        }
      }
    });

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
    const existing = await lookup(normalizedId);
    await register(
      normalizedId,
      mergeStoredConversationReference(existing ?? undefined, reference, new Date().toISOString()),
    );
  };

  const remove = async (conversationId: string): Promise<boolean> => {
    const normalizedId = normalizeStoredConversationId(conversationId);
    return await withMSTeamsSqliteStateEnv(params, async () => {
      return await CONVERSATION_STORE.delete(normalizedId);
    });
  };

  return {
    upsert,
    get,
    list,
    remove,
    findPreferredDmByUserId,
    findByUserId: findPreferredDmByUserId,
  };
}
