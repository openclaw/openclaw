import type { MSTeamsConversationStoreEntry } from "./conversation-store.js";

export function parseStoredConversationTimestamp(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return parsed;
}

export function findPreferredConversationByUserId(
  entries: Iterable<MSTeamsConversationStoreEntry>,
  id: string,
): MSTeamsConversationStoreEntry | null {
  const target = id.trim();
  if (!target) {
    return null;
  }

  const matches: MSTeamsConversationStoreEntry[] = [];
  for (const entry of entries) {
    if (entry.reference.user?.aadObjectId === target || entry.reference.user?.id === target) {
      matches.push(entry);
    }
  }

  if (matches.length === 0) {
    return null;
  }

  matches.sort((a, b) => {
    const aType = a.reference.conversation?.conversationType?.toLowerCase() ?? "";
    const bType = b.reference.conversation?.conversationType?.toLowerCase() ?? "";
    const aPersonal = aType === "personal" ? 1 : 0;
    const bPersonal = bType === "personal" ? 1 : 0;
    if (aPersonal !== bPersonal) {
      return bPersonal - aPersonal;
    }
    return (
      (parseStoredConversationTimestamp(b.reference.lastSeenAt) ?? 0) -
      (parseStoredConversationTimestamp(a.reference.lastSeenAt) ?? 0)
    );
  });

  return matches[0] ?? null;
}
