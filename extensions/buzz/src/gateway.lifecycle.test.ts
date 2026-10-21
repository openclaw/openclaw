import { getEventListeners } from "node:events";
import { createStartAccountContext } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BuzzBus, startBuzzBus } from "./buzz-bus.js";
import type { BuzzConfigInput } from "./config-schema.js";

type BusOptions = Parameters<typeof startBuzzBus>[0];
type GatewayOptions = Parameters<typeof startBuzzGatewayAccount>[0];

const gatewayMocks = vi.hoisted(() => ({
  close: vi.fn(async () => {}),
  busSendText: vi.fn(async () => "event-id"),
  busSendTyping: vi.fn(async () => undefined),
  sendBuzzTextOneShot: vi.fn(async () => "standalone-event-id"),
  onMessage: undefined as BusOptions["onMessage"] | undefined,
  onMessageError: undefined as BusOptions["onMessageError"],
  onFatalError: undefined as BusOptions["onFatalError"],
  resolveAgentIdentity: vi.fn(),
  resolveAgentRoute: vi.fn(),
  recoveryEntries: vi.fn(),
  startBuzzBus: vi.fn(),
}));

vi.mock("./buzz-bus.js", () => ({
  sendBuzzTextOneShot: gatewayMocks.sendBuzzTextOneShot,
  startBuzzBus: gatewayMocks.startBuzzBus,
}));

vi.mock("./inbound.js", () => ({
  handleBuzzInbound: vi.fn(async () => {}),
}));

import { BuzzDirectoryState } from "./directory-state.js";
import {
  buzzOutboundAdapter,
  getActiveBuzzBus,
  sendBuzzTyping,
  startBuzzGatewayAccount,
} from "./gateway.js";
import { BUZZ_NORMAL_MESSAGE_KIND } from "./message-event.js";
import { setBuzzRuntime } from "./runtime.js";
import { isConfiguredBuzzChannel } from "./target.js";
import { resolveBuzzAccount } from "./types.js";

const CHANNEL_ID = "7c4a6d2a-2ed9-4b4e-a5e2-4d705ee9b34c";
const PRIVATE_KEY = "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
const BOT_PUBLIC_KEY = "a".repeat(64);

function createBuzzConfig(overrides: Partial<BuzzConfigInput> = {}): OpenClawConfig {
  return {
    channels: {
      buzz: {
        relayUrl: "wss://buzz.example.com",
        privateKey: PRIVATE_KEY,
        groups: { [CHANNEL_ID]: {} },
        ...overrides,
      },
    },
  } as OpenClawConfig;
}

function createUnavailableBuzzConfig(credential: "privateKey" | "authTag"): OpenClawConfig {
  vi.stubEnv("BUZZ_PRIVATE_KEY", PRIVATE_KEY);
  vi.stubEnv("BUZZ_AUTH_TAG", "ambient-auth-tag");
  const cfg = createBuzzConfig();
  cfg.channels!.buzz![credential] = {
    source: "env",
    provider: "default",
    id: credential === "privateKey" ? "MISSING_BUZZ_PRIVATE_KEY" : "MISSING_BUZZ_AUTH_TAG",
  };
  return cfg;
}

function startTestGateway(
  options: {
    cfg?: OpenClawConfig;
    accountId?: string;
    profileName?: string;
    setStatus?: GatewayOptions["setStatus"];
    logInfo?: NonNullable<GatewayOptions["log"]>["info"];
    logError?: NonNullable<GatewayOptions["log"]>["error"];
    invalidateDirectoryCache?: GatewayOptions["invalidateDirectoryCache"];
  } = {},
) {
  const abortController = new AbortController();
  const cfg = options.cfg ?? createBuzzConfig({ name: options.profileName });
  const account = resolveBuzzAccount({ cfg, accountId: options.accountId });
  const setStatus = options.setStatus ?? vi.fn();
  const lifecycle = startBuzzGatewayAccount({
    ...createStartAccountContext({ account, abortSignal: abortController.signal, cfg }),
    scheduler: createTestPluginServiceScheduler(),
    log: { info: options.logInfo ?? vi.fn(), warn: vi.fn(), error: options.logError ?? vi.fn() },
    setStatus,
    invalidateDirectoryCache: options.invalidateDirectoryCache,
  });
  const stop = async () => {
    abortController.abort();
    await expect(lifecycle).resolves.toBeUndefined();
  };
  return { abortController, cfg, account, setStatus, lifecycle, stop };
}

