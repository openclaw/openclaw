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
import { twitchPlugin } from "./plugin.js";
import { makeTwitchChannelTestConfig, makeTwitchTestConfig } from "./test-fixtures.js";
import { resolveTwitchToken } from "./token.js";
import { TwitchClientManager } from "./twitch-client.js";
import type { ChannelAccountSnapshot, TwitchAccountConfig } from "./types.js";

function probeTwitch(probeAccount: TwitchAccountConfig, timeoutMs: number) {
  return twitchPlugin.status!.probeAccount!({
    account: { ...probeAccount, accountId: "default" },
    timeoutMs,
    cfg: {},
  });
}

const connect = vi.fn(() => {
  for (const handler of readyHandlers) {
    handler();
  }
});
const say = vi.fn().mockResolvedValue(undefined);
const quit = vi.fn();
const unbind = vi.fn();
const clientOptions = vi.fn<(options: ChatClientOptions) => void>();

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

const messages: Array<
  (channel: string, user: string, message: string, msg: ReturnType<typeof ircMessage>) => void
> = [];
const readyHandlers: Array<() => void> = [];
const failureHandlers: Array<(text: string, retryCount: number) => void> = [];
const disconnects: Array<(manual: boolean, reason?: Error) => void> = [];

function registerHandler<T>(handlers: T[]) {
  return vi.fn((handler: T) => {
    handlers.push(handler);
    return { unbind };
  });
}

const managedAuth = vi.fn<(...args: unknown[]) => Promise<AuthProvider>>(
  async () => new StaticAuthProvider("cid", "synthetic-managed"),
);

vi.mock("./oauth-owner.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./oauth-owner.js")>()),
  createManagedTwitchAuthProvider: (...args: unknown[]) => managedAuth(...args),
}));

vi.mock("@twurple/chat", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@twurple/chat")>()),
  ChatClient: class {
    constructor(options: ChatClientOptions) {
      clientOptions(options);
    }
    onMessage = registerHandler(messages);
    onAuthenticationSuccess = registerHandler(readyHandlers);
    onAuthenticationFailure = registerHandler(failureHandlers);
    onDisconnect = registerHandler(disconnects);
    connect = connect;
    say = say;
    quit = quit;
  },
}));

const staticAuth = { constructor: vi.fn() };

vi.mock("@twurple/auth", () => ({
  StaticAuthProvider: function MockStaticAuthProvider(...args: unknown[]) {
    staticAuth.constructor(...args);
  },
}));

vi.mock("./token.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./token.js")>()),
  resolveTwitchToken: vi.fn(() => ({ token: "oauth:mock-token-from-tests" })),
}));

