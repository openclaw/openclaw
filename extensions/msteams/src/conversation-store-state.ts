import crypto from "node:crypto";
import { parseDateStringTimestampMs } from "openclaw/plugin-sdk/number-runtime";
import {
  findPreferredDmConversationByUserId,
  mergeStoredConversationReference,
} from "./conversation-store-helpers.js";
import type {
  MSTeamsConversationStore,
  MSTeamsConversationStoreEntry,
  StoredConversationReference,
} from "./conversation-store.js";
import { normalizeMSTeamsConversationId } from "./inbound.js";
import { getMSTeamsRuntime } from "./runtime.js";
import { toPluginJsonValue, withMSTeamsSqliteMutationLock } from "./sqlite-state.js";

const MSTEAMS_CONVERSATIONS_NAMESPACE = "conversations";
const MSTEAMS_MAX_CONVERSATIONS = 1000;
const MSTEAMS_SQLITE_MAX_CONVERSATION_ROWS = MSTEAMS_MAX_CONVERSATIONS + 1000;
const MSTEAMS_CONVERSATION_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const CONVERSATION_MUTATION_KEY = "conversations";

function buildMSTeamsConversationStateKey(conversationId: string): string {
  return crypto.createHash("sha256").update(conversationId).digest("hex");
}

function getStoredConversationId(reference: StoredConversationReference): string | null {
  const rawId = reference.conversation?.id;
  return rawId ? normalizeMSTeamsConversationId(rawId) : null;
}

export function createMSTeamsConversationStoreState(): MSTeamsConversationStore {
  const conversationStore = getMSTeamsRuntime().state.openKeyedStore<StoredConversationReference>({
    namespace: MSTEAMS_CONVERSATIONS_NAMESPACE,
    maxEntries: MSTEAMS_SQLITE_MAX_CONVERSATION_ROWS,
  });

  const isExpired = (reference: StoredConversationReference): boolean => {
    const lastSeenAt = parseDateStringTimestampMs(reference.lastSeenAt);
    // Preserve migrated legacy entries that have no lastSeenAt until they're seen again.
    return lastSeenAt != null && Date.now() - lastSeenAt > MSTEAMS_CONVERSATION_TTL_MS;
  };

  const lookupStored = async (
    conversationId: string,
  ): Promise<StoredConversationReference | null> => {
    const normalizedId = normalizeMSTeamsConversationId(conversationId);
    const value = await conversationStore.lookup(buildMSTeamsConversationStateKey(normalizedId));
    return value && !isExpired(value) ? value : null;
  };

  const list = async (): Promise<MSTeamsConversationStoreEntry[]> => {
    const rows = await conversationStore.entries();
    const kept: MSTeamsConversationStoreEntry[] = [];
    for (const row of rows) {
      if (isExpired(row.value)) {
        continue;
      }
      const conversationId = getStoredConversationId(row.value);
      if (conversationId) {
        kept.push({ conversationId, reference: row.value });
      }
    }
    return kept;
  };

  const register = async (
    conversationId: string,
    reference: StoredConversationReference,
  ): Promise<void> => {
    const normalizedId = normalizeMSTeamsConversationId(conversationId);
    await conversationStore.register(
      buildMSTeamsConversationStateKey(normalizedId),
      toPluginJsonValue({
        ...reference,
        conversation: { ...reference.conversation, id: normalizedId },
      }),
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
      const aTs = parseDateStringTimestampMs(a.value.lastSeenAt) ?? 0;
      const bTs = parseDateStringTimestampMs(b.value.lastSeenAt) ?? 0;
      const aId = getStoredConversationId(a.value) ?? a.key;
      const bId = getStoredConversationId(b.value) ?? b.key;
      return aTs - bTs || aId.localeCompare(bId);
    });
    for (const row of sorted.slice(0, rows.length - MSTEAMS_MAX_CONVERSATIONS)) {
      await conversationStore.delete(row.key);
    }
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
    const normalizedId = normalizeMSTeamsConversationId(conversationId);
    await withMSTeamsSqliteMutationLock(CONVERSATION_MUTATION_KEY, async () => {
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
    const normalizedId = normalizeMSTeamsConversationId(conversationId);
    return await withMSTeamsSqliteMutationLock(CONVERSATION_MUTATION_KEY, async () => {
      return await conversationStore.delete(buildMSTeamsConversationStateKey(normalizedId));
    });
  };

  return {
    upsert,
    get: lookupStored,
    list,
    remove,
    findPreferredDmByUserId,
  };
}
