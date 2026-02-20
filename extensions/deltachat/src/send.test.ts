import type { RuntimeEnv } from "openclaw/plugin-sdk";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock external modules
vi.mock("./rpc-server.js", () => ({
  rpcServerManager: {
    get: vi.fn(),
    start: vi.fn(),
  },
}));

vi.mock("./targets.js", () => ({
  parseDeltaChatTarget: vi.fn((target: string) => {
    const lowered = target.trim().toLowerCase();
    // Strip deltachat: or email: prefix
    let stripped = target;
    if (lowered.startsWith("deltachat:")) {
      stripped = target.slice("deltachat:".length).trim();
    } else if (lowered.startsWith("email:")) {
      stripped = target.slice("email:".length).trim();
    } else if (lowered.startsWith("group:")) {
      return { kind: "chat_id", to: target.slice("group:".length).trim() };
    }
    if (/^\d+$/.test(stripped)) {
      return { kind: "chat_id", to: stripped };
    }
    return { kind: "email", to: stripped };
  }),
}));

vi.mock("./runtime.js", () => ({
  getDeltaChatRuntime: vi.fn(() => ({
    logging: { getChildLogger: vi.fn(() => ({ info: vi.fn(), error: vi.fn() })) },
    exit: vi.fn(),
  })),
  updateDeltaChatRuntimeState: vi.fn(),
}));

vi.mock("./accounts.js", () => ({
  resolveDeltaChatAccount: vi.fn(),
}));

vi.mock("./types.js", () => ({
  DEFAULT_DATA_DIR: "~/.openclaw/state/deltachat",
}));

vi.mock("./utils.js", () => ({
  ensureDataDir: vi.fn((dir) => dir),
}));

