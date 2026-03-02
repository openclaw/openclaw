/**
 * Unit tests for the telegram-userbot inbound message handler.
 *
 * GramJS is fully mocked -- no real Telegram connections.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { UserbotClient } from "./client.js";
import { registerInboundHandlers, type InboundHandlerConfig } from "./inbound.js";

// ---------------------------------------------------------------------------
// Mock GramJS NewMessage event class
// ---------------------------------------------------------------------------

vi.mock("telegram/events/index.js", () => {
  class NewMessage {
    constructor(public filter: unknown) {}
  }
  return { NewMessage };
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

type EventHandler = (event: unknown) => Promise<void>;

/** Create a mock UserbotClient that captures registered event handlers. */
function createMockClient() {
  const handlers: { fn: EventHandler; filter: unknown }[] = [];

  const mockGramClient = {
    addEventHandler: vi.fn((fn: EventHandler, filter: unknown) => {
      handlers.push({ fn, filter });
    }),
    removeEventHandler: vi.fn((fn: EventHandler, _filter: unknown) => {
      const idx = handlers.findIndex((h) => h.fn === fn);
      if (idx >= 0) handlers.splice(idx, 1);
    }),
  };

  const client = {
    getClient: vi.fn().mockReturnValue(mockGramClient),
    // Other UserbotClient methods not needed for inbound
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: vi.fn(),
    getMe: vi.fn(),
    getSessionString: vi.fn(),
    sendMessage: vi.fn(),
    sendFile: vi.fn(),
    editMessage: vi.fn(),
    deleteMessages: vi.fn(),
    forwardMessages: vi.fn(),
    reactToMessage: vi.fn(),
    pinMessage: vi.fn(),
    getHistory: vi.fn(),
    setTyping: vi.fn(),
  } as unknown as UserbotClient;

  return { client, gramClient: mockGramClient, handlers };
}

/** Build a minimal GramJS-like message object for tests. */
function buildMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    text: "hello world",
    out: false,
    senderId: BigInt(12345),
    chatId: BigInt(67890),
    date: 1700000000,
    replyTo: undefined as { replyToMsgId?: number } | undefined,
    fwdFrom: undefined,
    media: undefined,
    getChat: vi.fn().mockResolvedValue(undefined),
    getSender: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

