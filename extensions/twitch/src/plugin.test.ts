import {
  createStartAccountContext,
  expectLifecyclePatch,
  expectStopPendingUntilAbort,
  startAccountAndTrackLifecycle,
  waitForStartedMocks,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../api.js";
import { twitchPlugin } from "./plugin.js";
import { twitchSetupPlugin } from "./setup-surface.js";

const monitorTwitchProvider = vi.hoisted(() => vi.fn());
vi.mock("./monitor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./monitor.js")>()),
  monitorTwitchProvider,
}));

const startAccount = twitchPlugin.gateway!.startAccount!;
const lifecycleAccount = {
  accountId: "default",
  username: "testbot",
  accessToken: "oauth:test-token",
  clientId: "test-client-id",
  channel: "#testchannel",
  enabled: true,
};
function withChannelRuntime(ctx: Parameters<typeof startAccount>[0]) {
  return { ...ctx, channelRuntime: createPluginRuntimeMock().channel };
}
function trackLifecycle() {
  return startAccountAndTrackLifecycle({
    startAccount: (ctx) => startAccount(withChannelRuntime(ctx)),
    account: lifecycleAccount,
  });
}

describe("twitch startAccount lifecycle", () => {
  afterEach(() => vi.clearAllMocks());

  it("publishes starting, stays pending until abort, then stops the monitor", async () => {
    const stop = vi.fn();
    monitorTwitchProvider.mockResolvedValue({ stop });
    const { patches, abort, task, isSettled } = trackLifecycle();
    await expectStopPendingUntilAbort({
      waitForStarted: async () => {
        await waitForStartedMocks(monitorTwitchProvider)();
        expectLifecyclePatch(patches, { lifecycle: "starting", running: true });
        expect(monitorTwitchProvider).toHaveBeenCalledWith(
          expect.objectContaining({ statusSink: expect.any(Function) }),
        );
      },
      isSettled,
      abort,
      task,
      stop,
    });
  });

  it("stops immediately with an already-aborted signal", async () => {
    const stop = vi.fn();
    monitorTwitchProvider.mockResolvedValue({ stop });
    const abort = new AbortController();
    abort.abort();
    await startAccount(
      withChannelRuntime(
        createStartAccountContext({ account: lifecycleAccount, abortSignal: abort.signal }),
      ),
    );
    expect(monitorTwitchProvider).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("clears running status when monitor startup fails", async () => {
    monitorTwitchProvider.mockRejectedValue(new Error("irc join failed"));
    const { task, patches } = trackLifecycle();
    await expect(task).rejects.toThrow("irc join failed");
    expectLifecyclePatch(patches, { running: true });
    expectLifecyclePatch(patches, { running: false });
  });

  it("rejects startup without its registered context builder", async () => {
    await expect(
      startAccount(createStartAccountContext({ account: lifecycleAccount })),
    ).rejects.toThrow("Twitch requires its registered channel runtime context builder");
    expect(monitorTwitchProvider).not.toHaveBeenCalled();
  });
});

function multiAccountConfig(defaultAccount?: string, selectedToken = "oauth:secondary-token") {
  const account = (name: string, accessToken: string) => ({
    channel: `${name}-channel`,
    username: name,
    accessToken,
    clientId: `${name}-client`,
    enabled: true,
  });
  return {
    channels: {
      twitch: {
        defaultAccount,
        accounts: {
          default: account("default", "oauth:default-token"),
          secondary: account("secondary", selectedToken),
        },
      },
    },
  } as OpenClawConfig;
}

describe("twitchPlugin", () => {
  it("classifies only channel targets as groups", () => {
    expect(twitchPlugin.messaging?.inferTargetChatType?.({ to: "twitch:openclaw" })).toBe("group");
    expect(
      twitchPlugin.messaging?.inferTargetChatType?.({ to: "twitch:user:operator" }),
    ).toBeUndefined();
  });
  it("reproduces the canonical inbound channel session", async () => {
    const route = await twitchPlugin.messaging?.resolveOutboundSessionRoute?.({
      cfg: {},
      agentId: "ops",
      accountId: "stream",
      target: "twitch:channel:OpenClaw",
    });

    expect(route).toMatchObject({
      sessionKey: "agent:ops:twitch:group:openclaw",
      baseSessionKey: "agent:ops:twitch:group:openclaw",
      recipientSessionExact: true,
      peer: { kind: "group", id: "openclaw" },
      chatType: "group",
      to: "openclaw",
    });
  });

  it("rejects unsupported direct targets", async () => {
    const route = await twitchPlugin.messaging?.resolveOutboundSessionRoute?.({
      cfg: {},
      agentId: "ops",
      target: "twitch:dm:alice",
    });

    expect(route).toBeNull();
  });
  it("uses the resolved account ID for multi-account configs", async () => {
    const cfg = multiAccountConfig();
    const snapshot = await twitchPlugin.status?.buildAccountSnapshot?.({
      account: twitchPlugin.config.resolveAccount(cfg, "secondary"),
      cfg,
    });

    expect(snapshot?.accountId).toBe("secondary");
  });
  it("uses configured defaultAccount for omitted-account plugin resolution", () => {
    const cfg = multiAccountConfig("secondary");
    expect(twitchPlugin.config.defaultAccountId?.(cfg)).toBe("secondary");
    expect(twitchPlugin.config.resolveAccount(cfg).accountId).toBe("secondary");
  });

  it("does not borrow the configured default account's token", () => {
    const cfg = multiAccountConfig(undefined, "");
    for (const config of [twitchPlugin.config, twitchSetupPlugin.config]) {
      const account = config.resolveAccount(cfg, "secondary");
      expect(account.accountId).toBe("secondary");
      expect(config.isConfigured?.(account, cfg)).toBe(false);
    }
  });
});
