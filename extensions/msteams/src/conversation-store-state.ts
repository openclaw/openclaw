import { sha256Hex } from "openclaw/plugin-sdk/node-crypto-runtime";
import { parseDateStringTimestampMs } from "openclaw/plugin-sdk/number-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import type {
  MSTeamsConversationStore,
  MSTeamsConversationStoreEntry,
  StoredConversationReference,
} from "./conversation-store.js";
import { normalizeMSTeamsConversationId } from "./inbound.js";
import { getMSTeamsRuntime } from "./runtime.js";
import {
  resolveMSTeamsAccountStateNamespace,
  toPluginJsonValue,
  withMSTeamsSqliteMutationLock,
} from "./sqlite-state.js";

const MSTEAMS_CONVERSATIONS_NAMESPACE = "conversations";
const MSTEAMS_MAX_CONVERSATIONS = 1000;
const MSTEAMS_SQLITE_MAX_CONVERSATION_ROWS = MSTEAMS_MAX_CONVERSATIONS + 1000;
const MSTEAMS_CONVERSATION_TTL_MS = 365 * 24 * 60 * 60 * 1000;

function getStoredConversationId(reference: StoredConversationReference): string | null {
  const rawId = reference.conversation?.id;
  return rawId ? normalizeMSTeamsConversationId(rawId) : null;
}

export function createMSTeamsConversationStoreState(params?: {
  accountId?: string | null;
}): MSTeamsConversationStore {
  const namespace = resolveMSTeamsAccountStateNamespace(
    MSTEAMS_CONVERSATIONS_NAMESPACE,
    params?.accountId,
  );
  const conversationStore = getMSTeamsRuntime().state.openKeyedStore<StoredConversationReference>({
    namespace,
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
    const value = await conversationStore.lookup(sha256Hex(normalizedId));
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
      sha256Hex(normalizedId),
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
    rows.sort((a, b) => {
      const aTs = parseDateStringTimestampMs(a.value.lastSeenAt) ?? 0;
      const bTs = parseDateStringTimestampMs(b.value.lastSeenAt) ?? 0;
      const aId = getStoredConversationId(a.value) ?? a.key;
      const bId = getStoredConversationId(b.value) ?? b.key;
      return aTs - bTs || aId.localeCompare(bId);
    });
    for (const row of rows.slice(0, rows.length - MSTEAMS_MAX_CONVERSATIONS)) {
      await conversationStore.delete(row.key);
    }
  };

  const findPreferredDmByUserId = async (
    id: string,
  ): Promise<MSTeamsConversationStoreEntry | null> => {
    const entries = await list();
    const target = id.trim();
    if (!target) {
      return null;
    }

    // Shared conversations carry the sender's aadObjectId too; never return one
    // for a user-targeted DM. Confirmed personal DMs outrank legacy unknown types.
    let preferred: MSTeamsConversationStoreEntry | null = null;
    let preferredIsPersonal = false;
    let preferredTimestamp = 0;
    for (const entry of entries) {
      if (entry.reference.user?.aadObjectId !== target && entry.reference.user?.id !== target) {
        continue;
      }
      const convType = normalizeLowercaseStringOrEmpty(
        entry.reference.conversation?.conversationType,
      );
      if (convType === "channel" || convType === "groupchat") {
        continue;
      }
      const isPersonal = convType === "personal";
      const timestamp = parseDateStringTimestampMs(entry.reference.lastSeenAt) ?? 0;
      if (
        !preferred ||
        (isPersonal && !preferredIsPersonal) ||
        (isPersonal === preferredIsPersonal && timestamp > preferredTimestamp)
      ) {
        preferred = entry;
        preferredIsPersonal = isPersonal;
        preferredTimestamp = timestamp;
      }
    }

    return preferred;
  };

  const upsert = async (
    conversationId: string,
    reference: StoredConversationReference,
  ): Promise<void> => {
    const normalizedId = normalizeMSTeamsConversationId(conversationId);
    await withMSTeamsSqliteMutationLock(namespace, async () => {
      const existing = await lookupStored(normalizedId);
      const previous = existing ?? undefined;
      const nowIso = new Date().toISOString();
      await register(normalizedId, {
        // Preserve fields from the previous entry that may not be present on every
        // inbound activity. Without this, sparse activities (e.g. conversationUpdate,
        // reactions) would clear previously captured values. Some fields are only
        // populated opportunistically, such as timezone from clientInfo entities.
        ...(previous?.timezone && !reference.timezone ? { timezone: previous.timezone } : {}),
        ...(previous?.tenantId && !reference.tenantId ? { tenantId: previous.tenantId } : {}),
        ...(previous?.aadObjectId && !reference.aadObjectId
          ? { aadObjectId: previous.aadObjectId }
          : {}),
        ...reference,
        lastSeenAt: nowIso,
      });
    });
  };

  const remove = async (conversationId: string): Promise<boolean> => {
    const normalizedId = normalizeMSTeamsConversationId(conversationId);
    return await withMSTeamsSqliteMutationLock(namespace, async () => {
      return await conversationStore.delete(sha256Hex(normalizedId));
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
