import {
  createStartAccountContext,
  expectLifecyclePatch,
  expectStopPendingUntilAbort,
  startAccountAndTrackLifecycle,
  waitForStartedMocks,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TwitchAccountConfig } from "./types.js";

const hoisted = vi.hoisted(() => ({
  monitorTwitchProvider: vi.fn(),
}));

vi.mock("./monitor.js", () => ({
  monitorTwitchProvider: hoisted.monitorTwitchProvider,
}));

const { twitchPlugin } = await import("./plugin.js");

type TwitchStartAccount = NonNullable<NonNullable<typeof twitchPlugin.gateway>["startAccount"]>;

const account: TwitchAccountConfig & { accountId: string } = {
  accountId: "default",
  username: "testbot",
  accessToken: "oauth:test-token",
  clientId: "test-client-id",
  channel: "#testchannel",
  enabled: true,
};
const startAccount = twitchPlugin.gateway!.startAccount!;

function mockStartedMonitor() {
  const stop = vi.fn();
  hoisted.monitorTwitchProvider.mockResolvedValue({ stop });
  return stop;
}

function trackLifecycle() {
  return startAccountAndTrackLifecycle({
    startAccount: (ctx) => startAccount(withChannelRuntime(ctx)),
    account,
  });
}

function withChannelRuntime(ctx: Parameters<TwitchStartAccount>[0]) {
  return { ...ctx, channelRuntime: createPluginRuntimeMock().channel };
}

describe("twitch startAccount lifecycle", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("keeps startAccount pending until abort, then stops the monitor", async () => {
    const stop = mockStartedMonitor();
    const { abort, task, isSettled } = trackLifecycle();
    await expectStopPendingUntilAbort({
      waitForStarted: waitForStartedMocks(hoisted.monitorTwitchProvider),
      isSettled,
      abort,
      task,
      stop,
    });
  });

  it("publishes starting and forwards a bound status sink to the monitor", async () => {
    const stop = mockStartedMonitor();
    const { patches, abort, task } = trackLifecycle();

    await vi.waitFor(() => expect(hoisted.monitorTwitchProvider).toHaveBeenCalledOnce());
    expectLifecyclePatch(patches, { lifecycle: "starting", running: true });
    expect(hoisted.monitorTwitchProvider).toHaveBeenCalledWith(
      expect.objectContaining({ statusSink: expect.any(Function) }),
    );

    abort.abort();
    await task;
    expect(stop).toHaveBeenCalledOnce();
  });

  it("stops immediately when startAccount receives an already-aborted signal", async () => {
    const stop = mockStartedMonitor();
    const abort = new AbortController();
    abort.abort();

    await startAccount(
      withChannelRuntime(createStartAccountContext({ account, abortSignal: abort.signal })),
    );

    expect(hoisted.monitorTwitchProvider).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("clears running status when monitor startup fails", async () => {
    hoisted.monitorTwitchProvider.mockRejectedValue(new Error("irc join failed"));
    const { task, patches } = trackLifecycle();

    await expect(task).rejects.toThrow("irc join failed");
    expectLifecyclePatch(patches, { running: true });
    expectLifecyclePatch(patches, { running: false });
  });

  it("rejects startup without its registered context builder", async () => {
    await expect(startAccount(createStartAccountContext({ account }))).rejects.toThrow(
      "Twitch requires its registered channel runtime context builder",
    );
    expect(hoisted.monitorTwitchProvider).not.toHaveBeenCalled();
  });
});
