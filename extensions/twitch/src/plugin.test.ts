import {
  createStartAccountContext,
  expectLifecyclePatch,
  expectStopPendingUntilAbort,
  startAccountAndTrackLifecycle,
  waitForStartedMocks,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../api.js";
import { twitchPlugin } from "./plugin.js";
import { twitchSetupPlugin } from "./setup-surface.js";
import { BASE_TWITCH_TEST_ACCOUNT, makeTwitchChannelTestConfig } from "./test-fixtures.js";

const monitorTwitchProvider = vi.hoisted(() => vi.fn());
vi.mock("./monitor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./monitor.js")>()),
  monitorTwitchProvider,
}));

const startAccount = twitchPlugin.gateway!.startAccount!;
const lifecycleAccount = {
  ...BASE_TWITCH_TEST_ACCOUNT,
  accountId: "default",
  accessToken: "oauth:test-token",
  enabled: true,
};
const startWithRuntime = (ctx: Parameters<typeof startAccount>[0]) =>
  startAccount({ ...ctx, channelRuntime: createPluginRuntimeMock().channel });
const trackLifecycle = () =>
  startAccountAndTrackLifecycle({ startAccount: startWithRuntime, account: lifecycleAccount });
const stop = vi.fn();

describe("twitch startAccount lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    monitorTwitchProvider.mockResolvedValue({ stop });
  });

  it("publishes starting, stays pending until abort, then stops the monitor", async () => {
    const lifecycle = trackLifecycle();
    await expectStopPendingUntilAbort({
      ...lifecycle,
      waitForStarted: async () => {
        await waitForStartedMocks(monitorTwitchProvider)();
        expectLifecyclePatch(lifecycle.patches, { lifecycle: "starting", running: true });
        expect(monitorTwitchProvider).toHaveBeenCalledWith(
          expect.objectContaining({ statusSink: expect.any(Function) }),
        );
      },
      stop,
    });
  });

  it("stops immediately with an already-aborted signal", async () => {
    const abort = new AbortController();
    abort.abort();
    await startWithRuntime(
      createStartAccountContext({ account: lifecycleAccount, abortSignal: abort.signal }),
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

function multiAccountConfig(
  defaultAccount?: string,
  selectedToken = "oauth:secondary-token",
): OpenClawConfig {
  return makeTwitchChannelTestConfig({
    defaultAccount,
    accounts: {
      default: lifecycleAccount,
      secondary: { ...BASE_TWITCH_TEST_ACCOUNT, enabled: true, accessToken: selectedToken },
    },
  });
}

describe("twitchPlugin", () => {
  it("classifies only channel targets as groups", () => {
    expect(twitchPlugin.messaging?.inferTargetChatType?.({ to: "twitch:openclaw" })).toBe("group");
    expect(
      twitchPlugin.messaging?.inferTargetChatType?.({ to: "twitch:user:operator" }),
    ).toBeUndefined();
  });
  it.each([
    [
      "twitch:channel:OpenClaw",
      expect.objectContaining({
        sessionKey: "agent:ops:twitch:group:openclaw",
        baseSessionKey: "agent:ops:twitch:group:openclaw",
        recipientSessionExact: true,
        peer: { kind: "group", id: "openclaw" },
        chatType: "group",
        to: "openclaw",
      }),
    ],
    ["twitch:dm:alice", null],
  ] as const)(
    "resolves channel sessions but rejects direct targets: %s",
    async (target, expected) => {
      const route = await twitchPlugin.messaging?.resolveOutboundSessionRoute?.({
        cfg: {},
        agentId: "ops",
        accountId: "stream",
        target,
      });
      expect(route).toEqual(expected);
    },
  );
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
