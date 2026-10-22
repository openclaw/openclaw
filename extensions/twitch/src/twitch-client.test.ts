import { expectDefined } from "@openclaw/normalization-core";
import { StaticAuthProvider, type AuthProvider } from "@twurple/auth";
import { LogLevel, type ChatClientOptions } from "@twurple/chat";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as fetchRuntime from "openclaw/plugin-sdk/fetch-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getClientManager,
  getOrCreateClientManager,
  removeClientManager,
} from "./client-manager-registry.js";
import { twitchOutbound } from "./outbound.js";
import { probeTwitch } from "./probe.js";
import { makeTwitchTestConfig } from "./test-fixtures.js";
import { resolveTwitchToken } from "./token.js";
import { TwitchClientManager } from "./twitch-client.js";
import type { ChannelAccountSnapshot, ChannelLogSink, TwitchAccountConfig } from "./types.js";

const mockConnect = vi.fn(() => {
  for (const handler of authSuccessHandlers) {
    handler();
  }
});
const mockSay = vi.fn().mockResolvedValue(undefined);
const mockQuit = vi.fn();
const mockUnbind = vi.fn();
const mockChatClientConstructor = vi.fn<(options: ChatClientOptions) => void>();

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

function registerHandler<T>(handlers: T[]) {
  return vi.fn((handler: T) => {
    handlers.push(handler);
    return { unbind: mockUnbind };
  });
}

const mockManagedAuthProvider = vi.fn<(...args: unknown[]) => Promise<AuthProvider>>(
  async () => new StaticAuthProvider("test-client-id", "synthetic-managed"),
);

vi.mock("./oauth-owner.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./oauth-owner.js")>()),
  createManagedTwitchAuthProvider: (...args: unknown[]) => mockManagedAuthProvider(...args),
}));

vi.mock("@twurple/chat", () => ({
  ChatClient: class {
    constructor(options: ChatClientOptions) {
      mockChatClientConstructor(options);
    }
    onMessage = registerHandler(messageHandlers);
    onAuthenticationSuccess = registerHandler(authSuccessHandlers);
    onAuthenticationFailure = registerHandler(authFailureHandlers);
    onDisconnect = registerHandler(disconnectHandlers);
    connect = mockConnect;
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

const mockAuthProvider = { constructor: vi.fn() };

vi.mock("@twurple/auth", () => ({
  StaticAuthProvider: function MockStaticAuthProvider(...args: unknown[]) {
    mockAuthProvider.constructor(...args);
  },
}));

vi.mock("./token.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./token.js")>()),
  resolveTwitchToken: vi.fn(() => ({
    token: "oauth:mock-token-from-tests",
  })),
}));

