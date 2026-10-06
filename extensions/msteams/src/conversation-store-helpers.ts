import { parseDateStringTimestampMs } from "openclaw/plugin-sdk/number-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import type {
  MSTeamsConversationStoreEntry,
  StoredConversationReference,
} from "./conversation-store.js";

export function mergeStoredConversationReference(
  existing: StoredConversationReference | undefined,
  incoming: StoredConversationReference,
  nowIso: string,
): StoredConversationReference {
  return {
    // Preserve fields from the previous entry that may not be present on every
    // inbound activity. Without this, sparse activities (e.g. conversationUpdate,
    // reactions) would clear previously captured values. Some fields are only
    // populated opportunistically, such as timezone from clientInfo entities.
    ...(existing?.timezone && !incoming.timezone ? { timezone: existing.timezone } : {}),
    ...(existing?.tenantId && !incoming.tenantId ? { tenantId: existing.tenantId } : {}),
    ...(existing?.aadObjectId && !incoming.aadObjectId
      ? { aadObjectId: existing.aadObjectId }
      : {}),
    ...incoming,
    lastSeenAt: nowIso,
  };
}

export function findPreferredDmConversationByUserId(
  entries: Iterable<MSTeamsConversationStoreEntry>,
  id: string,
): MSTeamsConversationStoreEntry | null {
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
      entry.reference.conversation?.conversationType ?? "",
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
}
