import { describe, expect, it, vi, beforeEach } from "vitest";
import { normalizeEthAddress, startXmtpBus } from "./xmtp-bus.js";

const TEST_WALLET_KEY = "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const TEST_DB_KEY = "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const TEST_PEER_ADDRESS = "0x1234567890abcdef1234567890abcdef12345678";
const TEST_PEER_ADDRESS_UPPER = "0x1234567890ABCDEF1234567890ABCDEF12345678";

const xmtpMock = vi.hoisted(() => {
  const handlers = new Map<string, Array<(ctx: unknown) => Promise<void> | void>>();
  const sendByConversation = vi.fn(async (_text: string) => {});
  const sendByAddressDm = vi.fn(async (_text: string) => {});
  const getConversationById = vi.fn(async (id: string) => {
    if (id === "missing-conversation") {
      return null;
    }
    return {
      sendText: sendByConversation,
    };
  });
  const createDmWithAddress = vi.fn(async (_address: string) => ({
    sendText: sendByAddressDm,
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
    sendByAddressDm,
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
      sendByAddressDm.mockReset();
      getConversationById.mockReset();
      getConversationById.mockImplementation(async (id: string) => {
        if (id === "missing-conversation") {
          return null;
        }
        return {
          sendText: sendByConversation,
        };
      });
      createDmWithAddress.mockReset();
      createDmWithAddress.mockImplementation(async (_address: string) => ({
        sendText: sendByAddressDm,
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
      onMessage: vi.fn(async () => {}),
    });

    await bus.sendText("conversation-1", "hello");

    expect(xmtpMock.getConversationById).toHaveBeenCalledWith("conversation-1");
    expect(xmtpMock.sendByConversation).toHaveBeenCalledWith("hello");
    expect(xmtpMock.createDmWithAddress).not.toHaveBeenCalled();

    await bus.close();
  });

  it("creates/uses a DM conversation when target is an ethereum address", async () => {
    const bus = await startXmtpBus({
      walletKey: TEST_WALLET_KEY,
      dbEncryptionKey: TEST_DB_KEY,
      env: "dev",
      dbPath: "/tmp/openclaw-xmtp-bus-test",
      onMessage: vi.fn(async () => {}),
    });

    await bus.sendText(TEST_PEER_ADDRESS_UPPER, "hello from address");

    expect(xmtpMock.createDmWithAddress).toHaveBeenCalledWith(TEST_PEER_ADDRESS);
    expect(xmtpMock.sendByAddressDm).toHaveBeenCalledWith("hello from address");
    expect(xmtpMock.getConversationById).not.toHaveBeenCalledWith(TEST_PEER_ADDRESS);

    await bus.close();
  });

  it("throws when a conversation id cannot be resolved", async () => {
    const bus = await startXmtpBus({
      walletKey: TEST_WALLET_KEY,
      dbEncryptionKey: TEST_DB_KEY,
      env: "dev",
      dbPath: "/tmp/openclaw-xmtp-bus-test",
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

  it("ignores non-DM text events", async () => {
    const onMessage = vi.fn(async () => {});
    const bus = await startXmtpBus({
      walletKey: TEST_WALLET_KEY,
      dbEncryptionKey: TEST_DB_KEY,
      env: "dev",
      dbPath: "/tmp/openclaw-xmtp-bus-test",
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
