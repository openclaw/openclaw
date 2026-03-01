import type { MessageDb } from "./db.js";
import type { StoredMessage } from "./types.js";

export type MessageRepository = {
  /** Get messages for a conversation, returned in chronological order (oldest first) */
  getConversation: (conversationId: string, options?: { limit?: number }) => StoredMessage[];
};

const DEFAULT_LIMIT = 50;

/**
 * Repository layer over MessageDb.
 * Provides flexible query interface for conversation messages.
 */
export function createMessageRepository(db: MessageDb): MessageRepository {
  function getConversation(conversationId: string, options?: { limit?: number }): StoredMessage[] {
    const limit = options?.limit ?? DEFAULT_LIMIT;
    return db.getConversationContext(conversationId, limit);
  }

  return { getConversation };
}
