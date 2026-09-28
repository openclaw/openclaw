import { expectDefined } from "@openclaw/normalization-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveTwitchToken } from "./token.js";
import { TwitchClientManager } from "./twitch-client.js";
import type {
  ChannelAccountSnapshot,
  ChannelLogSink,
  TwitchAccountConfig,
  TwitchChatMessage,
} from "./types.js";

// Mock @twurple dependencies
const mockConnect = vi.fn(() => {
  for (const handler of authSuccessHandlers) {
    handler();
  }
});
const mockJoin = vi.fn().mockResolvedValue(undefined);
const mockSay = vi.fn().mockResolvedValue(undefined);
const mockQuit = vi.fn();
const mockUnbind = vi.fn();

const defaultUserInfo = {
  userName: "testuser",
  displayName: "TestUser",
  userId: "123",
  isMod: false,
  isBroadcaster: false,
  isVip: false,
  isSubscriber: false,
};

function ircMessage(id: string, userInfo: Partial<typeof defaultUserInfo> = {}) {
  return { id, userInfo: { ...defaultUserInfo, ...userInfo } };
}

const messageHandlers: Array<
  (channel: string, user: string, message: string, msg: ReturnType<typeof ircMessage>) => void
> = [];
const authSuccessHandlers: Array<() => void> = [];
const authFailureHandlers: Array<(text: string, retryCount: number) => void> = [];
const disconnectHandlers: Array<(manual: boolean, reason?: Error) => void> = [];

type TwitchClientManagerState = {
  clients: Map<string, unknown>;
  messageHandlers: Map<string, (message: TwitchChatMessage) => void>;
};

function managerState(manager: TwitchClientManager): TwitchClientManagerState {
  return manager as unknown as TwitchClientManagerState;
}

// Mock functions that track handlers and return unbind objects
const mockOnMessage = vi.fn((handler: (typeof messageHandlers)[number]) => {
  messageHandlers.push(handler);
  return { unbind: mockUnbind };
});
const mockOnAuthenticationSuccess = vi.fn((handler: () => void) => {
  authSuccessHandlers.push(handler);
  return { unbind: mockUnbind };
});
const mockOnAuthenticationFailure = vi.fn((handler: (text: string, retryCount: number) => void) => {
  authFailureHandlers.push(handler);
  return { unbind: mockUnbind };
});
const mockOnDisconnect = vi.fn((handler: (manual: boolean, reason?: Error) => void) => {
  disconnectHandlers.push(handler);
  return { unbind: mockUnbind };
});

const mockAddUserForToken = vi.fn().mockResolvedValue("123456");
const mockOnRefresh = vi.fn();
const mockOnRefreshFailure = vi.fn();

vi.mock("@twurple/chat", () => ({
  ChatClient: class {
    onMessage = mockOnMessage;
    onAuthenticationSuccess = mockOnAuthenticationSuccess;
    onAuthenticationFailure = mockOnAuthenticationFailure;
    onDisconnect = mockOnDisconnect;
    connect = mockConnect;
    join = mockJoin;
    say = mockSay;
    quit = mockQuit;
  },
  LogLevel: {
    CRITICAL: "CRITICAL",
    ERROR: "ERROR",
    WARNING: "WARNING",
    INFO: "INFO",
    DEBUG: "DEBUG",
    TRACE: "TRACE",
  },
}));

const mockAuthProvider = {
  constructor: vi.fn(),
};

vi.mock("@twurple/auth", () => ({
  StaticAuthProvider: function StaticAuthProvider(...args: unknown[]) {
    mockAuthProvider.constructor(...args);
  },
  RefreshingAuthProvider: class {
    addUserForToken = mockAddUserForToken;
    onRefresh = mockOnRefresh;
    onRefreshFailure = mockOnRefreshFailure;
  },
}));

// Mock token resolution - must be after @twurple/auth mock
vi.mock("./token.js", () => ({
  resolveTwitchToken: vi.fn(() => ({
    token: "oauth:mock-token-from-tests",
    source: "config" as const,
  })),
  DEFAULT_ACCOUNT_ID: "default",
}));