describe("Delta.Chat Send - chunkText", () => {
  // We need to test the chunkText function, but it's not exported
  // We'll test it indirectly through deliverReplies or create a test helper
  // For now, we'll test deliverReplies which uses chunkText internally

  describe("Delta.Chat Send - deliverReplies", () => {
    const mockRuntime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };

    const mockDc = {
      rpc: {
        miscSendTextMessage: vi.fn(),
        createContact: vi.fn(),
        createChatByContactId: vi.fn(),
      },
    };

    beforeEach(async () => {
      vi.clearAllMocks();
      const { rpcServerManager } = await import("./rpc-server.js");
      vi.mocked(rpcServerManager.get).mockReturnValue(mockDc as any);
      const { resolveDeltaChatAccount } = await import("./accounts.js");
      vi.mocked(resolveDeltaChatAccount).mockReturnValue({
        configured: true,
        enabled: true,
        accountId: "test-account",
        name: "test-account",
        config: {} as any,
      });
      // Mock createContact and createChatByContactId for deliverReplies
      // createContact returns a U32 (contact ID directly), not a contact object
      mockDc.rpc.createContact.mockResolvedValue(456);
      mockDc.rpc.createChatByContactId.mockResolvedValue(789);
    });

    it("should send short messages without chunking", async () => {
      const { deliverReplies } = await import("./send.js");
      const { updateDeltaChatRuntimeState } = await import("./runtime.js");

      const shortMessage = "Hello, this is a short message!";
      await deliverReplies({
        replies: [{ text: shortMessage }],
        target: "test@example.com",
        accountId: 1,
        runtime: mockRuntime,
        textLimit: 4000,
      });

      expect(mockDc.rpc.miscSendTextMessage).toHaveBeenCalledWith(1, 789, shortMessage);
      expect(updateDeltaChatRuntimeState).toHaveBeenCalledWith({
        lastOutboundAt: expect.any(Number),
      });
    });

    it("should chunk long messages that exceed the limit", async () => {
      const { deliverReplies } = await import("./send.js");
      const { updateDeltaChatRuntimeState } = await import("./runtime.js");

      // Create a message longer than 4000 characters
      const longMessage = "A".repeat(5000);
      const textLimit = 4000;

      await deliverReplies({
        replies: [{ text: longMessage }],
        target: "test@example.com",
        accountId: 1,
        runtime: mockRuntime,
        textLimit,
      });

      // Should be called twice (2 chunks)
      expect(mockDc.rpc.miscSendTextMessage).toHaveBeenCalledTimes(2);

      // First chunk should be approximately 4000 characters
      const firstCall = mockDc.rpc.miscSendTextMessage.mock.calls[0];
      expect(firstCall[2].length).toBeLessThanOrEqual(textLimit);

      // Second chunk should contain the remaining characters
      const secondCall = mockDc.rpc.miscSendTextMessage.mock.calls[1];
      expect(secondCall[2].length).toBeGreaterThan(0);
      expect(secondCall[2].length).toBeLessThanOrEqual(textLimit);

      // Total length should equal original message
      const totalLength = firstCall[2].length + secondCall[2].length;
      expect(totalLength).toBe(longMessage.length);

      expect(updateDeltaChatRuntimeState).toHaveBeenCalledWith({
        lastOutboundAt: expect.any(Number),
      });
    });

    it("should chunk messages at word boundaries when possible", async () => {
      const { deliverReplies } = await import("./send.js");

      // Create a message with spaces that should chunk at word boundaries
      // Build a message where there's a space within 100 chars before the limit
      const prefix = "word ".repeat(800); // ~4000 chars with spaces
      const suffix = "A".repeat(1000); // Additional chars to force chunking
      const longMessage = prefix + suffix; // ~5000 chars total
      const textLimit = 4000;

      await deliverReplies({
        replies: [{ text: longMessage }],
        target: "test@example.com",
        accountId: 1,
        runtime: mockRuntime,
        textLimit,
      });

      // Should be called at least twice
      expect(mockDc.rpc.miscSendTextMessage).toHaveBeenCalledTimes(2);

      // First chunk should end with a space (word boundary)
      const firstCall = mockDc.rpc.miscSendTextMessage.mock.calls[0];
      expect(firstCall[2]).toMatch(/\s$/);
    });

    it("should handle multiple replies", async () => {
      const { deliverReplies } = await import("./send.js");
      const { updateDeltaChatRuntimeState } = await import("./runtime.js");

      await deliverReplies({
        replies: [{ text: "First message" }, { text: "Second message" }, { text: "Third message" }],
        target: "test@example.com",
        accountId: 1,
        runtime: mockRuntime,
        textLimit: 4000,
      });

      expect(mockDc.rpc.miscSendTextMessage).toHaveBeenCalledTimes(3);
      expect(mockDc.rpc.miscSendTextMessage).toHaveBeenCalledWith(1, 789, "First message");
      expect(mockDc.rpc.miscSendTextMessage).toHaveBeenCalledWith(1, 789, "Second message");
      expect(mockDc.rpc.miscSendTextMessage).toHaveBeenCalledWith(1, 789, "Third message");
      expect(updateDeltaChatRuntimeState).toHaveBeenCalledTimes(3);
    });

    it("should skip empty messages", async () => {
      const { deliverReplies } = await import("./send.js");

      await deliverReplies({
        replies: [
          { text: "" },
          { text: "   " },
          { text: "Valid message" },
          { text: undefined as any },
        ],
        target: "test@example.com",
        accountId: 1,
        runtime: mockRuntime,
        textLimit: 4000,
      });

      // Only the valid message should be sent
      expect(mockDc.rpc.miscSendTextMessage).toHaveBeenCalledTimes(1);
      expect(mockDc.rpc.miscSendTextMessage).toHaveBeenCalledWith(1, 789, "Valid message");
    });

    it("should handle RPC errors gracefully", async () => {
      const { deliverReplies } = await import("./send.js");

      // Mock RPC error
      mockDc.rpc.miscSendTextMessage.mockRejectedValue(new Error("RPC error"));

      await deliverReplies({
        replies: [{ text: "Test message" }],
        target: "test@example.com",
        accountId: 1,
        runtime: mockRuntime,
        textLimit: 4000,
      });

      // Should log error but not throw
      expect(mockRuntime.error).toHaveBeenCalledWith(
        "Failed to send reply to chatId 789: RPC error",
      );
    });

    it("should handle missing RPC client", async () => {
      const { deliverReplies } = await import("./send.js");
      const { rpcServerManager } = await import("./rpc-server.js");

      // Mock RPC not available
      vi.mocked(rpcServerManager.get).mockReturnValue(null);

      await deliverReplies({
        replies: [{ text: "Test message" }],
        target: "test@example.com",
        accountId: 1,
        runtime: mockRuntime,
        textLimit: 4000,
      });

      // Should log error
      expect(mockRuntime.error).toHaveBeenCalledWith("Delta.Chat RPC not available");
    });

    it("should handle missing target", async () => {
      const { deliverReplies } = await import("./send.js");

      // Mock RPC to throw error for empty target
      mockDc.rpc.miscSendTextMessage.mockRejectedValue(new Error("Invalid target"));

      await deliverReplies({
        replies: [{ text: "Test message" }],
        target: "",
        accountId: 1,
        runtime: mockRuntime,
        textLimit: 4000,
      });

      // Should log error about sending reply
      expect(mockRuntime.error).toHaveBeenCalledWith(
        "Failed to send reply to chatId 789: Invalid target",
      );
    });

    it("should chunk very long messages into multiple chunks", async () => {
      const { deliverReplies } = await import("./send.js");

      // Create a message that needs 3 chunks
      const veryLongMessage = "A".repeat(10000);
      const textLimit = 4000;

      await deliverReplies({
        replies: [{ text: veryLongMessage }],
        target: "test@example.com",
        accountId: 1,
        runtime: mockRuntime,
        textLimit,
      });

      // Should be called 3 times
      expect(mockDc.rpc.miscSendTextMessage).toHaveBeenCalledTimes(3);

      // Verify each chunk is within limit
      for (const call of mockDc.rpc.miscSendTextMessage.mock.calls) {
        expect(call[2].length).toBeLessThanOrEqual(textLimit);
      }

      // Verify total length
      const totalLength = mockDc.rpc.miscSendTextMessage.mock.calls
        .map((call: any) => call[2].length)
        .reduce((a: number, b: number) => a + b, 0);
      expect(totalLength).toBe(veryLongMessage.length);
    });

    it("should handle messages exactly at the limit", async () => {
      const { deliverReplies } = await import("./send.js");

      const exactLimitMessage = "A".repeat(4000);
      const textLimit = 4000;

      await deliverReplies({
        replies: [{ text: exactLimitMessage }],
        target: "test@example.com",
        accountId: 1,
        runtime: mockRuntime,
        textLimit,
      });

      // Should be called once (no chunking needed)
      expect(mockDc.rpc.miscSendTextMessage).toHaveBeenCalledTimes(1);
      expect(mockDc.rpc.miscSendTextMessage).toHaveBeenCalledWith(1, 789, exactLimitMessage);
    });

    it("should handle messages just over the limit", async () => {
      const { deliverReplies } = await import("./send.js");

      const justOverLimitMessage = "A".repeat(4001);
      const textLimit = 4000;

      await deliverReplies({
        replies: [{ text: justOverLimitMessage }],
        target: "test@example.com",
        accountId: 1,
        runtime: mockRuntime,
        textLimit,
      });

      // Should be called twice (needs chunking)
      expect(mockDc.rpc.miscSendTextMessage).toHaveBeenCalledTimes(2);

      // First chunk should be at the limit
      const firstCall = mockDc.rpc.miscSendTextMessage.mock.calls[0];
      expect(firstCall[2].length).toBe(textLimit);

      // Second chunk should have 1 character
      const secondCall = mockDc.rpc.miscSendTextMessage.mock.calls[1];
      expect(secondCall[2].length).toBe(1);
    });
  });
});

