import {
  createStartAccountContext,
  expectLifecyclePatch,
  expectStopPendingUntilAbort,
  startAccountAndTrackLifecycle,
  waitForStartedMocks,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeEach, expect, it, vi } from "vitest";
import { twitchPlugin } from "./plugin.js";
import { twitchSetupPlugin } from "./setup-surface.js";
import { BASE_TWITCH_TEST_ACCOUNT, makeTwitchChannelTestConfig } from "./test-fixtures.js";

const monitorTwitchProvider = vi.hoisted(() => vi.fn());
vi.mock("./monitor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./monitor.js")>()),
  monitorTwitchProvider,
}));

const startAccount = twitchPlugin.gateway!.startAccount!;
const { config, messaging, status } = twitchPlugin;
const lifecycleAccount = {
  ...BASE_TWITCH_TEST_ACCOUNT,
  accountId: "default",
  accessToken: "oauth:test-token",
};
const startWithRuntime = (ctx: Parameters<typeof startAccount>[0]) =>
  startAccount({ ...ctx, channelRuntime: createPluginRuntimeMock().channel });
const trackLifecycle = () =>
  startAccountAndTrackLifecycle({ startAccount: startWithRuntime, account: lifecycleAccount });
const stop = vi.fn();

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
function multiAccountConfig(accessToken = "oauth:secondary-token") {
  return makeTwitchChannelTestConfig({
    defaultAccount: "default",
    accounts: {
      default: lifecycleAccount,
      secondary: { ...BASE_TWITCH_TEST_ACCOUNT, accessToken },
    },
  });
}

it.each([
  [
    "twitch:channel:OpenClaw",
    "twitch:openclaw",
    "group",
    expect.objectContaining({
      sessionKey: "agent:ops:twitch:group:openclaw",
      baseSessionKey: "agent:ops:twitch:group:openclaw",
      recipientSessionExact: true,
      peer: { kind: "group", id: "openclaw" },
      chatType: "group",
      to: "openclaw",
    }),
  ],
  ["twitch:dm:alice", "twitch:user:operator", undefined, null],
] as const)("classifies and routes %s", async (target, to, chatType, expected) => {
  expect(messaging?.inferTargetChatType?.({ to })).toBe(chatType);
  expect(
    await messaging?.resolveOutboundSessionRoute?.({
      cfg: {},
      agentId: "ops",
      accountId: "stream",
      target,
    }),
  ).toEqual(expected);
});
it("resolves the default account and its status", async () => {
  const cfg = multiAccountConfig();
  cfg.channels.twitch.defaultAccount = "secondary";
  const account = config.resolveAccount(cfg);
  expect(config.defaultAccountId?.(cfg)).toBe("secondary");
  expect(account.accountId).toBe("secondary");
  expect((await status?.buildAccountSnapshot?.({ account, cfg }))?.accountId).toBe("secondary");
});

it("does not borrow the configured default account's token", () => {
  const cfg = multiAccountConfig("");
  for (const adapter of [config, twitchSetupPlugin.config]) {
    const account = adapter.resolveAccount(cfg, "secondary");
    expect(account.accountId).toBe("secondary");
    expect(adapter.isConfigured?.(account, cfg)).toBe(false);
  }
});
