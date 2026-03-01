import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MessageDb } from "../db.js";
import { createMessageRepository } from "../message-repository.js";
import type { StoredMessage } from "../types.js";

// Stub MessageDb that tracks calls
function createMockDb(rows: StoredMessage[] = []): MessageDb {
  return {
    insertMessage: vi.fn(),
    getConversationContext: vi.fn().mockReturnValue(rows),
    close: vi.fn(),
  };
}

const sampleMessages: StoredMessage[] = [
  {
    id: 1,
    conversation_id: "chat-1",
    sender: "+44700000001",
    sender_name: "Alice",
    content: "Hey, want to grab coffee?",
    timestamp: 1700000000000,
    direction: "inbound",
    channel_id: "whatsapp",
  },
  {
    id: 2,
    conversation_id: "chat-1",
    sender: "me",
    sender_name: null,
    content: "Sure, 2pm?",
    timestamp: 1700000001000,
    direction: "outbound",
    channel_id: "whatsapp",
  },
];

describe("MessageRepository", () => {
  let mockDb: MessageDb;

  beforeEach(() => {
    mockDb = createMockDb(sampleMessages);
  });

  it("returns messages for a conversation with default limit", () => {
    const repo = createMessageRepository(mockDb);
    const result = repo.getConversation("chat-1");

    expect(mockDb.getConversationContext).toHaveBeenCalledWith("chat-1", 50);
    expect(result).toEqual(sampleMessages);
  });

  it("respects custom limit option", () => {
    const repo = createMessageRepository(mockDb);
    repo.getConversation("chat-1", { limit: 10 });

    expect(mockDb.getConversationContext).toHaveBeenCalledWith("chat-1", 10);
  });

  it("returns empty array for unknown conversation", () => {
    const emptyDb = createMockDb([]);
    const repo = createMessageRepository(emptyDb);
    const result = repo.getConversation("unknown-chat");

    expect(result).toEqual([]);
  });
});