describe("TwitchClientManager", () => {
  let manager: TwitchClientManager;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const statusSink = vi.fn<(patch: Omit<ChannelAccountSnapshot, "accountId">) => void>();
  const token = vi.mocked(resolveTwitchToken);

  const account: TwitchAccountConfig = {
    username: "bot",
    accessToken: "test123456",
    clientId: "cid",
    channel: "room",
    enabled: true,
  };

  const otherAccount = { ...account, username: "bot2", clientId: "client2", channel: "channel2" };
  const authAccount: TwitchAccountConfig = {
    ...account,
    clientSecret: "secret",
    refreshToken: "refresh",
  };

  function send(text = "Test message") {
    return manager.sendMessage(account, "room", text);
  }
  function emit(
    index: number,
    text: string,
    id = text,
    userInfo: Partial<typeof defaultUserInfo> = {},
  ) {
    expectDefined(messages[index], "message handler")(
      "#room",
      "testuser",
      text,
      ircMessage(id, userInfo),
    );
  }
  function expectStatus(patch: Partial<ChannelAccountSnapshot>) {
    expect(statusSink).toHaveBeenLastCalledWith(expect.objectContaining(patch));
  }

  function authenticating() {
    const authentication = createDeferred<AuthProvider>();
    managedAuth.mockImplementationOnce(() => authentication.promise);
    return { authentication, connection: manager.getClient(authAccount) };
  }

  async function connecting() {
    connect.mockImplementationOnce(() => {});
    const connection = manager.getClient(account);
    await Promise.resolve();
    return { connection };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    messages.length = 0;
    readyHandlers.length = 0;
    failureHandlers.length = 0;
    disconnects.length = 0;
    token.mockReturnValue({ token: "oauth:mock-token-from-tests" });
    manager = new TwitchClientManager(logger, statusSink);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  it("routes diagnostics without exposing private IRC parse content", async () => {
    await manager.getClient(account);
    const options = clientOptions.mock.calls[0]?.[0];
    const custom = expectDefined(options?.logger?.custom, "Twurple logger bridge");
    const log = typeof custom === "function" ? custom : custom.log;
    vi.clearAllMocks();
    for (const [level, sink] of [
      [LogLevel.CRITICAL, "error"],
      [LogLevel.ERROR, "error"],
      [LogLevel.WARNING, "warn"],
      [LogLevel.INFO, "info"],
      [LogLevel.DEBUG, "debug"],
      [LogLevel.TRACE, "debug"],
    ] as const) {
      log(level, "diagnostic");
      expect(logger[sink]).toHaveBeenLastCalledWith("diagnostic");
    }
    log(LogLevel.ERROR, "Error parsing message: synthetic-private-line");
    expect(logger.error).toHaveBeenLastCalledWith("Twitch IRC message parsing failed");
    expect(
      Object.values(logger)
        .flatMap((sink) => sink.mock.calls)
        .flat(),
    ).not.toContain("Error parsing message: synthetic-private-line");
  });
  it("publishes ready and recovering from authentication and disconnect events", async () => {
    await manager.getClient(account);
    expectStatus({ lifecycle: "ready", connected: true });
    failureHandlers.at(-1)?.("retrying auth", 1);
    expectStatus({ lifecycle: "recovering", lastError: "retrying auth" });
    disconnects.at(-1)?.(false, new Error("connection lost"));
    expectStatus({ lifecycle: "recovering", lastError: "connection lost" });
    readyHandlers.at(-1)?.();
    expectStatus({ lifecycle: "ready", terminalDisconnect: undefined });
  });
  it("deduplicates concurrent client creation for the same account", async () => {
    const { connection: first } = await connecting();
    const second = manager.getClient(account);
    expect(connect).toHaveBeenCalledTimes(1);
    readyHandlers[0]?.();
    const [client1, client2] = await Promise.all([first, second]);
    expect(client1).toBe(client2);
  });
  it("waits through authentication failure retry disconnects", async () => {
    const { connection } = await connecting();
    failureHandlers[0]?.("bad token", 1);
    const settled = vi.fn();
    void connection.then(settled, settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    disconnects[0]?.(false, new Error("disconnected"));
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    readyHandlers[0]?.();
    await expect(connection).resolves.toBeTruthy();
  });
  it.each(["manual", "all"] as const)(
    "cancels pending connections on %s disconnect",
    async (mode) => {
      const { connection } = await connecting();
      if (mode === "manual") {
        failureHandlers[0]?.("bad token", 1);
        disconnects[0]?.(true);
      } else {
        await manager.disconnectAll();
        readyHandlers[0]?.();
      }
      await expect(connection).rejects.toThrow("Twitch connection cancelled");
    },
  );
  it.each(["same", "other"] as const)(
    "keeps the %s account connected when stale authentication resolves",
    async (accountScope) => {
      const { authentication, connection: staleConnection } = authenticating();
      const staleOutcome = staleConnection.then(
        () => "connected",
        () => "cancelled",
      );
      const same = accountScope === "same";
      const activeManager = same ? manager : new TwitchClientManager(logger);
      const activeAccount = same ? authAccount : otherAccount;
      if (same) {
        await manager.disconnectAll();
      }
      const currentConnection = activeManager.getClient(activeAccount);
      try {
        const activeClient = await currentConnection;
        if (!same) {
          await manager.disconnectAll();
        }
        authentication.resolve(new StaticAuthProvider("cid", "synthetic-managed"));
        expect(await staleOutcome).toBe("cancelled");
        expect(await activeManager.getClient(activeAccount)).toBe(activeClient);
        expect(connect).toHaveBeenCalledOnce();
      } finally {
        authentication.resolve(new StaticAuthProvider("cid", "synthetic-managed"));
        await Promise.allSettled([staleConnection, currentConnection]);
      }
    },
  );
  it("retries client creation after an earlier auth setup failure (83853)", async () => {
    const refreshingAccount = {
      ...authAccount,
      expiresIn: 3600,
      obtainmentTimestamp: 1_700_000_000_000,
    };
    managedAuth.mockRejectedValueOnce(new Error("token bind failed"));
    await expect(manager.getClient(refreshingAccount)).rejects.toThrow("token bind failed");
    await manager.getClient(refreshingAccount);
    expect(managedAuth).toHaveBeenCalledTimes(2);
  });
  it("should throw error when clientId is missing", async () => {
    await expect(manager.getClient({ ...account, clientId: "" })).rejects.toThrow(
      "Missing Twitch client ID for account bot",
    );
  });
  it.each([
    [undefined, "channels.twitch.accessToken"],
    ["stream-team", "channels.twitch.accounts.stream-team.accessToken"],
  ] as const)("reports missing-token config path for %s", async (accountId, path) => {
    const emptyAccount = { ...account, accessToken: "" };
    const cfg: OpenClawConfig = makeTwitchChannelTestConfig(
      accountId ? { accounts: { [accountId]: emptyAccount } } : emptyAccount,
    );
    token.mockReturnValue({ token: "" });
    await expect(manager.getClient(account, cfg, accountId)).rejects.toThrow(
      `Missing Twitch token for account ${accountId ?? "default"} (set ${path} or OPENCLAW_TWITCH_ACCESS_TOKEN for default)`,
    );
  });
  it.each(["handler", "disconnect"] as const)("%s cleanup stops delivery", async (cleanupKind) => {
    await manager.getClient(account);
    const handler = vi.fn();
    const cleanup = manager.onMessage(handler);
    if (cleanupKind === "handler") {
      cleanup();
    } else {
      await manager.disconnectAll();
      expect(quit).toHaveBeenCalledOnce();
    }
    emit(0, "stale", "msg-removed");
    expect(handler).not.toHaveBeenCalled();
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
    say.mockReturnValue(acknowledgment.promise);
    const sending = send("a".repeat(501));
    try {
      await preparing.promise;
      expect(say).not.toHaveBeenCalled();
      prepared.resolve();
      await handedOff.promise;
      expect(say.mock.calls).toEqual([
        ["room", "a".repeat(500)],
        ["room", "a"],
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
    expect(say).not.toHaveBeenCalled();
  });
  it("reports accepted chunks when a later transport send fails", async () => {
    const failure = new Error("connection lost");
    say.mockResolvedValueOnce(undefined).mockRejectedValueOnce(failure);
    await expect(send("a".repeat(501))).rejects.toMatchObject({
      code: "CHANNEL_PARTIAL_DELIVERY",
      cause: failure,
      deliveryResult: { visibleReplySent: true, messageIds: [expect.any(String)] },
    });
    expect(say).toHaveBeenCalledTimes(2);
  });
  it("should keep surrogate pairs intact when pre-chunking long messages", async () => {
    const prefix = "a".repeat(499);
    await send(`${prefix}😀b`);
    expect(say.mock.calls).toEqual([
      ["room", prefix],
      ["room", "😀b"],
    ]);
  });
  it("should return a formatted send failure", async () => {
    await manager.disconnectAll();
    say.mockRejectedValueOnce(new Error("Rate limited"));
    await expect(send()).resolves.toEqual({ ok: false, error: "Rate limited" });
  });
  it("delivers the current registration with role flags without logging content", async () => {
    const onMessage = vi.fn();
    const oldCleanup = manager.onMessage(onMessage);
    manager.onMessage(onMessage);
    oldCleanup();
    await manager.getClient(account);
    const messageText = "private-twitch-message\n🦞";
    emit(0, messageText, "msg2", {
      isMod: true,
      isVip: true,
      isSubscriber: true,
      isBroadcaster: true,
    });
    expect(onMessage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        id: "msg2",
        isMod: true,
        isVip: true,
        isSub: true,
        isOwner: true,
        message: messageText,
        channel: "#room",
      }),
    );
    expect(logger.debug.mock.calls.flat().join("\n")).not.toContain("private-twitch-message");
  });
  it("should handle multiple message handlers for different accounts", async () => {
    const messages1 = vi.fn();
    const messages2 = vi.fn();
    const otherManager = new TwitchClientManager(logger);
    manager.onMessage(messages1);
    otherManager.onMessage(messages2);
    await manager.getClient(account);
    await otherManager.getClient(otherAccount);
    emit(0, "msg1");
    emit(1, "msg2");
    expect(messages1).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ message: "msg1", isOwner: false }),
    );
    expect(messages2).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: "msg2" }));
  });
  it.each([
    ["missing", expect.stringContaining("missing credentials")],
    ["timeout", "timeout after 100ms"],
    ["authentication", "Authentication failed"],
    ["disconnect", "String error"],
    ["success", undefined],
  ] as const)("probe reports %s and cleans up its connection", async (kind, error) => {
    if (kind === "timeout") {
      vi.useFakeTimers();
      connect.mockImplementationOnce(() => {});
    } else if (kind === "authentication" || kind === "disconnect") {
      connect.mockImplementationOnce(() =>
        kind === "authentication"
          ? failureHandlers[0]?.("", 0)
          : disconnects[0]?.(false, "String error" as unknown as Error),
      );
    }
    const probeAccount = { ...account, accessToken: "  oauth:test123456789  " };
    if (kind === "missing") {
      probeAccount.username = "";
    }
    const result = probeTwitch(probeAccount, 100);
    if (kind === "timeout") {
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(await result).toMatchObject(
      error === undefined
        ? { ok: true, connected: true, username: "bot", channel: "room" }
        : { ok: false, error },
    );
    if (kind !== "missing") {
      expect(quit).toHaveBeenCalledOnce();
    }
    if (kind === "success") {
      expect(staticAuth.constructor).toHaveBeenCalledExactlyOnceWith("cid", "test123456789");
    }
  });

  describe("client manager registry", () => {
    const cfg = makeTwitchTestConfig(account);
    async function retireManager() {
      const owner = getOrCreateClientManager("default", logger);
      await owner.getClient(account, cfg, "default");
      owner.onMessage(vi.fn());
      const cleanup = createDeferred<void>();
      const disconnect = owner.disconnectAll.bind(owner);
      vi.spyOn(owner, "disconnectAll").mockImplementation(async () => {
        await disconnect();
        await cleanup.promise;
      });
      return { owner, cleanup, removal: removeClientManager("default") };
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
    it("retires immediately and preserves replacements when cleanup rejects", async () => {
      const { owner, cleanup, removal } = retired;
      expect(quit).toHaveBeenCalledOnce();
      expect(getClientManager("default")).toBeUndefined();
      const replacement = getOrCreateClientManager("default", logger);
      expect(replacement).not.toBe(owner);
      const error = new Error("disconnect failed");
      const rejected = expect(removal).rejects.toBe(error);
      cleanup.reject(error);
      await rejected;
      expect(getClientManager("default")).toBe(replacement);
    });
    it("keeps outbound delivery off a retired manager and sends through its replacement", async () => {
      const { owner, cleanup, removal } = retired;
      const reconnect = vi.spyOn(owner, "getClient");
      const sendText = (text: string) =>
        twitchOutbound.sendText!({ to: "#room", text, cfg, accountId: "default" });
      await expect(sendText("while retiring")).rejects.toThrow(
        "Client manager not found for account: default. Please start the Twitch gateway first.",
      );
      expect(reconnect).not.toHaveBeenCalled();
      expect(say).not.toHaveBeenCalled();
      const replacement = getOrCreateClientManager("default", logger);
      await replacement.getClient(account, cfg, "default");
      replacement.onMessage(vi.fn());
      await sendText("after restart");
      expect(say).toHaveBeenCalledWith("room", "after restart");
      cleanup.resolve();
      await expect(removal).resolves.toBeUndefined();
      expect(getClientManager("default")).toBe(replacement);
    });
  });
});
