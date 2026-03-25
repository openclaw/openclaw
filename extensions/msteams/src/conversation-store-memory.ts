import type {
  MSTeamsConversationStore,
  MSTeamsConversationStoreEntry,
  StoredConversationReference,
} from "./conversation-store.js";

export function createMSTeamsConversationStoreMemory(
  initial: MSTeamsConversationStoreEntry[] = [],
): MSTeamsConversationStore {
  const map = new Map<string, StoredConversationReference>();
  const normalizeConversationId = (raw: string): string => raw.split(";")[0] ?? raw;
  for (const { conversationId, reference } of initial) {
    map.set(normalizeConversationId(conversationId), reference);
  }

  return {
    upsert: async (conversationId, reference) => {
      const normalizedId = normalizeConversationId(conversationId);
      const existing = map.get(normalizedId);
      map.set(normalizedId, {
        ...(existing?.timezone && !reference.timezone ? { timezone: existing.timezone } : {}),
        ...reference,
      });
    },
    get: async (conversationId) => {
      return map.get(normalizeConversationId(conversationId)) ?? null;
    },
    list: async () => {
      return Array.from(map.entries()).map(([conversationId, reference]) => ({
        conversationId,
        reference,
      }));
    },
    remove: async (conversationId) => {
      return map.delete(normalizeConversationId(conversationId));
    },
    findByUserId: async (id) => {
      const target = id.trim();
      if (!target) {
        return null;
      }

      const matches: MSTeamsConversationStoreEntry[] = [];
      for (const [conversationId, reference] of map.entries()) {
        if (reference.user?.aadObjectId === target || reference.user?.id === target) {
          matches.push({ conversationId, reference });
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
          (Date.parse(b.reference.lastSeenAt ?? "") || 0) -
          (Date.parse(a.reference.lastSeenAt ?? "") || 0)
        );
      });

      return matches[0] ?? null;
    },
  };
}