describe("Delta.Chat Send - sendMessageDeltaChat", () => {
  const mockRuntime: RuntimeEnv = {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };

  const mockDc = {
    rpc: {
      getAllAccounts: vi.fn(),
      addAccount: vi.fn(),
      getAccountInfo: vi.fn(),
      startIo: vi.fn(),
      createContact: vi.fn(),
      createChatByContactId: vi.fn(),
      miscSendTextMessage: vi.fn(),
    },
  };

  const mockConfig = {
    channels: {
      deltachat: {
        enabled: true,
        dataDir: "/test/dir",
      },
    },
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const { rpcServerManager } = await import("./rpc-server.js");
    vi.mocked(rpcServerManager.start).mockResolvedValue(mockDc as any);
    const { getDeltaChatRuntime } = await import("./runtime.js");
    vi.mocked(getDeltaChatRuntime).mockReturnValue({
      logging: { getChildLogger: vi.fn(() => ({ info: vi.fn(), error: vi.fn() })) },
      exit: vi.fn(),
    } as any);
    const { resolveDeltaChatAccount } = await import("./accounts.js");
    vi.mocked(resolveDeltaChatAccount).mockReturnValue({
      configured: true,
      enabled: true,
      accountId: "test-account",
      name: "test-account",
      config: {} as any,
    });
  });

  it("should send message successfully", async () => {
    const { sendMessageDeltaChat } = await import("./send.js");
    const { updateDeltaChatRuntimeState } = await import("./runtime.js");
    const { resolveDeltaChatAccount } = await import("./accounts.js");

    // Mock account exists and is configured
    vi.mocked(resolveDeltaChatAccount).mockReturnValue({
      configured: true,
      enabled: true,
      accountId: "test",
      name: "test",
      config: {} as any,
    });
    mockDc.rpc.getAllAccounts.mockResolvedValue([{ id: "test", kind: "Configured" }]);
    // createContact returns a U32 (contact ID directly), not a contact object
    mockDc.rpc.createContact.mockResolvedValue(456);
    mockDc.rpc.createChatByContactId.mockResolvedValue(789);
    mockDc.rpc.miscSendTextMessage.mockResolvedValue(123);

    const result = await sendMessageDeltaChat("test@example.com", "Hello, world!", {
      cfg: mockConfig as any,
      accountId: "test",
    });

    expect(result.ok).toBe(true);
    expect(result.messageId).toBe("123");
    expect(mockDc.rpc.miscSendTextMessage).toHaveBeenCalledWith("test", 789, "Hello, world!");
    expect(updateDeltaChatRuntimeState).toHaveBeenCalledWith({
      lastOutboundAt: expect.any(Number),
    });
  });

  it("should create chat if no chatId provided", async () => {
    const { sendMessageDeltaChat } = await import("./send.js");

    // Mock account exists and is configured
    mockDc.rpc.getAllAccounts.mockResolvedValue([{ id: "test", kind: "Configured" }]);
    // createContact returns a U32 (contact ID directly), not a contact object
    mockDc.rpc.createContact.mockResolvedValue(456);
    mockDc.rpc.createChatByContactId.mockResolvedValue(789);
    mockDc.rpc.miscSendTextMessage.mockResolvedValue(123);

    const result = await sendMessageDeltaChat("test@example.com", "Hello, world!", {
      cfg: mockConfig as any,
      accountId: "test",
    });

    expect(result.ok).toBe(true);
    expect(mockDc.rpc.createContact).toHaveBeenCalledWith(
      "test",
      "test@example.com",
      "test@example.com",
    );
    expect(mockDc.rpc.createChatByContactId).toHaveBeenCalledWith("test", 456);
    expect(mockDc.rpc.miscSendTextMessage).toHaveBeenCalledWith("test", 789, "Hello, world!");
  });

  it("should strip deltachat: prefix from to address before sending (regression: /new reply)", async () => {
    const { sendMessageDeltaChat } = await import("./send.js");

    mockDc.rpc.getAllAccounts.mockResolvedValue([{ id: "test", kind: "Configured" }]);
    mockDc.rpc.createContact.mockResolvedValue(456);
    mockDc.rpc.createChatByContactId.mockResolvedValue(789);
    mockDc.rpc.miscSendTextMessage.mockResolvedValue(123);

    // The /new confirmation route sends to "deltachat:user@example.com" (with prefix)
    const result = await sendMessageDeltaChat(
      "deltachat:user@example.com",
      "✅ New session started",
      { cfg: mockConfig as any, accountId: "test" },
    );

    expect(result.ok).toBe(true);
    // createContact must receive the bare email, not "deltachat:user@example.com"
    expect(mockDc.rpc.createContact).toHaveBeenCalledWith(
      "test",
      "user@example.com",
      "user@example.com",
    );
    expect(mockDc.rpc.miscSendTextMessage).toHaveBeenCalledWith(
      "test",
      789,
      "✅ New session started",
    );
  });

  it("should use provided chatId if available", async () => {
    const { sendMessageDeltaChat } = await import("./send.js");

    // Mock account exists and is configured
    mockDc.rpc.getAllAccounts.mockResolvedValue([{ id: "test", kind: "Configured" }]);
    mockDc.rpc.miscSendTextMessage.mockResolvedValue(123);

    const result = await sendMessageDeltaChat("test@example.com", "Hello, world!", {
      cfg: mockConfig as any,
      accountId: "test",
      chatId: 999,
    });

    expect(result.ok).toBe(true);
    expect(mockDc.rpc.createContact).not.toHaveBeenCalled();
    expect(mockDc.rpc.createChatByContactId).not.toHaveBeenCalled();
    expect(mockDc.rpc.miscSendTextMessage).toHaveBeenCalledWith("test", 999, "Hello, world!");
  });

  it("should return error if account is not configured", async () => {
    const { sendMessageDeltaChat } = await import("./send.js");
    const { resolveDeltaChatAccount } = await import("./accounts.js");

    // Mock unconfigured account
    vi.mocked(resolveDeltaChatAccount).mockReturnValue({
      configured: false,
      enabled: true,
      accountId: "test",
      name: "test",
      config: {} as any,
    });

    const result = await sendMessageDeltaChat("test@example.com", "Hello, world!", {
      cfg: mockConfig as any,
      accountId: "test",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Delta.Chat account is not configured");
  });

  it("should return error if account is disabled", async () => {
    const { sendMessageDeltaChat } = await import("./send.js");
    const { resolveDeltaChatAccount } = await import("./accounts.js");

    // Mock disabled account
    vi.mocked(resolveDeltaChatAccount).mockReturnValue({
      configured: true,
      enabled: false,
      accountId: "test",
      name: "test",
      config: {} as any,
    });

    const result = await sendMessageDeltaChat("test@example.com", "Hello, world!", {
      cfg: mockConfig as any,
      accountId: "test",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Delta.Chat account is disabled");
  });

  it("should return error if RPC server fails to start", async () => {
    const { sendMessageDeltaChat } = await import("./send.js");
    const { rpcServerManager } = await import("./rpc-server.js");

    // Mock RPC server failure
    vi.mocked(rpcServerManager.start).mockResolvedValue(null);

    const result = await sendMessageDeltaChat("test@example.com", "Hello, world!", {
      cfg: mockConfig as any,
      accountId: "test",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Failed to start Delta.Chat RPC server");
  });

  it("should handle chat creation errors gracefully", async () => {
    const { sendMessageDeltaChat } = await import("./send.js");

    // Mock account exists and is configured
    mockDc.rpc.getAllAccounts.mockResolvedValue([{ id: "test", kind: "Configured" }]);
    mockDc.rpc.createContact.mockRejectedValue(new Error("Failed to create contact"));

    const result = await sendMessageDeltaChat("test@example.com", "Hello, world!", {
      cfg: mockConfig as any,
      accountId: "test",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Failed to create chat with test@example.com");
  });

  it("should handle send errors gracefully", async () => {
    const { sendMessageDeltaChat } = await import("./send.js");
    const { resolveDeltaChatAccount } = await import("./accounts.js");

    // Mock account exists and is configured
    vi.mocked(resolveDeltaChatAccount).mockReturnValue({
      configured: true,
      enabled: true,
      accountId: "test",
      name: "test",
      config: {} as any,
    });
    mockDc.rpc.getAllAccounts.mockResolvedValue([{ id: "test", kind: "Configured" }]);
    // Mock successful chat creation
    // createContact returns a U32 (contact ID directly), not a contact object
    mockDc.rpc.createContact.mockResolvedValue(456);
    mockDc.rpc.createChatByContactId.mockResolvedValue(789);
    // Mock send error
    mockDc.rpc.miscSendTextMessage.mockRejectedValue(new Error("Failed to send message"));

    const result = await sendMessageDeltaChat("test@example.com", "Hello, world!", {
      cfg: mockConfig as any,
      accountId: "test",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe("Failed to send message");
  });

  it("should start IO for configured accounts", async () => {
    const { sendMessageDeltaChat } = await import("./send.js");

    // Mock account exists and is configured
    mockDc.rpc.getAllAccounts.mockResolvedValue([{ id: "test", kind: "Configured" }]);
    mockDc.rpc.miscSendTextMessage.mockResolvedValue(123);

    await sendMessageDeltaChat("test@example.com", "Hello, world!", {
      cfg: mockConfig as any,
      accountId: "test",
    });

    expect(mockDc.rpc.startIo).toHaveBeenCalledWith("test");
  });

  it("should not start IO for unconfigured accounts", async () => {
    const { sendMessageDeltaChat } = await import("./send.js");

    // Mock unconfigured account
    mockDc.rpc.getAllAccounts.mockResolvedValue([{ id: "test", kind: "Unconfigured" }]);

    await sendMessageDeltaChat("test@example.com", "Hello, world!", {
      cfg: mockConfig as any,
      accountId: "test",
    });

    expect(mockDc.rpc.startIo).not.toHaveBeenCalled();
  });
});
