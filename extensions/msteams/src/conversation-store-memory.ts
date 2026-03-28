import { findPreferredConversationByUserId } from "./conversation-store-selection.js";
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
        lastSeenAt: new Date().toISOString(),
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
      return findPreferredConversationByUserId(
        Array.from(map.entries()).map(([conversationId, reference]) => ({
          conversationId,
          reference,
        })),
        id,
      );
    },
  };
}
