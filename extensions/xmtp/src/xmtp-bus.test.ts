import { describe, expect, it, vi, beforeEach } from "vitest";
import { normalizeEthAddress, startXmtpBus } from "./xmtp-bus.js";

const TEST_WALLET_KEY = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const TEST_DB_KEY = "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const TEST_PEER_ADDRESS = "0x1234567890abcdef1234567890abcdef12345678";
const TEST_PEER_ADDRESS_UPPER = "0x1234567890ABCDEF1234567890ABCDEF12345678";

const xmtpMock = vi.hoisted(() => {
  const handlers = new Map<string, Array<(ctx: unknown) => Promise<void> | void>>();
  const sendByConversation = vi.fn(async (_text: string) => {});
  const sendReplyByConversation = vi.fn(
    async (_reply: { content: string; referenceId: string }) => {},
  );
  const sendByAddressDm = vi.fn(async (_text: string) => {});
  const sendReplyByAddressDm = vi.fn(
    async (_reply: { content: string; referenceId: string }) => {},
  );
  const getConversationById = vi.fn(async (id: string) => {
    if (id === "missing-conversation") {
      return null;
    }
    return {
      sendText: sendByConversation,
      sendReply: sendReplyByConversation,
    };
  });
  const createDmWithAddress = vi.fn(async (_address: string) => ({
    sendText: sendByAddressDm,
    sendReply: sendReplyByAddressDm,
  }));

  const agent = {
    address: "0xaabbccddeeff0011223344556677889900aabbcc",
    client: {
      conversations: {
        getConversationById,
      },
    },
    createDmWithAddress,
    on: vi.fn((event: string, handler: (ctx: unknown) => Promise<void> | void) => {
      const existing = handlers.get(event) ?? [];
      handlers.set(event, [...existing, handler]);
    }),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  };

  const AgentCreate = vi.fn(async () => agent);
  const createUser = vi.fn((_walletKey: string) => ({
    account: { address: "0xaabbccddeeff0011223344556677889900aabbcc" },
  }));
  const createSigner = vi.fn((_user: unknown) => ({ signer: true }));

  return {
    handlers,
    sendByConversation,
    sendReplyByConversation,
    sendByAddressDm,
    sendReplyByAddressDm,
    getConversationById,
    createDmWithAddress,
    agent,
    AgentCreate,
    createUser,
    createSigner,
    async emit(event: string, payload: unknown) {
      const listeners = handlers.get(event) ?? [];
      for (const listener of listeners) {
        await listener(payload);
      }
    },
    reset() {
      handlers.clear();
      sendByConversation.mockReset();
      sendReplyByConversation.mockReset();
      sendByAddressDm.mockReset();
      sendReplyByAddressDm.mockReset();
      getConversationById.mockReset();
      getConversationById.mockImplementation(async (id: string) => {
        if (id === "missing-conversation") {
          return null;
        }
        return {
          sendText: sendByConversation,
          sendReply: sendReplyByConversation,
        };
      });
      createDmWithAddress.mockReset();
      createDmWithAddress.mockImplementation(async (_address: string) => ({
        sendText: sendByAddressDm,
        sendReply: sendReplyByAddressDm,
      }));
      agent.on.mockClear();
      agent.start.mockClear();
      agent.stop.mockClear();
      AgentCreate.mockClear();
      createUser.mockClear();
      createSigner.mockClear();
    },
  };
});

vi.mock("@xmtp/agent-sdk", () => ({
  Agent: { create: xmtpMock.AgentCreate },
  createSigner: xmtpMock.createSigner,
  createUser: xmtpMock.createUser,
}));

describe("normalizeEthAddress", () => {
  it("normalizes valid address to lowercase", () => {
    expect(normalizeEthAddress(TEST_PEER_ADDRESS_UPPER)).toBe(TEST_PEER_ADDRESS);
  });

  it("throws for invalid address", () => {
    expect(() => normalizeEthAddress("not-an-address")).toThrow(
      "Invalid Ethereum address: must be 0x-prefixed 40 hex chars",
    );
  });
});