function createMockBus(overrides: Partial<BuzzBus> = {}): BuzzBus {
  return {
    publicKey: BOT_PUBLIC_KEY,
    directory: new BuzzDirectoryState({
      publicKey: BOT_PUBLIC_KEY,
      fallbackProfileName: "OpenClaw",
      channelIds: [CHANNEL_ID],
    }),
    refreshDirectory: vi.fn(async () => {}),
    isBotOwnedThread: vi.fn(async () => false),
    sendText: gatewayMocks.busSendText,
    sendTyping: gatewayMocks.busSendTyping,
    close: gatewayMocks.close,
    ...overrides,
  };
}

function resolveBusSince(callIndex: number): number {
  const since = gatewayMocks.startBuzzBus.mock.calls[callIndex]?.[0].since as (
    channelId: string,
  ) => number;
  return since(CHANNEL_ID);
}

function sendText(
  cfg: OpenClawConfig,
  text: string,
  overrides: Partial<Parameters<typeof buzzOutboundAdapter.sendText>[0]> = {},
) {
  return buzzOutboundAdapter.sendText({ cfg, to: `buzz:${CHANNEL_ID}`, text, ...overrides });
}

function typeInRoom(
  cfg: OpenClawConfig,
  overrides: Partial<Parameters<typeof sendBuzzTyping>[0]> = {},
) {
  return sendBuzzTyping({ cfg, to: `buzz:${CHANNEL_ID}`, ...overrides });
}

async function expectRetiredBusSend(cfg: OpenClawConfig, accountId: string, count: number) {
  expect(getActiveBuzzBus(accountId)).toBeUndefined();
  await expect(sendText(cfg, "while retired", { accountId })).resolves.toMatchObject({
    messageId: "standalone-event-id",
  });
  await typeInRoom(cfg, { accountId });
  expect(gatewayMocks.sendBuzzTextOneShot).toHaveBeenCalledTimes(count);
  expect(gatewayMocks.busSendText).not.toHaveBeenCalled();
  expect(gatewayMocks.busSendTyping).not.toHaveBeenCalled();
}