describe("TwitchClientManager", () => {
  let manager: TwitchClientManager;
  let mockLogger: ChannelLogSink;
  let statusSink: ReturnType<
    typeof vi.fn<(patch: Omit<ChannelAccountSnapshot, "accountId">) => void>
  >;
  const resolveTwitchTokenMock = vi.mocked(resolveTwitchToken);

  const testAccount: TwitchAccountConfig = {
    username: "testbot",
    accessToken: "test123456",
    clientId: "test-client-id",
    channel: "testchannel",
    enabled: true,
  };

  const testAccount2: TwitchAccountConfig = {
    username: "testbot2",
    accessToken: "test789",
    clientId: "test-client-id-2",
    channel: "testchannel2",
    enabled: true,
  };

  const refreshingAccount: TwitchAccountConfig = {
    ...testAccount,
    clientSecret: "test-client-secret",
    refreshToken: "test-refresh-token",
    expiresIn: 3600,
    obtainmentTimestamp: 1_700_000_000_000,
  };

  beforeEach(() => {
    vi.clearAllMocks();

    messageHandlers.length = 0;
    authSuccessHandlers.length = 0;
    authFailureHandlers.length = 0;
    disconnectHandlers.length = 0;

    resolveTwitchTokenMock.mockReturnValue({
      token: "oauth:mock-token-from-tests",
      source: "config" as const,
    });

    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    statusSink = vi.fn<(patch: Omit<ChannelAccountSnapshot, "accountId">) => void>();
    manager = new TwitchClientManager(mockLogger, statusSink);
  });

  describe("getClient", () => {
    it("publishes ready and recovering from authentication and disconnect events", async () => {
      await manager.getClient(testAccount);
      expect(statusSink).toHaveBeenCalledWith(
        expect.objectContaining({ lifecycle: "ready", connected: true }),
      );

      authFailureHandlers.at(-1)?.("retrying auth", 1);
      expect(statusSink).toHaveBeenLastCalledWith(
        expect.objectContaining({ lifecycle: "recovering", lastError: "retrying auth" }),
      );

      disconnectHandlers.at(-1)?.(false, new Error("connection lost"));
      expect(statusSink).toHaveBeenLastCalledWith(
        expect.objectContaining({ lifecycle: "recovering", lastError: "connection lost" }),
      );

      authSuccessHandlers.at(-1)?.();
      expect(statusSink).toHaveBeenLastCalledWith(
        expect.objectContaining({ lifecycle: "ready", terminalDisconnect: undefined }),
      );
    });

    it("should reuse existing client for same account", async () => {
      const client1 = await manager.getClient(testAccount);
      const client2 = await manager.getClient(testAccount);

      expect(client1).toBe(client2);
      expect(mockConnect).toHaveBeenCalledTimes(1);
    });

    it("deduplicates concurrent client creation for the same account", async () => {
      mockConnect.mockImplementationOnce(() => {});

      const first = manager.getClient(testAccount);
      const second = manager.getClient(testAccount);
      await Promise.resolve();

      expect(mockConnect).toHaveBeenCalledTimes(1);
      expect(authSuccessHandlers).toHaveLength(1);
      authSuccessHandlers[0]?.();

      const [client1, client2] = await Promise.all([first, second]);
      expect(client1).toBe(client2);
    });

    it("waits through authentication failure retry disconnects", async () => {
      mockConnect.mockImplementationOnce(() => {});

      const connection = manager.getClient(testAccount);
      await Promise.resolve();
      authFailureHandlers[0]?.("bad token", 1);

      let settled = false;
      void connection.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        "Twitch authentication failed for testbot; waiting for retry, disconnect, or timeout: bad token",
      );

      disconnectHandlers[0]?.(false, new Error("disconnected"));
      await Promise.resolve();
      expect(settled).toBe(false);

      authSuccessHandlers[0]?.();
      await expect(connection).resolves.toBeTruthy();
    });

    it("rejects pending auth retry connections on manual disconnect", async () => {
      mockConnect.mockImplementationOnce(() => {});

      const connection = manager.getClient(testAccount);
      await Promise.resolve();
      authFailureHandlers[0]?.("bad token", 1);
      disconnectHandlers[0]?.(true);

      await expect(connection).rejects.toThrow("Twitch connection cancelled");
    });

    it("does not cache pending connections after disconnectAll", async () => {
      mockConnect.mockImplementationOnce(() => {});

      const connection = manager.getClient(testAccount);
      await Promise.resolve();

      await manager.disconnectAll();
      authSuccessHandlers[0]?.();

      await expect(connection).rejects.toThrow("Twitch connection cancelled");
      expect(mockQuit).toHaveBeenCalledTimes(2);
    });

    it.each(["account", "all"] as const)(
      "does not create a client when %s disconnect completes during authentication setup",
      async (scope) => {
        const authentication = createDeferred<string>();
        mockAddUserForToken.mockImplementationOnce(() => authentication.promise);
        const account = {
          ...testAccount,
          clientSecret: "test-client-secret",
          refreshToken: "test-refresh-token",
        };
        manager.onMessage(account, vi.fn());
        const connection = manager.getClient(account);

        expect(mockAddUserForToken).toHaveBeenCalledOnce();
        if (scope === "account") {
          await manager.disconnect(account);
        } else {
          await manager.disconnectAll();
        }
        authentication.resolve("123456");

        await expect(connection).rejects.toThrow("Twitch connection cancelled");
        expect(mockConnect).not.toHaveBeenCalled();
        expect(managerState(manager).clients.size).toBe(0);
        expect(managerState(manager).messageHandlers.has(manager.getAccountKey(account))).toBe(
          false,
        );
      },
    );

    it("keeps a restarted account connection when stale authentication resolves afterward", async () => {
      const authentication = createDeferred<string>();
      mockAddUserForToken.mockImplementationOnce(() => authentication.promise);
      const account = {
        ...testAccount,
        clientSecret: "test-client-secret",
        refreshToken: "test-refresh-token",
      };
      const staleConnection = manager.getClient(account);
      const staleOutcome = staleConnection.then(
        () => "connected" as const,
        () => "cancelled" as const,
      );

      await manager.disconnect(account);
      const currentConnection = manager.getClient(account);

      try {
        expect(mockAddUserForToken).toHaveBeenCalledTimes(2);
        const activeClient = await currentConnection;
        authentication.resolve("123456");

        expect(await staleOutcome).toBe("cancelled");
        expect(managerState(manager).clients.get(manager.getAccountKey(account))).toBe(
          activeClient,
        );
        expect(mockConnect).toHaveBeenCalledOnce();
      } finally {
        authentication.resolve("123456");
        await Promise.allSettled([staleConnection, currentConnection]);
      }
    });

    it("keeps another account connected when cancelling an authentication-pending account", async () => {
      const authentication = createDeferred<string>();
      mockAddUserForToken.mockImplementationOnce(() => authentication.promise);
      const account = {
        ...testAccount,
        clientSecret: "test-client-secret",
        refreshToken: "test-refresh-token",
      };
      const staleConnection = manager.getClient(account);
      const staleOutcome = staleConnection.then(
        () => "connected" as const,
        () => "cancelled" as const,
      );
      const activeClient = await manager.getClient(testAccount2);

      await manager.disconnect(account);
      authentication.resolve("123456");

      expect(await staleOutcome).toBe("cancelled");
      expect(managerState(manager).clients.get(manager.getAccountKey(testAccount2))).toBe(
        activeClient,
      );
      expect(mockConnect).toHaveBeenCalledOnce();
    });

    it("should normalize token by removing oauth: prefix", async () => {
      const accountWithPrefix: TwitchAccountConfig = {
        ...testAccount,
        accessToken: "oauth:actualtoken123",
      };

      resolveTwitchTokenMock.mockReturnValue({
        token: "oauth:actualtoken123",
        source: "config" as const,
      });

      await manager.getClient(accountWithPrefix);

      expect(mockAuthProvider.constructor).toHaveBeenCalledOnce();
      expect(mockAuthProvider.constructor).toHaveBeenCalledWith("test-client-id", "actualtoken123");
    });

    it("should use token directly when no oauth: prefix", async () => {
      // Override the mock to return a token without oauth: prefix
      resolveTwitchTokenMock.mockReturnValue({
        token: "raw-token-from-tests",
        source: "config" as const,
      });

      await manager.getClient(testAccount);

      expect(mockAuthProvider.constructor).toHaveBeenCalledOnce();
      expect(mockAuthProvider.constructor).toHaveBeenCalledWith(
        "test-client-id",
        "raw-token-from-tests",
      );
    });

    it("should register refreshing tokens for Twurple chat intent", async () => {
      await manager.getClient(refreshingAccount);

      expect(mockAddUserForToken).toHaveBeenCalledTimes(1);
      expect(mockAddUserForToken).toHaveBeenCalledWith(
        {
          accessToken: "mock-token-from-tests",
          refreshToken: "test-refresh-token",
          expiresIn: 3600,
          obtainmentTimestamp: 1_700_000_000_000,
        },
        ["chat"],
      );
      expect(mockAuthProvider.constructor).not.toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(
        "Using RefreshingAuthProvider for testbot (automatic token refresh enabled)",
      );
    });

    it("retries client creation after an earlier addUserForToken failure (83853)", async () => {
      mockAddUserForToken.mockRejectedValueOnce(new Error("token bind failed"));

      await expect(manager.getClient(refreshingAccount)).rejects.toThrow("token bind failed");
      // No broken client was cached, so a second call re-attempts the bind.
      await manager.getClient(refreshingAccount);

      expect(mockAddUserForToken).toHaveBeenCalledTimes(2);
    });

    it("should throw error when clientId is missing", async () => {
      const accountWithoutClientId: TwitchAccountConfig = {
        ...testAccount,
        clientId: "" as unknown as string,
      } as unknown as TwitchAccountConfig;

      await expect(manager.getClient(accountWithoutClientId)).rejects.toThrow(
        "Missing Twitch client ID",
      );

      expect(mockLogger.error).toHaveBeenCalledWith("Missing Twitch client ID for account testbot");
    });

    it.each([
      {
        name: "simplified default account",
        cfg: { channels: { twitch: { ...testAccount, accessToken: "" } } },
        accountId: undefined,
        expected:
          "Missing Twitch token for account default (set channels.twitch.accessToken or OPENCLAW_TWITCH_ACCESS_TOKEN for default)",
      },
      {
        name: "multi-account default",
        cfg: {
          channels: {
            twitch: { accounts: { default: { ...testAccount, accessToken: "" } } },
          },
        },
        accountId: "default",
        expected:
          "Missing Twitch token for account default (set channels.twitch.accounts.default.accessToken or OPENCLAW_TWITCH_ACCESS_TOKEN for default)",
      },
      {
        name: "named account",
        cfg: {
          channels: {
            twitch: { accounts: { "stream-team": { ...testAccount, accessToken: "" } } },
          },
        },
        accountId: "stream-team",
        expected:
          "Missing Twitch token for account stream-team (set channels.twitch.accounts.stream-team.accessToken or OPENCLAW_TWITCH_ACCESS_TOKEN for default)",
      },
    ] satisfies Array<{
      name: string;
      cfg: OpenClawConfig;
      accountId: string | undefined;
      expected: string;
    }>)(
      "throws actionable missing-token guidance for $name",
      async ({ cfg, accountId, expected }) => {
        resolveTwitchTokenMock.mockReturnValue({
          token: "",
          source: "none" as const,
        });

        await expect(manager.getClient(testAccount, cfg, accountId)).rejects.toThrow(expected);
      },
    );

    it("should create separate clients for same account with different channels", async () => {
      const account1: TwitchAccountConfig = {
        ...testAccount,
        channel: "channel1",
      };
      const account2: TwitchAccountConfig = {
        ...testAccount,
        channel: "channel2",
      };

      await manager.getClient(account1);
      await manager.getClient(account2);

      expect(mockConnect).toHaveBeenCalledTimes(2);
    });
  });

  describe("onMessage", () => {
    it("cleanup of an earlier handler does not remove a newer registered handler (#83888)", () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      const key = manager.getAccountKey(testAccount);

      const cleanup1 = manager.onMessage(testAccount, handler1);
      manager.onMessage(testAccount, handler2);

      // Running the first handler's cleanup must not drop handler2.
      cleanup1();

      expect(managerState(manager).messageHandlers.get(key)).toBe(handler2);
    });

    it("cleanup of an earlier registration does not remove a newer registration using the same handler", () => {
      const handler = vi.fn();
      const key = manager.getAccountKey(testAccount);

      const cleanup1 = manager.onMessage(testAccount, handler);
      manager.onMessage(testAccount, handler);
      cleanup1();

      expect(managerState(manager).messageHandlers.get(key)).toBe(handler);
    });

    it("cleanup of the current handler removes it", () => {
      const handler = vi.fn();
      const key = manager.getAccountKey(testAccount);

      const cleanup = manager.onMessage(testAccount, handler);
      cleanup();

      expect(managerState(manager).messageHandlers.has(key)).toBe(false);
    });
  });

  describe("disconnect", () => {
    it("should clear client and message handler", async () => {
      const handler = vi.fn();
      await manager.getClient(testAccount);
      manager.onMessage(testAccount, handler);

      await manager.disconnect(testAccount);

      const key = manager.getAccountKey(testAccount);
      expect(managerState(manager).clients.has(key)).toBe(false);
      expect(managerState(manager).messageHandlers.has(key)).toBe(false);
    });

    it("clears pending client message handlers when disconnect cancels connection", async () => {
      mockConnect.mockImplementationOnce(() => {});
      const handler = vi.fn();
      manager.onMessage(testAccount, handler);

      const connection = manager.getClient(testAccount);
      await Promise.resolve();
      await manager.disconnect(testAccount);

      const key = manager.getAccountKey(testAccount);
      expect(managerState(manager).messageHandlers.has(key)).toBe(false);
      authSuccessHandlers[0]?.();
      await expect(connection).rejects.toThrow("Twitch connection cancelled");

      messageHandlers[0]?.("#testchannel", "testuser", "stale", ircMessage("msg-stale"));

      expect(handler).not.toHaveBeenCalled();
    });

    it("should handle disconnecting non-existent client gracefully", async () => {
      // Missing clients are ignored.
      await manager.disconnect(testAccount);
      expect(mockQuit).not.toHaveBeenCalled();
    });

    it("should only disconnect specified account when multiple accounts exist", async () => {
      await manager.getClient(testAccount);
      await manager.getClient(testAccount2);

      await manager.disconnect(testAccount);

      expect(mockQuit).toHaveBeenCalledTimes(1);

      const key2 = manager.getAccountKey(testAccount2);
      expect(managerState(manager).clients.has(key2)).toBe(true);
    });
  });

  describe("disconnectAll", () => {
    it("should disconnect all connected clients", async () => {
      await manager.getClient(testAccount);
      await manager.getClient(testAccount2);

      await manager.disconnectAll();

      expect(mockQuit).toHaveBeenCalledTimes(2);
      expect(managerState(manager).clients.size).toBe(0);
      expect(managerState(manager).messageHandlers.size).toBe(0);
    });

    it("should handle empty client list gracefully", async () => {
      // Empty client sets are ignored.
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

      expect(result).toEqual({
        ok: true,
        messageId: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        ),
      });
      expect(mockSay).toHaveBeenCalledWith("testchannel", "Hello, world!");
    });

    it("should keep surrogate pairs intact when pre-chunking long messages", async () => {
      const prefix = "a".repeat(499);

      await manager.sendMessage(testAccount, "testchannel", `${prefix}😀b`);

      expect(mockSay.mock.calls).toEqual([
        ["testchannel", prefix],
        ["testchannel", "😀b"],
      ]);
    });

    it("should generate unique message ID for each message", async () => {
      const result1 = await manager.sendMessage(testAccount, "testchannel", "First message");
      const result2 = await manager.sendMessage(testAccount, "testchannel", "Second message");

      expect(result1.ok).toBe(true);
      expect(result2.ok).toBe(true);
      expect(result1).not.toEqual(result2);
    });

    it("should log and return a formatted send failure", async () => {
      mockSay.mockRejectedValueOnce(new Error("Rate limited"));

      await expect(
        manager.sendMessage(testAccount, "testchannel", "Test message"),
      ).resolves.toEqual({
        ok: false,
        error: "Rate limited",
      });
      expect(mockLogger.error).toHaveBeenCalledWith("Failed to send message: Rate limited");
    });

    it("should handle unknown error types", async () => {
      mockSay.mockRejectedValueOnce("String error");

      await expect(
        manager.sendMessage(testAccount, "testchannel", "Test message"),
      ).resolves.toEqual({
        ok: false,
        error: "String error",
      });
      expect(mockLogger.error).toHaveBeenCalledWith("Failed to send message: String error");
    });

    it("should create client if not already connected", async () => {
      // Clear the existing client
      managerState(manager).clients.clear();

      // Reset connect call count for this specific test
      const connectCallCountBefore = mockConnect.mock.calls.length;

      await manager.sendMessage(testAccount, "testchannel", "Test message");

      expect(mockConnect.mock.calls.length).toBeGreaterThan(connectCallCountBefore);
    });
  });

  describe("message handling integration", () => {
    let capturedMessage: TwitchChatMessage | null = null;

    beforeEach(() => {
      capturedMessage = null;

      manager.onMessage(testAccount, (message) => {
        capturedMessage = message;
      });
    });

    it("should handle incoming chat messages", async () => {
      await manager.getClient(testAccount);

      const onMessageCallback = expectDefined(messageHandlers[0], "Twitch message handler");

      onMessageCallback(
        "#testchannel",
        "testuser",
        "Hello bot!",
        ircMessage("msg123", { userId: "12345" }),
      );

      expect(capturedMessage?.username).toBe("testuser");
      expect(capturedMessage?.displayName).toBe("TestUser");
      expect(capturedMessage?.userId).toBe("12345");
      expect(capturedMessage?.message).toBe("Hello bot!");
      expect(capturedMessage?.channel).toBe("#testchannel");
      expect(capturedMessage?.chatType).toBe("group");
    });

    it("should preserve channel names without a # prefix", async () => {
      await manager.getClient(testAccount);

      const onMessageCallback = expectDefined(messageHandlers[0], "Twitch message handler");

      onMessageCallback("testchannel", "testuser", "Test", ircMessage("msg1"));

      expect(capturedMessage?.channel).toBe("testchannel");
    });

    it("should include user role flags in message", async () => {
      await manager.getClient(testAccount);

      const onMessageCallback = expectDefined(messageHandlers[0], "Twitch message handler");

      onMessageCallback(
        "#testchannel",
        "moduser",
        "Test",
        ircMessage("msg2", {
          userName: "moduser",
          displayName: "ModUser",
          userId: "456",
          isMod: true,
          isVip: true,
          isSubscriber: true,
        }),
      );

      expect(capturedMessage?.isMod).toBe(true);
      expect(capturedMessage?.isVip).toBe(true);
      expect(capturedMessage?.isSub).toBe(true);
      expect(capturedMessage?.isOwner).toBe(false);
    });

    it("should handle broadcaster messages", async () => {
      await manager.getClient(testAccount);

      const onMessageCallback = expectDefined(messageHandlers[0], "Twitch message handler");

      onMessageCallback(
        "#testchannel",
        "broadcaster",
        "Test",
        ircMessage("msg3", {
          userName: "broadcaster",
          displayName: "Broadcaster",
          userId: "789",
          isBroadcaster: true,
        }),
      );

      expect(capturedMessage?.isOwner).toBe(true);
    });
  });

  describe("edge cases", () => {
    it("should handle multiple message handlers for different accounts", async () => {
      const messages1: TwitchChatMessage[] = [];
      const messages2: TwitchChatMessage[] = [];

      manager.onMessage(testAccount, (msg) => messages1.push(msg));
      manager.onMessage(testAccount2, (msg) => messages2.push(msg));

      await manager.getClient(testAccount);
      await manager.getClient(testAccount2);

      const onMessage1 = messageHandlers[0];
      if (!onMessage1) {
        throw new Error("onMessage1 not found");
      }
      onMessage1(
        "#testchannel",
        "user1",
        "msg1",
        ircMessage("1", { userName: "user1", displayName: "User1", userId: "1" }),
      );

      const onMessage2 = messageHandlers[1];
      if (!onMessage2) {
        throw new Error("onMessage2 not found");
      }
      onMessage2(
        "#testchannel2",
        "user2",
        "msg2",
        ircMessage("2", { userName: "user2", displayName: "User2", userId: "2" }),
      );

      expect(messages1).toHaveLength(1);
      expect(messages2).toHaveLength(1);
      expect(messages1[0]?.message).toBe("msg1");
      expect(messages2[0]?.message).toBe("msg2");
    });
  });
});
