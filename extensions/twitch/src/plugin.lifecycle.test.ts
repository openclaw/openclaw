// Twitch tests cover plugin.lifecycle plugin behavior.
import {
  createStartAccountContext,
  expectLifecyclePatch,
  expectStopPendingUntilAbort,
  startAccountAndTrackLifecycle,
  waitForStartedMocks,
} from "openclaw/plugin-sdk/channel-test-helpers";
import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/status-helpers";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TwitchStatusPatch } from "./monitor.js";
import type { TwitchAccountConfig } from "./types.js";

const hoisted = vi.hoisted(() => ({
  monitorTwitchProvider: vi.fn(),
}));

vi.mock("./monitor.js", () => ({
  monitorTwitchProvider: hoisted.monitorTwitchProvider,
}));

const { twitchPlugin } = await import("./plugin.js");

type TwitchStartAccount = NonNullable<NonNullable<typeof twitchPlugin.gateway>["startAccount"]>;

function requireStartAccount(): TwitchStartAccount {
  const startAccount = twitchPlugin.gateway?.startAccount;
  if (!startAccount) {
    throw new Error("Expected Twitch gateway startAccount");
  }
  return startAccount;
}

function buildAccount(): TwitchAccountConfig & { accountId: string } {
  return {
    accountId: "default",
    username: "testbot",
    accessToken: "oauth:test-token",
    clientId: "test-client-id",
    channel: "#testchannel",
    enabled: true,
  };
}

function mockStartedMonitor() {
  const stop = vi.fn();
  hoisted.monitorTwitchProvider.mockResolvedValue({ stop });
  return stop;
}

function startTwitchAccount(abortSignal?: AbortSignal) {
  return requireStartAccount()(
    createStartAccountContext({
      account: buildAccount(),
      abortSignal,
    }),
  );
}

describe("twitch startAccount lifecycle", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("keeps startAccount pending until abort, then stops the monitor", async () => {
    const stop = mockStartedMonitor();
    const { abort, task, isSettled } = startAccountAndTrackLifecycle({
      startAccount: requireStartAccount(),
      account: buildAccount(),
    });
    await expectStopPendingUntilAbort({
      waitForStarted: waitForStartedMocks(hoisted.monitorTwitchProvider),
      isSettled,
      abort,
      task,
      stop,
    });
  });

  it("stops immediately when startAccount receives an already-aborted signal", async () => {
    const stop = mockStartedMonitor();
    const abort = new AbortController();
    abort.abort();

    await startTwitchAccount(abort.signal);

    expect(hoisted.monitorTwitchProvider).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("clears running status when monitor startup fails", async () => {
    hoisted.monitorTwitchProvider.mockRejectedValue(new Error("irc join failed"));
    const patches: ChannelAccountSnapshot[] = [];

    const task = requireStartAccount()(
      createStartAccountContext({
        account: buildAccount(),
        statusPatchSink: (next) => patches.push({ ...next }),
      }),
    );

    await expect(task).rejects.toThrow("irc join failed");
    expectLifecyclePatch(patches, { running: true });
    expectLifecyclePatch(patches, { running: false });
  });

  it("marks the account disconnected on a transport drop while keeping running true", async () => {
    const patches: ChannelAccountSnapshot[] = [];
    hoisted.monitorTwitchProvider.mockImplementation(
      async (options: { statusSink?: (patch: TwitchStatusPatch) => void }) => {
        // Simulate the persistent ChatClient reporting a post-handshake drop.
        options.statusSink?.({ connected: false, lastError: "connection reset" });
        return { stop: vi.fn() };
      },
    );

    const abort = new AbortController();
    const task = requireStartAccount()(
      createStartAccountContext({
        account: buildAccount(),
        abortSignal: abort.signal,
        statusPatchSink: (next) => patches.push({ ...next }),
      }),
    );
    // Let the monitor's synchronous statusSink patch land, then unblock the
    // abort-pending startAccount task.
    await Promise.resolve();
    abort.abort();
    await task;

    // `running` is owned by the monitor lifecycle: the disconnect must not clear
    // it, only the transport `connected` flag (mirrors qqbot #100127).
    expectLifecyclePatch(patches, { running: true, connected: false });
    expectLifecyclePatch(patches, { connected: false, lastError: "connection reset" });
    expect(patches.every((patch) => patch.running !== false)).toBe(true);
  });

  it("surfaces connected in the channel status summary", () => {
    const buildChannelSummary = twitchPlugin.status?.buildChannelSummary;
    if (!buildChannelSummary) {
      throw new Error("Expected Twitch status.buildChannelSummary");
    }

    const summary = buildChannelSummary({
      snapshot: {
        accountId: "default",
        configured: true,
        running: true,
        connected: false,
        lastError: "connection reset",
      },
    } as Parameters<typeof buildChannelSummary>[0]);

    expect(summary).toMatchObject({
      running: true,
      connected: false,
    });
  });
});
