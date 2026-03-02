import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MessageRepositoryImpl, type MessageRepository } from "../message-repository.js";
import { SqliteRepositoryImpl, type SqliteRepository } from "../sqlite-repository.js";

describe("MessageRepository", () => {
  let tmpDir: string;
  let sqliteRepo: SqliteRepository;
  let repo: MessageRepository;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "wpm-msg-repo-test-"));
    const dbPath = path.join(tmpDir, "messages.db");
    sqliteRepo = new SqliteRepositoryImpl(dbPath);
    repo = new MessageRepositoryImpl(sqliteRepo);
  });

  afterEach(() => {
    sqliteRepo.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ---- Schema creation ----

  it("creates the messages table on init (idempotent)", () => {
    // Re-creating on same DB should not error
    const repo2 = new MessageRepositoryImpl(sqliteRepo);
    expect(repo2).toBeDefined();
  });

  // ---- Insert ----

  it("inserts an inbound message", () => {
    repo.insertMessage({
      conversation_id: "447123456789@s.whatsapp.net",
      sender: "447123456789",
      sender_name: "Alice",
      content: "Hey, are you free Saturday?",
      timestamp: 1700000000000,
      direction: "inbound",
      channel_id: "whatsapp",
    });

    const messages = repo.getConversation("447123456789@s.whatsapp.net");
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe("Hey, are you free Saturday?");
    expect(messages[0].direction).toBe("inbound");
    expect(messages[0].sender_name).toBe("Alice");
  });

  it("inserts an outbound message", () => {
    repo.insertMessage({
      conversation_id: "447123456789@s.whatsapp.net",
      sender: "me",
      sender_name: null,
      content: "Yeah, what's up?",
      timestamp: 1700000001000,
      direction: "outbound",
      channel_id: "whatsapp",
    });

    const messages = repo.getConversation("447123456789@s.whatsapp.net");
    expect(messages).toHaveLength(1);
    expect(messages[0].direction).toBe("outbound");
    expect(messages[0].sender_name).toBeNull();
  });

  // ---- Query context ----

  it("returns messages in chronological order (oldest first)", () => {
    // Insert in reverse order to verify sorting
    repo.insertMessage({
      conversation_id: "chat-1",
      sender: "bob",
      sender_name: "Bob",
      content: "Third message",
      timestamp: 1700000003000,
      direction: "inbound",
      channel_id: "whatsapp",
    });
    repo.insertMessage({
      conversation_id: "chat-1",
      sender: "me",
      sender_name: null,
      content: "First message",
      timestamp: 1700000001000,
      direction: "outbound",
      channel_id: "whatsapp",
    });
    repo.insertMessage({
      conversation_id: "chat-1",
      sender: "bob",
      sender_name: "Bob",
      content: "Second message",
      timestamp: 1700000002000,
      direction: "inbound",
      channel_id: "whatsapp",
    });

    const messages = repo.getConversation("chat-1");
    expect(messages).toHaveLength(3);
    // Chronological: oldest first
    expect(messages[0].content).toBe("First message");
    expect(messages[1].content).toBe("Second message");
    expect(messages[2].content).toBe("Third message");
  });

  it("respects the limit parameter (returns most recent N)", () => {
    for (let i = 0; i < 10; i++) {
      repo.insertMessage({
        conversation_id: "chat-1",
        sender: "bob",
        sender_name: "Bob",
        content: `Message ${i}`,
        timestamp: 1700000000000 + i * 1000,
        direction: "inbound",
        channel_id: "whatsapp",
      });
    }

    const messages = repo.getConversation("chat-1", { limit: 3 });
    expect(messages).toHaveLength(3);
    // Should return the last 3, in chronological order
    expect(messages[0].content).toBe("Message 7");
    expect(messages[1].content).toBe("Message 8");
    expect(messages[2].content).toBe("Message 9");
  });

  it("uses default limit of 50", () => {
    for (let i = 0; i < 60; i++) {
      repo.insertMessage({
        conversation_id: "chat-1",
        sender: "bob",
        sender_name: "Bob",
        content: `Message ${i}`,
        timestamp: 1700000000000 + i * 1000,
        direction: "inbound",
        channel_id: "whatsapp",
      });
    }

    // No limit option — should return last 50
    const messages = repo.getConversation("chat-1");
    expect(messages).toHaveLength(50);
    expect(messages[0].content).toBe("Message 10");
    expect(messages[49].content).toBe("Message 59");
  });

  it("isolates conversations — only returns messages for the given conversation_id", () => {
    repo.insertMessage({
      conversation_id: "chat-1",
      sender: "alice",
      sender_name: "Alice",
      content: "Hello from chat 1",
      timestamp: 1700000001000,
      direction: "inbound",
      channel_id: "whatsapp",
    });
    repo.insertMessage({
      conversation_id: "chat-2",
      sender: "bob",
      sender_name: "Bob",
      content: "Hello from chat 2",
      timestamp: 1700000002000,
      direction: "inbound",
      channel_id: "whatsapp",
    });

    const chat1 = repo.getConversation("chat-1");
    expect(chat1).toHaveLength(1);
    expect(chat1[0].content).toBe("Hello from chat 1");

    const chat2 = repo.getConversation("chat-2");
    expect(chat2).toHaveLength(1);
    expect(chat2[0].content).toBe("Hello from chat 2");
  });

  it("returns empty array for unknown conversation", () => {
    const messages = repo.getConversation("nonexistent");
    expect(messages).toHaveLength(0);
  });

  it("includes both inbound and outbound in context", () => {
    repo.insertMessage({
      conversation_id: "chat-1",
      sender: "alice",
      sender_name: "Alice",
      content: "Are you free?",
      timestamp: 1700000001000,
      direction: "inbound",
      channel_id: "whatsapp",
    });
    repo.insertMessage({
      conversation_id: "chat-1",
      sender: "me",
      sender_name: null,
      content: "Yeah, what time?",
      timestamp: 1700000002000,
      direction: "outbound",
      channel_id: "whatsapp",
    });

    const messages = repo.getConversation("chat-1");
    expect(messages).toHaveLength(2);
    expect(messages[0].direction).toBe("inbound");
    expect(messages[1].direction).toBe("outbound");
  });
});