describe("startXmtpBus", () => {
  beforeEach(() => {
    xmtpMock.reset();
  });

  it("sends to a conversation id directly", async () => {
    const bus = await startXmtpBus({
      walletKey: TEST_WALLET_KEY,
      dbEncryptionKey: TEST_DB_KEY,
      env: "dev",
      dbPath: "/tmp/openclaw-xmtp-bus-test",
      shouldConsentDm: () => true,
      onMessage: vi.fn(async () => {}),
    });

    await bus.sendText("conversation-1", "hello");

    expect(xmtpMock.getConversationById).toHaveBeenCalledWith("conversation-1");
    expect(xmtpMock.sendByConversation).toHaveBeenCalledWith("hello");
    expect(xmtpMock.createDmWithAddress).not.toHaveBeenCalled();

    await bus.close();
  });

  it("sends replies to a conversation id with reference ids", async () => {
    const bus = await startXmtpBus({
      walletKey: TEST_WALLET_KEY,
      dbEncryptionKey: TEST_DB_KEY,
      env: "dev",
      dbPath: "/tmp/openclaw-xmtp-bus-test",
      shouldConsentDm: () => true,
      onMessage: vi.fn(async () => {}),
    });

    await bus.sendReply("conversation-1", "threaded reply", "msg-parent-1");

    expect(xmtpMock.getConversationById).toHaveBeenCalledWith("conversation-1");
    expect(xmtpMock.sendReplyByConversation).toHaveBeenCalledWith({
      content: "threaded reply",
      referenceId: "msg-parent-1",
    });

    await bus.close();
  });

  it("creates/uses a DM conversation when target is an ethereum address", async () => {
    const bus = await startXmtpBus({
      walletKey: TEST_WALLET_KEY,
      dbEncryptionKey: TEST_DB_KEY,
      env: "dev",
      dbPath: "/tmp/openclaw-xmtp-bus-test",
      shouldConsentDm: () => true,
      onMessage: vi.fn(async () => {}),
    });

    await bus.sendText(TEST_PEER_ADDRESS_UPPER, "hello from address");

    expect(xmtpMock.createDmWithAddress).toHaveBeenCalledWith(TEST_PEER_ADDRESS);
    expect(xmtpMock.sendByAddressDm).toHaveBeenCalledWith("hello from address");
    expect(xmtpMock.getConversationById).not.toHaveBeenCalledWith(TEST_PEER_ADDRESS);

    await bus.close();
  });

  it("sends replies to an address-targeted DM conversation", async () => {
    const bus = await startXmtpBus({
      walletKey: TEST_WALLET_KEY,
      dbEncryptionKey: TEST_DB_KEY,
      env: "dev",
      dbPath: "/tmp/openclaw-xmtp-bus-test",
      shouldConsentDm: () => true,
      onMessage: vi.fn(async () => {}),
    });

    await bus.sendReply(TEST_PEER_ADDRESS_UPPER, "hello reply", "msg-parent-2");

    expect(xmtpMock.createDmWithAddress).toHaveBeenCalledWith(TEST_PEER_ADDRESS);
    expect(xmtpMock.sendReplyByAddressDm).toHaveBeenCalledWith({
      content: "hello reply",
      referenceId: "msg-parent-2",
    });

    await bus.close();
  });

  it("throws when a conversation id cannot be resolved", async () => {
    const bus = await startXmtpBus({
      walletKey: TEST_WALLET_KEY,
      dbEncryptionKey: TEST_DB_KEY,
      env: "dev",
      dbPath: "/tmp/openclaw-xmtp-bus-test",
      shouldConsentDm: () => true,
      onMessage: vi.fn(async () => {}),
    });

    await expect(bus.sendText("missing-conversation", "hello")).rejects.toThrow(
      "Conversation not found: missing-conversation",
    );

    await bus.close();
  });

  it("forwards DM text events and preserves message ids", async () => {
    const onMessage = vi.fn(async () => {});
    const bus = await startXmtpBus({
      walletKey: TEST_WALLET_KEY,
      dbEncryptionKey: TEST_DB_KEY,
      env: "dev",
      dbPath: "/tmp/openclaw-xmtp-bus-test",
      shouldConsentDm: () => true,
      onMessage,
    });

    await xmtpMock.emit("text", {
      getSenderAddress: async () => TEST_PEER_ADDRESS_UPPER,
      message: {
        senderInboxId: "inbox-1",
        content: "hello inbound",
        id: "msg-123",
      },
      conversation: { id: "conversation-1" },
      isDm: () => true,
    });

    expect(onMessage).toHaveBeenCalledWith({
      senderAddress: TEST_PEER_ADDRESS,
      senderInboxId: "inbox-1",
      conversationId: "conversation-1",
      isDm: true,
      text: "hello inbound",
      messageId: "msg-123",
    });

    await bus.close();
  });

  it("forwards DM reply events with reply context", async () => {
    const onMessage = vi.fn(async () => {});
    const bus = await startXmtpBus({
      walletKey: TEST_WALLET_KEY,
      dbEncryptionKey: TEST_DB_KEY,
      env: "dev",
      dbPath: "/tmp/openclaw-xmtp-bus-test",
      shouldConsentDm: () => true,
      onMessage,
    });

    await xmtpMock.emit("reply", {
      getSenderAddress: async () => TEST_PEER_ADDRESS_UPPER,
      message: {
        senderInboxId: "inbox-1",
        content: {
          content: "hello reply",
          referenceId: "msg-parent-3",
          inReplyTo: {
            content: "original message",
          },
        },
        id: "msg-124",
      },
      conversation: { id: "conversation-1" },
      isDm: () => true,
    });

    expect(onMessage).toHaveBeenCalledWith({
      senderAddress: TEST_PEER_ADDRESS,
      senderInboxId: "inbox-1",
      conversationId: "conversation-1",
      isDm: true,
      text: "hello reply",
      messageId: "msg-124",
      replyContext: {
        referenceId: "msg-parent-3",
        referencedText: "original message",
      },
    });

    await bus.close();
  });

  it("auto-consents to new DM conversations", async () => {
    const updateConsentState = vi.fn();
    const bus = await startXmtpBus({
      walletKey: TEST_WALLET_KEY,
      dbEncryptionKey: TEST_DB_KEY,
      env: "dev",
      dbPath: "/tmp/openclaw-xmtp-bus-test",
      shouldConsentDm: () => true,
      onMessage: vi.fn(async () => {}),
    });

    await xmtpMock.emit("conversation", {
      conversation: { id: "conv-1", updateConsentState },
      isDm: (_conv: unknown) => true,
    });

    expect(updateConsentState).toHaveBeenCalledWith("allowed");

    await bus.close();
  });

  it("does not auto-consent to group conversations", async () => {
    const updateConsentState = vi.fn();
    const bus = await startXmtpBus({
      walletKey: TEST_WALLET_KEY,
      dbEncryptionKey: TEST_DB_KEY,
      env: "dev",
      dbPath: "/tmp/openclaw-xmtp-bus-test",
      shouldConsentDm: () => true,
      onMessage: vi.fn(async () => {}),
    });

    await xmtpMock.emit("conversation", {
      conversation: { id: "conv-1", updateConsentState },
      isDm: (_conv: unknown) => false,
    });

    expect(updateConsentState).not.toHaveBeenCalled();

    await bus.close();
  });

  it("ignores non-DM text events", async () => {
    const onMessage = vi.fn(async () => {});
    const bus = await startXmtpBus({
      walletKey: TEST_WALLET_KEY,
      dbEncryptionKey: TEST_DB_KEY,
      env: "dev",
      dbPath: "/tmp/openclaw-xmtp-bus-test",
      shouldConsentDm: () => true,
      onMessage,
    });

    await xmtpMock.emit("text", {
      getSenderAddress: async () => TEST_PEER_ADDRESS,
      message: {
        senderInboxId: "inbox-1",
        content: "hello inbound",
        id: "msg-123",
      },
      conversation: { id: "conversation-1" },
      isDm: () => false,
    });

    expect(onMessage).not.toHaveBeenCalled();

    await bus.close();
  });
});