describe("Buzz gateway lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gatewayMocks.onMessage = undefined;
    gatewayMocks.onMessageError = undefined;
    gatewayMocks.onFatalError = undefined;
    gatewayMocks.busSendText.mockResolvedValue("event-id");
    gatewayMocks.busSendTyping.mockResolvedValue(undefined);
    gatewayMocks.sendBuzzTextOneShot.mockResolvedValue("standalone-event-id");
    gatewayMocks.resolveAgentIdentity.mockReset().mockReturnValue(undefined);
    gatewayMocks.resolveAgentRoute.mockReset().mockReturnValue({ agentId: "main" });
    const recoveryRooms = new Map<string, { seconds: number }>();
    gatewayMocks.recoveryEntries.mockImplementation(async () =>
      Array.from(recoveryRooms, ([key, value]) => ({ key, value })),
    );
    setBuzzRuntime({
      agent: { resolveAgentIdentity: gatewayMocks.resolveAgentIdentity },
      channel: {
        routing: { resolveAgentRoute: gatewayMocks.resolveAgentRoute },
        text: {
          resolveMarkdownTableMode: () => "preserve",
          convertMarkdownTables: (text: string) => text,
        },
      },
      state: {
        openKeyedStore: () => ({
          lookup: async (key: string) => recoveryRooms.get(key),
          register: async (key: string, value: { seconds: number }) => {
            recoveryRooms.set(key, value);
          },
          entries: gatewayMocks.recoveryEntries,
          delete: async (key: string) => recoveryRooms.delete(key),
        }),
      },
    } as never);
    gatewayMocks.startBuzzBus.mockImplementation(async (options: BusOptions): Promise<BuzzBus> => {
      gatewayMocks.onMessage = options.onMessage;
      gatewayMocks.onMessageError = options.onMessageError;
      gatewayMocks.onFatalError = options.onFatalError;
      return createMockBus();
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("reports the implicit root account path when rooms are missing", async () => {
    await expect(
      startTestGateway({ cfg: createBuzzConfig({ groups: undefined }) }).lifecycle,
    ).rejects.toThrow("Buzz requires at least one enabled channels.buzz.groups entry");
    expect(gatewayMocks.startBuzzBus).not.toHaveBeenCalled();
    expect(gatewayMocks.recoveryEntries).not.toHaveBeenCalled();
  });

  it("invalidates cached room targets after initial discovery and newer room metadata", async () => {
    const invalidateDirectoryCache = vi.fn();
    const { stop } = startTestGateway({ invalidateDirectoryCache });
    try {
      await vi.waitFor(() => expect(gatewayMocks.startBuzzBus).toHaveBeenCalledOnce());
      expect(invalidateDirectoryCache).toHaveBeenCalledOnce();
      gatewayMocks.startBuzzBus.mock.calls[0]?.[0].onRoomDirectoryChanged?.();
      expect(invalidateDirectoryCache).toHaveBeenCalledTimes(2);
    } finally {
      await stop();
    }
  });

  it("reports unreadable recovery state without connecting or skipping room history", async () => {
    gatewayMocks.recoveryEntries.mockRejectedValueOnce(new Error("room activation unreadable"));
    const setStatus = vi.fn();
    const { stop } = startTestGateway({ setStatus });

    await vi.waitFor(() =>
      expect(setStatus).toHaveBeenCalledWith({
        accountId: "default",
        running: false,
        lifecycle: "recovering",
        lastError: "room activation unreadable",
      }),
    );
    expect(gatewayMocks.startBuzzBus).not.toHaveBeenCalled();

    await stop();
  });

  it("restarts the account lifecycle when the bus reports a failure", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    gatewayMocks.resolveAgentIdentity.mockReturnValue({ name: "Molt" });
    const setStatus = vi.fn();
    const { stop, account } = startTestGateway({ setStatus });

    await vi.waitFor(() => expect(gatewayMocks.startBuzzBus).toHaveBeenCalledOnce());
    expect(gatewayMocks.startBuzzBus.mock.calls[0]?.[0].profileName).toBe("Molt");
    expect(setStatus).toHaveBeenCalledWith({
      accountId: account.accountId,
      running: true,
      connected: true,
      lifecycle: "ready",
      lastConnectedAt: expect.any(Number),
      configured: true,
      enabled: account.enabled,
      baseUrl: account.relayUrl,
      publicKey: BOT_PUBLIC_KEY,
      lastError: null,
      terminalDisconnect: undefined,
    });
    gatewayMocks.onFatalError?.(new Error("relay failed"));
    await vi.advanceTimersByTimeAsync(1_200);

    await vi.waitFor(() => expect(gatewayMocks.startBuzzBus).toHaveBeenCalledTimes(2), {
      timeout: 3_000,
    });
    expect(gatewayMocks.close).toHaveBeenCalledOnce();
    expect(setStatus).toHaveBeenCalledWith({
      accountId: account.accountId,
      running: false,
      lifecycle: "recovering",
      lastError: "relay failed",
    });

    await stop();
    expect(gatewayMocks.close).toHaveBeenCalledTimes(2);
  });

  it("uses a one-shot authenticated connection when no gateway bus is running", async () => {
    const cfg = createBuzzConfig({ replyToMode: "off" });

    const result = await sendText(cfg, "hello", {
      accountId: "default",
      threadId: "root-id",
      replyToId: "parent-id",
    });

    expect(gatewayMocks.sendBuzzTextOneShot).toHaveBeenCalledWith({
      relayUrl: "wss://buzz.example.com",
      privateKey: PRIVATE_KEY,
      authTag: "",
      channelId: CHANNEL_ID,
      text: "hello",
      threadId: "root-id",
      replyToId: "parent-id",
    });
    expect(result).toEqual({
      channel: "buzz",
      to: CHANNEL_ID,
      messageId: "standalone-event-id",
    });
  });

  it("routes a named default send with only that account's credentials", async () => {
    const cfg = createBuzzConfig({
      defaultAccount: "ada",
      authTag: "root-auth",
      accounts: { ada: { relayUrl: "wss://ada.example.com", privateKey: "22".repeat(32) } },
    });
    await sendText(cfg, "Ada says hello", { to: CHANNEL_ID });
    expect(gatewayMocks.sendBuzzTextOneShot).toHaveBeenCalledWith(
      expect.objectContaining({
        relayUrl: "wss://ada.example.com",
        privateKey: "22".repeat(32),
        authTag: "",
        text: "Ada says hello",
      }),
    );
  });

  it("blocks direct sends before opening a relay when an auth-tag SecretRef is unavailable", async () => {
    const cfg = createUnavailableBuzzConfig("authTag");

    await expect(sendText(cfg, "must not send", { accountId: "default" })).rejects.toThrow(
      /configured.*unavailable|unresolved/i,
    );
    expect(gatewayMocks.sendBuzzTextOneShot).not.toHaveBeenCalled();
    expect(gatewayMocks.busSendText).not.toHaveBeenCalled();
  });

  it("blocks gateway startup before opening a relay when a private-key SecretRef is unavailable", async () => {
    const { lifecycle } = startTestGateway({ cfg: createUnavailableBuzzConfig("privateKey") });
    await expect(lifecycle).rejects.toThrow(/configured.*unavailable|unresolved/i);
    expect(gatewayMocks.startBuzzBus).not.toHaveBeenCalled();
  });

  it.each(["resolves", "rejects"] as const)(
    "retires the active bus before asynchronous shutdown %s",
    async (closeOutcome) => {
      const close = createDeferred<void>();
      gatewayMocks.close.mockImplementationOnce(() => close.promise);
      const { abortController, cfg, account, lifecycle, setStatus } = startTestGateway();

      try {
        await vi.waitFor(() => expect(getActiveBuzzBus(account.accountId)).toBeDefined());
        abortController.abort();
        await vi.waitFor(() => expect(gatewayMocks.close).toHaveBeenCalledOnce());

        const stoppedStatus = { accountId: account.accountId, running: false };
        expect(setStatus).not.toHaveBeenCalledWith(stoppedStatus);
        await expectRetiredBusSend(cfg, account.accountId, 1);

        if (closeOutcome === "rejects") {
          const closeError = new Error("Buzz close failed");
          close.reject(closeError);
          await expect(lifecycle).rejects.toBe(closeError);
          expect(setStatus).not.toHaveBeenCalledWith(stoppedStatus);
        } else {
          close.resolve();
          await expect(lifecycle).resolves.toBeUndefined();
          expect(setStatus).toHaveBeenLastCalledWith(stoppedStatus);
        }

        await expectRetiredBusSend(cfg, account.accountId, 2);
      } finally {
        abortController.abort();
        close.resolve();
        await lifecycle.catch(() => undefined);
      }
    },
  );

  it("keeps root usable while a named account settles and restarts", async () => {
    const cfg = createBuzzConfig();
    const rootAccount = resolveBuzzAccount({ cfg, accountId: "default" });
    cfg.channels!.buzz!.accounts = {
      ada: {
        relayUrl: "wss://ada.example.com",
        privateKey: "1".repeat(64),
        groups: { "940d0c32-4eb7-46d7-9d5b-d975aaef87f7": {} },
      },
    };
    expect(resolveBuzzAccount({ cfg, accountId: "default" })).toEqual(rootAccount);
    const adaClose = createDeferred<void>();
    const rootBus = createMockBus({
      sendText: vi.fn(async () => "root-event"),
      sendTyping: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    });
    const adaBus = createMockBus({ close: vi.fn(() => adaClose.promise) });
    const replacementBus = createMockBus({ close: vi.fn(async () => {}) });
    gatewayMocks.startBuzzBus
      .mockResolvedValueOnce(rootBus)
      .mockResolvedValueOnce(adaBus)
      .mockResolvedValueOnce(replacementBus);
    const root = startTestGateway({ cfg, accountId: "default" });
    let ada: ReturnType<typeof startTestGateway> | undefined;
    let replacement: ReturnType<typeof startTestGateway> | undefined;
    try {
      await vi.waitFor(() => expect(getActiveBuzzBus("default")).toBe(rootBus));
      ada = startTestGateway({ cfg, accountId: "ada" });
      await vi.waitFor(() => expect(getActiveBuzzBus("ada")).toBe(adaBus));
      const rootStatus = vi.mocked(root.setStatus).mock.calls.slice();
      const expectRootUnchanged = () => {
        expect(root.abortController.signal.aborted).toBe(false);
        expect(getActiveBuzzBus("default")).toBe(rootBus);
        expect(rootBus.close).not.toHaveBeenCalled();
        expect(vi.mocked(root.setStatus).mock.calls).toEqual(rootStatus);
      };
      let adaStopped = false;
      void ada.lifecycle.then(() => {
        adaStopped = true;
      });
      ada.abortController.abort();
      await vi.waitFor(() => expect(adaBus.close).toHaveBeenCalledOnce());
      expect(getActiveBuzzBus("ada")).toBeUndefined();
      expect(adaStopped).toBe(false);
      expectRootUnchanged();
      await expect(
        sendText(cfg, "root during Ada shutdown", { accountId: "default" }),
      ).resolves.toMatchObject({ messageId: "root-event" });
      await typeInRoom(cfg, { accountId: "default" });
      expect(rootBus.sendText).toHaveBeenCalledOnce();
      expect(rootBus.sendTyping).toHaveBeenCalledOnce();
      expect(gatewayMocks.sendBuzzTextOneShot).not.toHaveBeenCalled();
      adaClose.resolve();
      await ada.lifecycle;
      cfg.channels!.buzz!.accounts!.ada!.privateKey = "2".repeat(64);
      expect(resolveBuzzAccount({ cfg, accountId: "default" })).toEqual(rootAccount);
      replacement = startTestGateway({ cfg, accountId: "ada" });
      await vi.waitFor(() => expect(getActiveBuzzBus("ada")).toBe(replacementBus));
      expect(gatewayMocks.startBuzzBus.mock.calls.map(([options]) => options.accountId)).toEqual([
        "default",
        "ada",
        "ada",
      ]);
      expect(gatewayMocks.startBuzzBus.mock.calls[2]?.[0].privateKey).toBe("2".repeat(64));
      expectRootUnchanged();
    } finally {
      root.abortController.abort();
      ada?.abortController.abort();
      replacement?.abortController.abort();
      adaClose.resolve();
      await Promise.all([root.lifecycle, ada?.lifecycle, replacement?.lifecycle]);
    }
  });

  it("does not retire a replacement bus when an earlier generation finishes closing", async () => {
    const close = createDeferred<void>();
    gatewayMocks.close.mockImplementationOnce(() => close.promise);
    const first = startTestGateway();
    let replacement: ReturnType<typeof startTestGateway> | undefined;

    try {
      await vi.waitFor(() => expect(getActiveBuzzBus(first.account.accountId)).toBeDefined());
      replacement = startTestGateway();
      await vi.waitFor(() => expect(gatewayMocks.startBuzzBus).toHaveBeenCalledTimes(2));
      const replacementBus = getActiveBuzzBus(first.account.accountId);
      expect(replacementBus).toBeDefined();

      first.abortController.abort();
      await vi.waitFor(() => expect(gatewayMocks.close).toHaveBeenCalledOnce());
      expect(getActiveBuzzBus(first.account.accountId)).toBe(replacementBus);

      close.resolve();
      await expect(first.lifecycle).resolves.toBeUndefined();
      expect(getActiveBuzzBus(first.account.accountId)).toBe(replacementBus);
    } finally {
      first.abortController.abort();
      close.resolve();
      await first.lifecycle.catch(() => undefined);
      replacement?.abortController.abort();
      await replacement?.lifecycle.catch(() => undefined);
    }
  });

  it("reuses the gateway bus for sends in the running process", async () => {
    const { stop, cfg } = startTestGateway({ profileName: "BuzzClaw" });
    await vi.waitFor(() => expect(gatewayMocks.startBuzzBus).toHaveBeenCalledOnce());
    expect(gatewayMocks.startBuzzBus.mock.calls[0]?.[0].profileName).toBe("BuzzClaw");
    expect(gatewayMocks.resolveAgentRoute).not.toHaveBeenCalled();

    await sendText(cfg, "hello", { accountId: "default" });

    expect(gatewayMocks.busSendText).toHaveBeenCalledWith({
      channelId: CHANNEL_ID,
      text: "hello",
      threadId: undefined,
      replyToId: undefined,
    });
    expect(gatewayMocks.sendBuzzTextOneShot).not.toHaveBeenCalled();

    await stop();
  });

  it("uses threaded heartbeat typing without destabilizing the account", async () => {
    const { stop, cfg } = startTestGateway();
    await vi.waitFor(() => expect(gatewayMocks.startBuzzBus).toHaveBeenCalledOnce());
    const typingCfg = createBuzzConfig({ replyToMode: "all" });

    await typeInRoom(typingCfg, { accountId: "default", threadId: "root-id" });
    expect(gatewayMocks.busSendTyping).toHaveBeenCalledWith({
      channelId: CHANNEL_ID,
      threadId: "root-id",
    });

    gatewayMocks.busSendTyping.mockRejectedValueOnce(new Error("socket closing"));
    await expect(typeInRoom(cfg, { accountId: "default" })).rejects.toThrow("socket closing");
    expect(gatewayMocks.startBuzzBus).toHaveBeenCalledOnce();
    expect(gatewayMocks.close).not.toHaveBeenCalled();

    await stop();
  });

  it("drops typing for a root-disabled named identity even with an active bus", async () => {
    const cfg = createBuzzConfig({
      defaultAccount: "ada",
      accounts: {
        ada: {
          relayUrl: "wss://ada.example.com",
          privateKey: "22".repeat(32),
          groups: { [CHANNEL_ID]: {} },
          replyToMode: "off",
        },
      },
    });
    const { stop } = startTestGateway({ cfg });
    try {
      await vi.waitFor(() => expect(getActiveBuzzBus("ada")).toBeDefined());
      await typeInRoom(cfg, { to: CHANNEL_ID, threadId: "root-id" });
      expect(gatewayMocks.busSendTyping).toHaveBeenCalledWith({
        channelId: CHANNEL_ID,
        threadId: undefined,
      });
      gatewayMocks.busSendTyping.mockClear();
      cfg.channels!.buzz!.enabled = false;
      await typeInRoom(cfg, { to: CHANNEL_ID, threadId: "root-id" });
      expect(gatewayMocks.busSendTyping).not.toHaveBeenCalled();
    } finally {
      await stop();
    }
  });

  it("preserves room activation after a failed initial session", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(1_700_000_000_900);
    gatewayMocks.startBuzzBus.mockRejectedValueOnce(new Error("connect failed"));
    const { stop } = startTestGateway();
    try {
      await vi.advanceTimersByTimeAsync(1_200);
      await vi.waitFor(() => expect(gatewayMocks.startBuzzBus).toHaveBeenCalledTimes(2), {
        timeout: 3_000,
      });
      expect(resolveBusSince(0)).toBe(1_700_000_000);
      expect(resolveBusSince(1)).toBe(1_700_000_000);
      expect(Math.floor(Date.now() / 1_000)).toBeGreaterThan(1_700_000_000);
    } finally {
      await stop();
    }
  });

  it("keeps the account running when one message fails", async () => {
    const setStatus = vi.fn();
    const logError = vi.fn();
    const { stop, account } = startTestGateway({ setStatus, logError });

    await vi.waitFor(() => expect(gatewayMocks.startBuzzBus).toHaveBeenCalledOnce());
    gatewayMocks.onMessageError?.(new Error("dispatch failed"));
    expect(logError).toHaveBeenCalledWith(
      `[${account.accountId}] Buzz message failed: dispatch failed`,
    );

    await stop();
    expect(setStatus).toHaveBeenLastCalledWith({
      accountId: account.accountId,
      running: false,
    });
  });

  it("preserves the activation floor on reconnect without trusting sender time", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const invalidateDirectoryCache = vi.fn();
    const { stop, abortController } = startTestGateway({ invalidateDirectoryCache });

    await vi.waitFor(() => expect(gatewayMocks.startBuzzBus).toHaveBeenCalledOnce());
    const initialAbortListeners = getEventListeners(abortController.signal, "abort").length;
    const createdAt = Math.floor(Date.now() / 1000) + 24 * 60 * 60;
    await gatewayMocks.onMessage?.(
      {
        id: "event-1",
        kind: BUZZ_NORMAL_MESSAGE_KIND,
        channelId: CHANNEL_ID,
        senderPubkey: "b".repeat(64),
        text: "hello",
        createdAt,
        mentionedPubkeys: [],
      },
      createMockBus(),
      new AbortController().signal,
      () => {},
    );
    const reconnectStartedAt = Math.floor(Date.now() / 1000);
    gatewayMocks.onFatalError?.(new Error("relay failed"));
    await vi.advanceTimersByTimeAsync(1_200);

    await vi.waitFor(() => expect(gatewayMocks.startBuzzBus).toHaveBeenCalledTimes(2), {
      timeout: 3_000,
    });
    expect(invalidateDirectoryCache).toHaveBeenCalledTimes(2);
    const secondSince = resolveBusSince(1);
    expect(secondSince).toBe(resolveBusSince(0));
    expect(secondSince).toBeLessThanOrEqual(reconnectStartedAt);
    expect(secondSince).toBeLessThan(createdAt);

    const reconnectedAbortListeners = getEventListeners(abortController.signal, "abort").length;
    await stop();
    expect(reconnectedAbortListeners).toBe(initialAbortListeners);
  });
});

describe("Buzz gateway channel admission", () => {
  it("accepts only configured channel UUIDs", () => {
    const configuredChannelIds = new Set([CHANNEL_ID]);
    expect(isConfiguredBuzzChannel(configuredChannelIds, CHANNEL_ID)).toBe(true);
    expect(isConfiguredBuzzChannel(configuredChannelIds, CHANNEL_ID.toUpperCase())).toBe(true);
    expect(
      isConfiguredBuzzChannel(configuredChannelIds, "45c84a8d-5ed9-4e2c-b846-acedecc82bd1"),
    ).toBe(false);
    expect(isConfiguredBuzzChannel(configuredChannelIds, "not-a-channel")).toBe(false);
  });
});
