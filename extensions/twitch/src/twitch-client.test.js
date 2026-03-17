import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TwitchClientManager } from "./twitch-client.js";
const mockConnect = vi.fn().mockResolvedValue(void 0);
const mockJoin = vi.fn().mockResolvedValue(void 0);
const mockSay = vi.fn().mockResolvedValue({ messageId: "test-msg-123" });
const mockQuit = vi.fn();
const mockUnbind = vi.fn();
const messageHandlers = [];
const mockOnMessage = vi.fn((handler) => {
  messageHandlers.push(handler);
  return { unbind: mockUnbind };
});
const mockAddUserForToken = vi.fn().mockResolvedValue("123456");
const mockOnRefresh = vi.fn();
const mockOnRefreshFailure = vi.fn();
vi.mock("@twurple/chat", () => ({
  ChatClient: class {
    constructor() {
      this.onMessage = mockOnMessage;
      this.connect = mockConnect;
      this.join = mockJoin;
      this.say = mockSay;
      this.quit = mockQuit;
    }
  },
  LogLevel: {
    CRITICAL: "CRITICAL",
    ERROR: "ERROR",
    WARNING: "WARNING",
    INFO: "INFO",
    DEBUG: "DEBUG",
    TRACE: "TRACE"
  }
}));
const mockAuthProvider = {
  constructor: vi.fn()
};
vi.mock("@twurple/auth", () => ({
  StaticAuthProvider: class {
    constructor(...args) {
      mockAuthProvider.constructor(...args);
    }
  },
  RefreshingAuthProvider: class {
    constructor() {
      this.addUserForToken = mockAddUserForToken;
      this.onRefresh = mockOnRefresh;
      this.onRefreshFailure = mockOnRefreshFailure;
    }
  }
}));
vi.mock("./token.js", () => ({
  resolveTwitchToken: vi.fn(() => ({
    token: "oauth:mock-token-from-tests",
    source: "config"
  })),
  DEFAULT_ACCOUNT_ID: "default"
}));
describe("TwitchClientManager", () => {
  let manager;
  let mockLogger;
  const testAccount = {
    username: "testbot",
    accessToken: "test123456",
    clientId: "test-client-id",
    channel: "testchannel",
    enabled: true
  };
  const testAccount2 = {
    username: "testbot2",
    accessToken: "test789",
    clientId: "test-client-id-2",
    channel: "testchannel2",
    enabled: true
  };
  beforeEach(async () => {
    vi.clearAllMocks();
    messageHandlers.length = 0;
    const { resolveTwitchToken } = await import("./token.js");
    vi.mocked(resolveTwitchToken).mockReturnValue({
      token: "oauth:mock-token-from-tests",
      source: "config"
    });
    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn()
    };
    manager = new TwitchClientManager(mockLogger);
  });
  afterEach(() => {
    manager._clearForTest();
  });
  describe("getClient", () => {
    it("should create a new client connection", async () => {
      const _client = await manager.getClient(testAccount);
      expect(mockConnect).toHaveBeenCalledTimes(1);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining("Connected to Twitch as testbot")
      );
    });
    it("should use account username as default channel when channel not specified", async () => {
      const accountWithoutChannel = {
        ...testAccount,
        channel: ""
      };
      await manager.getClient(accountWithoutChannel);
      expect(mockConnect).toHaveBeenCalledTimes(1);
    });
    it("should reuse existing client for same account", async () => {
      const client1 = await manager.getClient(testAccount);
      const client2 = await manager.getClient(testAccount);
      expect(client1).toBe(client2);
      expect(mockConnect).toHaveBeenCalledTimes(1);
    });
    it("should create separate clients for different accounts", async () => {
      await manager.getClient(testAccount);
      await manager.getClient(testAccount2);
      expect(mockConnect).toHaveBeenCalledTimes(2);
    });
    it("should normalize token by removing oauth: prefix", async () => {
      const accountWithPrefix = {
        ...testAccount,
        accessToken: "oauth:actualtoken123"
      };
      const { resolveTwitchToken } = await import("./token.js");
      vi.mocked(resolveTwitchToken).mockReturnValue({
        token: "oauth:actualtoken123",
        source: "config"
      });
      await manager.getClient(accountWithPrefix);
      expect(mockAuthProvider.constructor).toHaveBeenCalledWith("test-client-id", "actualtoken123");
    });
    it("should use token directly when no oauth: prefix", async () => {
      const { resolveTwitchToken } = await import("./token.js");
      vi.mocked(resolveTwitchToken).mockReturnValue({
        token: "oauth:mock-token-from-tests",
        source: "config"
      });
      await manager.getClient(testAccount);
      expect(mockAuthProvider.constructor).toHaveBeenCalledWith(
        "test-client-id",
        "mock-token-from-tests"
      );
    });
    it("should throw error when clientId is missing", async () => {
      const accountWithoutClientId = {
        ...testAccount,
        clientId: ""
      };
      await expect(manager.getClient(accountWithoutClientId)).rejects.toThrow(
        "Missing Twitch client ID"
      );
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining("Missing Twitch client ID")
      );
    });
    it("should throw error when token is missing", async () => {
      const { resolveTwitchToken } = await import("./token.js");
      vi.mocked(resolveTwitchToken).mockReturnValue({
        token: "",
        source: "none"
      });
      await expect(manager.getClient(testAccount)).rejects.toThrow("Missing Twitch token");
    });
    it("should set up message handlers on client connection", async () => {
      await manager.getClient(testAccount);
      expect(mockOnMessage).toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining("Set up handlers for"));
    });
    it("should create separate clients for same account with different channels", async () => {
      const account1 = {
        ...testAccount,
        channel: "channel1"
      };
      const account2 = {
        ...testAccount,
        channel: "channel2"
      };
      await manager.getClient(account1);
      await manager.getClient(account2);
      expect(mockConnect).toHaveBeenCalledTimes(2);
    });
  });
  describe("onMessage", () => {
    it("should register message handler for account", () => {
      const handler = vi.fn();
      manager.onMessage(testAccount, handler);
      expect(handler).not.toHaveBeenCalled();
    });
    it("should replace existing handler for same account", () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      manager.onMessage(testAccount, handler1);
      manager.onMessage(testAccount, handler2);
      const key = manager.getAccountKey(testAccount);
      expect(manager.messageHandlers.get(key)).toBe(handler2);
    });
  });
  describe("disconnect", () => {
    it("should disconnect a connected client", async () => {
      await manager.getClient(testAccount);
      await manager.disconnect(testAccount);
      expect(mockQuit).toHaveBeenCalledTimes(1);
      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining("Disconnected"));
    });
    it("should clear client and message handler", async () => {
      const handler = vi.fn();
      await manager.getClient(testAccount);
      manager.onMessage(testAccount, handler);
      await manager.disconnect(testAccount);
      const key = manager.getAccountKey(testAccount);
      expect(manager.clients.has(key)).toBe(false);
      expect(manager.messageHandlers.has(key)).toBe(false);
    });
    it("should handle disconnecting non-existent client gracefully", async () => {
      await manager.disconnect(testAccount);
      expect(mockQuit).not.toHaveBeenCalled();
    });
    it("should only disconnect specified account when multiple accounts exist", async () => {
      await manager.getClient(testAccount);
      await manager.getClient(testAccount2);
      await manager.disconnect(testAccount);
      expect(mockQuit).toHaveBeenCalledTimes(1);
      const key2 = manager.getAccountKey(testAccount2);
      expect(manager.clients.has(key2)).toBe(true);
    });
  });
  describe("disconnectAll", () => {
    it("should disconnect all connected clients", async () => {
      await manager.getClient(testAccount);
      await manager.getClient(testAccount2);
      await manager.disconnectAll();
      expect(mockQuit).toHaveBeenCalledTimes(2);
      expect(manager.clients.size).toBe(0);
      expect(manager.messageHandlers.size).toBe(0);
    });
    it("should handle empty client list gracefully", async () => {
      await manager.disconnectAll();
      expect(mockQuit).not.toHaveBeenCalled();
    });
  });
  describe("sendMessage", () => {
    beforeEach(async () => {
      await manager.getClient(testAccount);
    });
    it("should send message successfully", async () => {
      const result = await manager.sendMessage(testAccount, "testchannel", "Hello, world!");
      expect(result.ok).toBe(true);
      expect(result.messageId).toBeDefined();
      expect(mockSay).toHaveBeenCalledWith("testchannel", "Hello, world!");
    });
    it("should generate unique message ID for each message", async () => {
      const result1 = await manager.sendMessage(testAccount, "testchannel", "First message");
      const result2 = await manager.sendMessage(testAccount, "testchannel", "Second message");
      expect(result1.messageId).not.toBe(result2.messageId);
    });
    it("should handle sending to account's default channel", async () => {
      const result = await manager.sendMessage(
        testAccount,
        testAccount.channel || testAccount.username,
        "Test message"
      );
      expect(result.ok).toBe(true);
      expect(mockSay).toHaveBeenCalled();
    });
    it("should return error on send failure", async () => {
      mockSay.mockRejectedValueOnce(new Error("Rate limited"));
      const result = await manager.sendMessage(testAccount, "testchannel", "Test message");
      expect(result.ok).toBe(false);
      expect(result.error).toBe("Rate limited");
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining("Failed to send message")
      );
    });
    it("should handle unknown error types", async () => {
      mockSay.mockRejectedValueOnce("String error");
      const result = await manager.sendMessage(testAccount, "testchannel", "Test message");
      expect(result.ok).toBe(false);
      expect(result.error).toBe("String error");
    });
    it("should create client if not already connected", async () => {
      manager.clients.clear();
      const connectCallCountBefore = mockConnect.mock.calls.length;
      const result = await manager.sendMessage(testAccount, "testchannel", "Test message");
      expect(result.ok).toBe(true);
      expect(mockConnect.mock.calls.length).toBeGreaterThan(connectCallCountBefore);
    });
  });
  describe("message handling integration", () => {
    let capturedMessage = null;
    beforeEach(() => {
      capturedMessage = null;
      manager.onMessage(testAccount, (message) => {
        capturedMessage = message;
      });
    });
    it("should handle incoming chat messages", async () => {
      await manager.getClient(testAccount);
      const onMessageCallback = messageHandlers[0];
      if (!onMessageCallback) {
        throw new Error("onMessageCallback not found");
      }
      onMessageCallback("#testchannel", "testuser", "Hello bot!", {
        userInfo: {
          userName: "testuser",
          displayName: "TestUser",
          userId: "12345",
          isMod: false,
          isBroadcaster: false,
          isVip: false,
          isSubscriber: false
        },
        id: "msg123"
      });
      expect(capturedMessage).not.toBeNull();
      expect(capturedMessage?.username).toBe("testuser");
      expect(capturedMessage?.displayName).toBe("TestUser");
      expect(capturedMessage?.userId).toBe("12345");
      expect(capturedMessage?.message).toBe("Hello bot!");
      expect(capturedMessage?.channel).toBe("testchannel");
      expect(capturedMessage?.chatType).toBe("group");
    });
    it("should normalize channel names without # prefix", async () => {
      await manager.getClient(testAccount);
      const onMessageCallback = messageHandlers[0];
      onMessageCallback("testchannel", "testuser", "Test", {
        userInfo: {
          userName: "testuser",
          displayName: "TestUser",
          userId: "123",
          isMod: false,
          isBroadcaster: false,
          isVip: false,
          isSubscriber: false
        },
        id: "msg1"
      });
      expect(capturedMessage?.channel).toBe("testchannel");
    });
    it("should include user role flags in message", async () => {
      await manager.getClient(testAccount);
      const onMessageCallback = messageHandlers[0];
      onMessageCallback("#testchannel", "moduser", "Test", {
        userInfo: {
          userName: "moduser",
          displayName: "ModUser",
          userId: "456",
          isMod: true,
          isBroadcaster: false,
          isVip: true,
          isSubscriber: true
        },
        id: "msg2"
      });
      expect(capturedMessage?.isMod).toBe(true);
      expect(capturedMessage?.isVip).toBe(true);
      expect(capturedMessage?.isSub).toBe(true);
      expect(capturedMessage?.isOwner).toBe(false);
    });
    it("should handle broadcaster messages", async () => {
      await manager.getClient(testAccount);
      const onMessageCallback = messageHandlers[0];
      onMessageCallback("#testchannel", "broadcaster", "Test", {
        userInfo: {
          userName: "broadcaster",
          displayName: "Broadcaster",
          userId: "789",
          isMod: false,
          isBroadcaster: true,
          isVip: false,
          isSubscriber: false
        },
        id: "msg3"
      });
      expect(capturedMessage?.isOwner).toBe(true);
    });
  });
  describe("edge cases", () => {
    it("should handle multiple message handlers for different accounts", async () => {
      const messages1 = [];
      const messages2 = [];
      manager.onMessage(testAccount, (msg) => messages1.push(msg));
      manager.onMessage(testAccount2, (msg) => messages2.push(msg));
      await manager.getClient(testAccount);
      await manager.getClient(testAccount2);
      const onMessage1 = messageHandlers[0];
      if (!onMessage1) {
        throw new Error("onMessage1 not found");
      }
      onMessage1("#testchannel", "user1", "msg1", {
        userInfo: {
          userName: "user1",
          displayName: "User1",
          userId: "1",
          isMod: false,
          isBroadcaster: false,
          isVip: false,
          isSubscriber: false
        },
        id: "1"
      });
      const onMessage2 = messageHandlers[1];
      if (!onMessage2) {
        throw new Error("onMessage2 not found");
      }
      onMessage2("#testchannel2", "user2", "msg2", {
        userInfo: {
          userName: "user2",
          displayName: "User2",
          userId: "2",
          isMod: false,
          isBroadcaster: false,
          isVip: false,
          isSubscriber: false
        },
        id: "2"
      });
      expect(messages1).toHaveLength(1);
      expect(messages2).toHaveLength(1);
      expect(messages1[0]?.message).toBe("msg1");
      expect(messages2[0]?.message).toBe("msg2");
    });
    it("should handle rapid client creation requests", async () => {
      const promises = [
        manager.getClient(testAccount),
        manager.getClient(testAccount),
        manager.getClient(testAccount)
      ];
      await Promise.all(promises);
      expect(mockConnect).toHaveBeenCalled();
    });
  });
});