/** Simulate dispatching a NewMessage event through registered handlers. */
async function dispatchEvent(
  handlers: { fn: EventHandler; filter: unknown }[],
  message: ReturnType<typeof buildMessage>,
) {
  for (const h of handlers) {
    await h.fn({ message });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("registerInboundHandlers", () => {
  let mock: ReturnType<typeof createMockClient>;
  let onMessage: ReturnType<typeof vi.fn>;
  let config: InboundHandlerConfig;

  beforeEach(() => {
    mock = createMockClient();
    onMessage = vi.fn();
    config = { selfUserId: 99999, onMessage };
  });

  it("creates InboundTelegramMessage with correct fields", async () => {
    const msg = buildMessage({
      id: 100,
      text: "test message",
      senderId: BigInt(12345),
      chatId: BigInt(67890),
    });

    registerInboundHandlers(mock.client, config);
    await dispatchEvent(mock.handlers, msg);

    expect(onMessage).toHaveBeenCalledOnce();
    const inbound = onMessage.mock.calls[0][0];
    expect(inbound.channel).toBe("telegram-userbot");
    expect(inbound.messageId).toBe(100);
    expect(inbound.text).toBe("test message");
    expect(inbound.senderId).toBe(12345);
    expect(inbound.chatId).toBe("67890");
    expect(inbound.channelChatId).toBe("telegram-userbot:67890");
  });

  it("ignores own outgoing messages (message.out=true)", async () => {
    const msg = buildMessage({ out: true });

    registerInboundHandlers(mock.client, config);
    await dispatchEvent(mock.handlers, msg);

    expect(onMessage).not.toHaveBeenCalled();
  });

  it("ignores messages without a sender ID", async () => {
    const msg = buildMessage({ senderId: undefined });

    registerInboundHandlers(mock.client, config);
    await dispatchEvent(mock.handlers, msg);

    expect(onMessage).not.toHaveBeenCalled();
  });

  it("ignores messages from non-allowFrom user", async () => {
    config.allowFrom = [999, 888];
    const msg = buildMessage({ senderId: BigInt(777) });

    registerInboundHandlers(mock.client, config);
    await dispatchEvent(mock.handlers, msg);

    expect(onMessage).not.toHaveBeenCalled();
  });

  it("processes messages from allowFrom user", async () => {
    config.allowFrom = [12345, 888];
    const msg = buildMessage({ senderId: BigInt(12345) });

    registerInboundHandlers(mock.client, config);
    await dispatchEvent(mock.handlers, msg);

    expect(onMessage).toHaveBeenCalledOnce();
  });

  it("allows all messages when allowFrom is empty", async () => {
    config.allowFrom = [];
    const msg = buildMessage({ senderId: BigInt(99) });

    registerInboundHandlers(mock.client, config);
    await dispatchEvent(mock.handlers, msg);

    expect(onMessage).toHaveBeenCalledOnce();
  });

  it("allows all messages when allowFrom is undefined", async () => {
    config.allowFrom = undefined;
    const msg = buildMessage({ senderId: BigInt(99) });

    registerInboundHandlers(mock.client, config);
    await dispatchEvent(mock.handlers, msg);

    expect(onMessage).toHaveBeenCalledOnce();
  });

  it("extracts replyToMessageId from message.replyTo", async () => {
    const msg = buildMessage({
      replyTo: { replyToMsgId: 77 },
    });

    registerInboundHandlers(mock.client, config);
    await dispatchEvent(mock.handlers, msg);

    const inbound = onMessage.mock.calls[0][0];
    expect(inbound.replyToMessageId).toBe(77);
  });

  it("resolves chat type as private when chat is a User", async () => {
    const msg = buildMessage({
      getChat: vi.fn().mockResolvedValue({ className: "User" }),
    });

    registerInboundHandlers(mock.client, config);
    await dispatchEvent(mock.handlers, msg);

    expect(onMessage.mock.calls[0][0].chatType).toBe("private");
  });

  it("resolves chat type as group for Chat entity", async () => {
    const msg = buildMessage({
      getChat: vi.fn().mockResolvedValue({ className: "Chat", title: "Test Group" }),
    });

    registerInboundHandlers(mock.client, config);
    await dispatchEvent(mock.handlers, msg);

    const inbound = onMessage.mock.calls[0][0];
    expect(inbound.chatType).toBe("group");
    expect(inbound.chatTitle).toBe("Test Group");
  });

  it("resolves chat type as supergroup for Channel with megagroup", async () => {
    const msg = buildMessage({
      getChat: vi
        .fn()
        .mockResolvedValue({ className: "Channel", megagroup: true, title: "Supergroup" }),
    });

    registerInboundHandlers(mock.client, config);
    await dispatchEvent(mock.handlers, msg);

    expect(onMessage.mock.calls[0][0].chatType).toBe("supergroup");
  });

  it("resolves chat type as channel for Channel without megagroup", async () => {
    const msg = buildMessage({
      getChat: vi
        .fn()
        .mockResolvedValue({ className: "Channel", megagroup: false, title: "Broadcast" }),
    });

    registerInboundHandlers(mock.client, config);
    await dispatchEvent(mock.handlers, msg);

    expect(onMessage.mock.calls[0][0].chatType).toBe("channel");
  });

  it("resolves sender name with firstName/lastName", async () => {
    const msg = buildMessage({
      getSender: vi
        .fn()
        .mockResolvedValue({ className: "User", firstName: "Jane", lastName: "Doe" }),
    });

    registerInboundHandlers(mock.client, config);
    await dispatchEvent(mock.handlers, msg);

    expect(onMessage.mock.calls[0][0].senderName).toBe("Jane Doe");
  });

  it("falls back to username when name parts are empty", async () => {
    const msg = buildMessage({
      getSender: vi.fn().mockResolvedValue({
        className: "User",
        firstName: "",
        lastName: undefined,
        username: "jdoe",
      }),
    });

    registerInboundHandlers(mock.client, config);
    await dispatchEvent(mock.handlers, msg);

    expect(onMessage.mock.calls[0][0].senderName).toBe("jdoe");
  });

  it("detects photo media type", async () => {
    const msg = buildMessage({
      media: { className: "MessageMediaPhoto" },
    });

    registerInboundHandlers(mock.client, config);
    await dispatchEvent(mock.handlers, msg);

    expect(onMessage.mock.calls[0][0].mediaType).toBe("photo");
  });

  it("detects document media type", async () => {
    const msg = buildMessage({
      media: {
        className: "MessageMediaDocument",
        document: { className: "Document", mimeType: "application/pdf" },
      },
    });

    registerInboundHandlers(mock.client, config);
    await dispatchEvent(mock.handlers, msg);

    expect(onMessage.mock.calls[0][0].mediaType).toBe("document");
  });

  it("detects voice media type (audio document)", async () => {
    const msg = buildMessage({
      media: {
        className: "MessageMediaDocument",
        document: { className: "Document", mimeType: "audio/ogg" },
      },
    });

    registerInboundHandlers(mock.client, config);
    await dispatchEvent(mock.handlers, msg);

    expect(onMessage.mock.calls[0][0].mediaType).toBe("voice");
  });

  it("detects forward via fwdFrom", async () => {
    const msg = buildMessage({
      fwdFrom: { fromId: { className: "PeerUser", userId: BigInt(1) } },
    });

    registerInboundHandlers(mock.client, config);
    await dispatchEvent(mock.handlers, msg);

    expect(onMessage.mock.calls[0][0].isForward).toBe(true);
  });

  it("sets isForward to false when no fwdFrom", async () => {
    const msg = buildMessage({ fwdFrom: undefined });

    registerInboundHandlers(mock.client, config);
    await dispatchEvent(mock.handlers, msg);

    expect(onMessage.mock.calls[0][0].isForward).toBe(false);
  });

  it("cleanup function removes event handler", () => {
    const cleanup = registerInboundHandlers(mock.client, config);
    expect(mock.gramClient.addEventHandler).toHaveBeenCalledOnce();

    cleanup();
    expect(mock.gramClient.removeEventHandler).toHaveBeenCalledOnce();
  });

  it("falls back to senderId for chatId when message.chatId is missing", async () => {
    const msg = buildMessage({
      senderId: BigInt(55555),
      chatId: undefined,
    });

    registerInboundHandlers(mock.client, config);
    await dispatchEvent(mock.handlers, msg);

    const inbound = onMessage.mock.calls[0][0];
    expect(inbound.chatId).toBe("55555");
    expect(inbound.channelChatId).toBe("telegram-userbot:55555");
  });

  it("continues processing when getChat throws", async () => {
    const msg = buildMessage({
      getChat: vi.fn().mockRejectedValue(new Error("entity not found")),
    });

    registerInboundHandlers(mock.client, config);
    await dispatchEvent(mock.handlers, msg);

    expect(onMessage).toHaveBeenCalledOnce();
    // Chat type falls back to "private" when chat is undefined
    expect(onMessage.mock.calls[0][0].chatType).toBe("private");
  });

  it("continues processing when getSender throws", async () => {
    const msg = buildMessage({
      getSender: vi.fn().mockRejectedValue(new Error("sender not found")),
    });

    registerInboundHandlers(mock.client, config);
    await dispatchEvent(mock.handlers, msg);

    expect(onMessage).toHaveBeenCalledOnce();
    expect(onMessage.mock.calls[0][0].senderName).toBe("Unknown");
  });
});