describe("TwitchClientManager", () => {
  let manager: TwitchClientManager;
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } satisfies ChannelLogSink;
  const statusSink = vi.fn<(patch: Omit<ChannelAccountSnapshot, "accountId">) => void>();
  const resolveTwitchTokenMock = vi.mocked(resolveTwitchToken);

  const testAccount: TwitchAccountConfig = {
    username: "testbot",
    accessToken: "test123456",
    clientId: "test-client-id",
    channel: "testchannel",
    enabled: true,
  };

  const testAccount2 = {
    ...testAccount,
    username: "testbot2",
    clientId: "test-client-id-2",
    channel: "testchannel2",
  };

  const authAccount: TwitchAccountConfig = {
    ...testAccount,
    clientSecret: "test-client-secret",
    refreshToken: "test-refresh-token",
  };
  const refreshingAccount: TwitchAccountConfig = {
    ...authAccount,
    expiresIn: 3600,
    obtainmentTimestamp: 1_700_000_000_000,
  };

  function send(text = "Test message") {
    return manager.sendMessage(testAccount, "testchannel", text);
  }
  function emit(
    index: number,
    text: string,
    id = text,
    userInfo: Partial<typeof defaultUserInfo> = {},
  ) {
    expectDefined(messageHandlers[index], "message handler")(
      "#testchannel",
      "testuser",
      text,
      ircMessage(id, userInfo),
    );
  }
  function expectStatus(patch: Partial<ChannelAccountSnapshot>) {
    expect(statusSink).toHaveBeenLastCalledWith(expect.objectContaining(patch));
  }

  function pendingAuthentication() {
    const authentication = createDeferred<AuthProvider>();
    mockManagedAuthProvider.mockImplementationOnce(() => authentication.promise);
    return { authentication, connection: manager.getClient(authAccount) };
  }

  async function pendingConnection() {
    mockConnect.mockImplementationOnce(() => {});
    const connection = manager.getClient(testAccount);
    await Promise.resolve();
    return { connection };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    messageHandlers.length = 0;
    authSuccessHandlers.length = 0;
    authFailureHandlers.length = 0;
    disconnectHandlers.length = 0;
    resolveTwitchTokenMock.mockReturnValue({
      token: "oauth:mock-token-from-tests",
    });
    manager = new TwitchClientManager(mockLogger, statusSink);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("omits incoming IRC content from parse failures while forwarding other diagnostics", async () => {
    await manager.getClient(testAccount);
    const options = mockChatClientConstructor.mock.calls[0]?.[0];
    const custom = expectDefined(options?.logger?.custom, "Twurple logger bridge");
    const log = typeof custom === "function" ? custom : custom.log;
    vi.clearAllMocks();
    const parseErrors = [
      "Error parsing message: line without command received: :synthetic-private-irc-line",
      'Error parsing message: required parameter "channel" did not validate against channel validation: "synthetic-private-irc-parameter"',
    ];
    for (const error of parseErrors) {
      log(LogLevel.ERROR, error);
    }
    const diagnostics = [
      [LogLevel.CRITICAL, "error", "connection failed"],
      [LogLevel.ERROR, "error", "Refreshing the access token failed: refresh rejected"],
      [LogLevel.WARNING, "warn", "No valid token available; trying to refresh"],
      [LogLevel.INFO, "info", "Disconnected"],
      [LogLevel.DEBUG, "debug", "diagnostic"],
      [LogLevel.TRACE, "debug", "trace diagnostic"],
    ] as const;
    for (const [level, , message] of diagnostics) {
      log(level, message);
    }
    for (const method of ["error", "warn", "info", "debug"] as const) {
      expect(mockLogger[method].mock.calls).toEqual([
        ...(method === "error" ? parseErrors.map(() => ["Twitch IRC message parsing failed"]) : []),
        ...diagnostics.filter(([, sink]) => sink === method).map((entry) => [entry[2]]),
      ]);
    }
  });

  it("publishes ready and recovering from authentication and disconnect events", async () => {
    await manager.getClient(testAccount);
    expectStatus({ lifecycle: "ready", connected: true });
    authFailureHandlers.at(-1)?.("retrying auth", 1);
    expectStatus({ lifecycle: "recovering", lastError: "retrying auth" });
    disconnectHandlers.at(-1)?.(false, new Error("connection lost"));
    expectStatus({ lifecycle: "recovering", lastError: "connection lost" });
    authSuccessHandlers.at(-1)?.();
    expectStatus({ lifecycle: "ready", terminalDisconnect: undefined });
  });

  it("deduplicates concurrent client creation for the same account", async () => {
    const { connection: first } = await pendingConnection();
    const second = manager.getClient(testAccount);
    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(authSuccessHandlers).toHaveLength(1);
    authSuccessHandlers[0]?.();
    const [client1, client2] = await Promise.all([first, second]);
    expect(client1).toBe(client2);
  });

  it("waits through authentication failure retry disconnects", async () => {
    const { connection } = await pendingConnection();
    authFailureHandlers[0]?.("bad token", 1);
    let settled = false;
    const settle = () => {
      settled = true;
    };
    void connection.then(settle, settle);
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

  it.each(["manual", "all"] as const)(
    "cancels pending connections on %s disconnect",
    async (mode) => {
      const { connection } = await pendingConnection();
      if (mode === "manual") {
        authFailureHandlers[0]?.("bad token", 1);
        disconnectHandlers[0]?.(true);
      } else {
        await manager.disconnectAll();
        authSuccessHandlers[0]?.();
      }
      await expect(connection).rejects.toThrow("Twitch connection cancelled");
      if (mode === "all") {
        expect(mockQuit).toHaveBeenCalledTimes(2);
      }
    },
  );

  it("does not create a client when disconnect completes during authentication setup", async () => {
    const { authentication, connection } = pendingAuthentication();
    expect(mockManagedAuthProvider).toHaveBeenCalledOnce();
    await manager.disconnectAll();
    authentication.resolve(new StaticAuthProvider("test-client-id", "synthetic-managed"));
    await expect(connection).rejects.toThrow("Twitch connection cancelled");
    expect(mockConnect).not.toHaveBeenCalled();
  });

  it.each(["same", "other"] as const)(
    "keeps the %s account connected when stale authentication resolves",
    async (accountScope) => {
      const { authentication, connection: staleConnection } = pendingAuthentication();
      const staleOutcome = staleConnection.then(
        () => "connected",
        () => "cancelled",
      );
      const same = accountScope === "same";
      const activeManager = same ? manager : new TwitchClientManager(mockLogger);
      const activeAccount = same ? authAccount : testAccount2;
      if (same) {
        await manager.disconnectAll();
      }
      const currentConnection = activeManager.getClient(activeAccount);
      try {
        if (same) {
          expect(mockManagedAuthProvider).toHaveBeenCalledTimes(2);
        }
        const activeClient = await currentConnection;
        if (!same) {
          await manager.disconnectAll();
        }
        authentication.resolve(new StaticAuthProvider("test-client-id", "synthetic-managed"));
        expect(await staleOutcome).toBe("cancelled");
        expect(await activeManager.getClient(activeAccount)).toBe(activeClient);
        expect(mockConnect).toHaveBeenCalledOnce();
      } finally {
        authentication.resolve(new StaticAuthProvider("test-client-id", "synthetic-managed"));
        await Promise.allSettled([staleConnection, currentConnection]);
      }
    },
  );

  it("should use token directly when no oauth: prefix", async () => {
    resolveTwitchTokenMock.mockReturnValue({
      token: "raw-token-from-tests",
    });
    await manager.getClient(testAccount);
    expect(mockAuthProvider.constructor).toHaveBeenCalledExactlyOnceWith(
      "test-client-id",
      "raw-token-from-tests",
    );
  });

  it("retries client creation after an earlier auth setup failure (83853)", async () => {
    mockManagedAuthProvider.mockRejectedValueOnce(new Error("token bind failed"));
    await expect(manager.getClient(refreshingAccount)).rejects.toThrow("token bind failed");
    await manager.getClient(refreshingAccount);
    expect(mockManagedAuthProvider).toHaveBeenCalledTimes(2);
  });

  it("should throw error when clientId is missing", async () => {
    await expect(manager.getClient({ ...testAccount, clientId: "" })).rejects.toThrow(
      "Missing Twitch client ID for account testbot",
    );
  });

  it.each([
    [undefined, "channels.twitch.accessToken"],
    ["stream-team", "channels.twitch.accounts.stream-team.accessToken"],
  ] as const)("reports missing-token config path for %s", async (accountId, path) => {
    const emptyAccount = { ...testAccount, accessToken: "" };
    const cfg: OpenClawConfig = {
      channels: {
        twitch: accountId ? { accounts: { [accountId]: emptyAccount } } : emptyAccount,
      },
    };
    resolveTwitchTokenMock.mockReturnValue({ token: "" });
    await expect(manager.getClient(testAccount, cfg, accountId)).rejects.toThrow(
      `Missing Twitch token for account ${accountId ?? "default"} (set ${path} or OPENCLAW_TWITCH_ACCESS_TOKEN for default)`,
    );
  });

  it("keeps the current registration after stale cleanup reuses the same handler", async () => {
    await manager.getClient(testAccount);
    const current = vi.fn();
    const cleanup = manager.onMessage(current);
    manager.onMessage(current);
    cleanup();
    emit(0, "hello", "msg-current");
    expect(current.mock.calls).toEqual([
      [expect.objectContaining({ id: "msg-current", isOwner: false })],
    ]);
  });

  it.each(["handler", "disconnect"] as const)("%s cleanup stops delivery", async (cleanupKind) => {
    await manager.getClient(testAccount);
    const handler = vi.fn();
    const cleanup = manager.onMessage(handler);
    if (cleanupKind === "handler") {
      cleanup();
    } else {
      await manager.disconnectAll();
      expect(mockQuit).toHaveBeenCalledOnce();
    }
    emit(0, "stale", "msg-removed");
    expect(handler).not.toHaveBeenCalled();
  });

  describe("sendMessage", () => {
    beforeEach(async () => {
      await manager.getClient(testAccount);
    });

    it("admits every chunk before handing the complete batch to Twurple", async () => {
      const preparing = createDeferred<void>();
      const prepared = createDeferred<void>();
      const handedOff = createDeferred<void>();
      const acknowledgment = createDeferred<void>();
      const authority = fetchRuntime.captureEffectAuthority();
      vi.spyOn(fetchRuntime, "captureEffectAuthority").mockReturnValue({
        ...authority,
        async initiate(effect) {
          preparing.resolve();
          await prepared.promise;
          const result = authority.initiate(effect);
          handedOff.resolve();
          return result;
        },
      });
      mockSay.mockReturnValue(acknowledgment.promise);
      const sending = send("a".repeat(501));
      try {
        await preparing.promise;
        expect(mockSay).not.toHaveBeenCalled();
        prepared.resolve();
        await handedOff.promise;
        expect(mockSay.mock.calls).toEqual([
          ["testchannel", "a".repeat(500)],
          ["testchannel", "a"],
        ]);
        acknowledgment.resolve();
        await expect(sending).resolves.toMatchObject({ ok: true });
      } finally {
        prepared.resolve();
        acknowledgment.resolve();
        await sending.catch(() => {});
      }
    });

    it("preserves preparation refusal without sending any chunk", async () => {
      const authority = fetchRuntime.captureEffectAuthority();
      const refusal = new Error("Twitch message authority ended");
      vi.spyOn(fetchRuntime, "captureEffectAuthority").mockReturnValue({
        ...authority,
        initiate: async () => {
          throw refusal;
        },
      });
      await expect(send("a".repeat(501))).rejects.toBe(refusal);
      expect(mockSay).not.toHaveBeenCalled();
    });

    it("reports accepted chunks when a later transport send fails", async () => {
      const failure = new Error("connection lost");
      mockSay.mockResolvedValueOnce(undefined).mockRejectedValueOnce(failure);
      await expect(send("a".repeat(501))).rejects.toMatchObject({
        code: "CHANNEL_PARTIAL_DELIVERY",
        cause: failure,
        deliveryResult: { visibleReplySent: true, messageIds: [expect.any(String)] },
      });
      expect(mockSay).toHaveBeenCalledTimes(2);
    });

    it("should keep surrogate pairs intact when pre-chunking long messages", async () => {
      const prefix = "a".repeat(499);
      await send(`${prefix}😀b`);
      expect(mockSay.mock.calls).toEqual([
        ["testchannel", prefix],
        ["testchannel", "😀b"],
      ]);
    });

    it("should return a formatted send failure", async () => {
      mockSay.mockRejectedValueOnce(new Error("Rate limited"));
      await expect(send()).resolves.toEqual({ ok: false, error: "Rate limited" });
    });

    it("should create client if not already connected", async () => {
      await manager.disconnectAll();
      const connectCallCountBefore = mockConnect.mock.calls.length;
      await send();
      expect(mockConnect.mock.calls.length).toBeGreaterThan(connectCallCountBefore);
    });
  });

  it("preserves message content and role flags without logging content", async () => {
    const onMessage = vi.fn();
    manager.onMessage(onMessage);
    await manager.getClient(testAccount);
    const messageText = "private-twitch-message\n🦞";
    emit(0, messageText, "msg2", {
      isMod: true,
      isVip: true,
      isSubscriber: true,
      isBroadcaster: true,
    });
    expect(onMessage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        isMod: true,
        isVip: true,
        isSub: true,
        isOwner: true,
        message: messageText,
        channel: "#testchannel",
      }),
    );
    expect(mockLogger.debug.mock.calls.flat().join("\n")).not.toContain("private-twitch-message");
  });

  it("should handle multiple message handlers for different accounts", async () => {
    const messages1 = vi.fn();
    const messages2 = vi.fn();
    const otherManager = new TwitchClientManager(mockLogger);
    manager.onMessage(messages1);
    otherManager.onMessage(messages2);
    await manager.getClient(testAccount);
    await otherManager.getClient(testAccount2);
    emit(0, "msg1");
    emit(1, "msg2");
    expect(messages1).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: "msg1" }));
    expect(messages2).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: "msg2" }));
  });

  describe("probeTwitch", () => {
    it("returns error when username is missing", async () => {
      expect(await probeTwitch({ ...testAccount, username: "" }, 5000)).toMatchObject({
        ok: false,
        error: expect.stringContaining("missing credentials"),
      });
    });

    it("times out when connection takes too long", async () => {
      vi.useFakeTimers();
      mockConnect.mockImplementationOnce(() => {});
      const result = probeTwitch(testAccount, 100);
      await vi.advanceTimersByTimeAsync(100);
      expect(await result).toMatchObject({ ok: false, error: "timeout after 100ms" });
      expect(mockQuit).toHaveBeenCalledOnce();
    });

    it.each(["authentication", "disconnect"] as const)("reports %s failure", async (kind) => {
      mockConnect.mockImplementationOnce(() => {
        if (kind === "authentication") {
          authFailureHandlers[0]?.("", 0);
        } else {
          disconnectHandlers[0]?.(false, "String error" as unknown as Error);
        }
      });
      expect(await probeTwitch(testAccount, 5000)).toMatchObject({
        ok: false,
        error: kind === "authentication" ? "Authentication failed" : "String error",
      });
      expect(mockQuit).toHaveBeenCalledOnce();
    });

    it("trims whitespace before removing the token prefix", async () => {
      expect(
        await probeTwitch({ ...testAccount, accessToken: "  oauth:test123456789  " }, 5000),
      ).toMatchObject({
        ok: true,
        connected: true,
        username: "testbot",
        channel: "testchannel",
      });
      expect(mockAuthProvider.constructor).toHaveBeenCalledExactlyOnceWith(
        "test-client-id",
        "test123456789",
      );
    });
  });

  describe("client manager registry", () => {
    const cfg = makeTwitchTestConfig(testAccount);
    async function retireManager() {
      const owner = getOrCreateClientManager("default", mockLogger);
      await owner.getClient(testAccount, cfg, "default");
      owner.onMessage(vi.fn());
      const cleanup = createDeferred<void>();
      const disconnect = owner.disconnectAll.bind(owner);
      const disconnectSpy = vi.spyOn(owner, "disconnectAll").mockImplementation(async () => {
        await disconnect();
        await cleanup.promise;
      });
      return { owner, cleanup, disconnectSpy, removal: removeClientManager("default") };
    }
    let retired: Awaited<ReturnType<typeof retireManager>>;
    beforeEach(async () => {
      retired = await retireManager();
    });
    afterEach(async () => {
      retired.cleanup.resolve();
      await retired.removal.catch(() => undefined);
      await removeClientManager("default");
    });

    it.each(["resolves", "rejects"] as const)(
      "retires immediately and preserves replacements when cleanup %s",
      async (outcome) => {
        const { owner, cleanup, removal, disconnectSpy } = retired;
        expect(disconnectSpy).toHaveBeenCalledOnce();
        expect(mockQuit).toHaveBeenCalledOnce();
        expect(getClientManager("default")).toBeUndefined();
        const replacement = getOrCreateClientManager("default", mockLogger);
        expect(replacement).not.toBe(owner);
        if (outcome === "rejects") {
          const error = new Error("disconnect failed");
          const rejected = expect(removal).rejects.toBe(error);
          cleanup.reject(error);
          await rejected;
        } else {
          cleanup.resolve();
          await expect(removal).resolves.toBeUndefined();
        }
        expect(getClientManager("default")).toBe(replacement);
      },
    );

    it("keeps outbound delivery off a retired manager and sends through its replacement", async () => {
      const { owner, cleanup, removal } = retired;
      const reconnect = vi.spyOn(owner, "getClient");
      const sendText = (text: string) =>
        twitchOutbound.sendText!({ to: "#testchannel", text, cfg, accountId: "default" });
      await expect(sendText("while retiring")).rejects.toThrow(
        "Client manager not found for account: default. Please start the Twitch gateway first.",
      );
      expect(reconnect).not.toHaveBeenCalled();
      expect(mockSay).not.toHaveBeenCalled();
      const replacement = getOrCreateClientManager("default", mockLogger);
      await replacement.getClient(testAccount, cfg, "default");
      replacement.onMessage(vi.fn());
      const result = await sendText("after restart");
      expect(result.messageId).toEqual(expect.any(String));
      expect(result.receipt?.platformMessageIds).toEqual([result.messageId]);
      expect(mockSay).toHaveBeenCalledWith("testchannel", "after restart");
      cleanup.resolve();
      await expect(removal).resolves.toBeUndefined();
      expect(getClientManager("default")).toBe(replacement);
    });
  });
});
