import type {
  MSTeamsConversationStore,
  MSTeamsConversationStoreEntry,
  StoredConversationReference,
} from "./conversation-store.js";

export function createMSTeamsConversationStoreMemory(
  initial: MSTeamsConversationStoreEntry[] = [],
): MSTeamsConversationStore {
  const map = new Map<string, StoredConversationReference>();
  for (const { conversationId, reference } of initial) {
    map.set(conversationId, reference);
  }

  return {
    upsert: async (conversationId, reference) => {
      map.set(conversationId, reference);
    },
    get: async (conversationId) => {
      return map.get(conversationId) ?? null;
    },
    list: async () => {
      return Array.from(map.entries()).map(([conversationId, reference]) => ({
        conversationId,
        reference,
      }));
    },
    remove: async (conversationId) => {
      return map.delete(conversationId);
    },
    findAllByUserId: async (id) => {
      const target = id.trim();
      if (!target) {
        return [];
      }
      const results: MSTeamsConversationStoreEntry[] = [];
      for (const [conversationId, reference] of map.entries()) {
        if (reference.user?.aadObjectId === target || reference.user?.id === target) {
          results.push({ conversationId, reference });
        }
      }
      return results;
    },
    findByUserId: async (id) => {
      const target = id.trim();
      if (!target) {
        return null;
      }
      // Re-use findAllByUserId logic or keep optimized loop
      for (const [conversationId, reference] of map.entries()) {
        if (reference.user?.aadObjectId === target || reference.user?.id === target) {
          return { conversationId, reference };
        }
      }
      return null;
    },
  };
}
