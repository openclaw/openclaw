import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startStaleCallReaper } from "./stale-call-reaper.js";

type ReaperManager = Parameters<typeof startStaleCallReaper>[0]["manager"];
const staleCall = () => ({
  callId: "call-stale",
  startedAt: Date.now() - 61_000,
  state: "active" as const,
});
function startReaper(
  endCall: ReaperManager["endCall"],
  getActiveCalls: ReaperManager["getActiveCalls"] = () => [staleCall()],
) {
  return startStaleCallReaper({
    scheduler: createTestPluginServiceScheduler(),
    manager: { getActiveCalls, endCall },
    staleCallReaperSeconds: 60,
  });
}

describe("startStaleCallReaper", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-22T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns null when disabled or non-positive", () => {
    const manager = {
      getActiveCalls: vi.fn(() => []),
      endCall: vi.fn(),
    };

    for (const staleCallReaperSeconds of [undefined, 0]) {
      expect(
        startStaleCallReaper({
          scheduler: createTestPluginServiceScheduler(),
          manager,
          staleCallReaperSeconds,
        }),
      ).toBeNull();
    }
  });

  it("reaps stale calls and ignores fresh ones", async () => {
    const endCall = vi.fn(async () => ({ success: true }));
    const stop = startReaper(endCall, () => [
      staleCall(),
      { callId: "call-fresh", startedAt: Date.now() - 10_000, state: "active" },
    ]);

    await vi.advanceTimersByTimeAsync(30_000);

    expect(endCall).toHaveBeenCalledExactlyOnceWith("call-stale");

    await stop?.();
  });

  it.each([false, true])(
    "does not overlap reaps and retries after settlement (throws=%s)",
    async (throws) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const failure = new Error("network");
      const firstEndCall = createDeferred<{ success: false; error: string }>();
      const secondEndCall = createDeferred<{ success: true }>();
      const endCall = vi
        .fn()
        .mockImplementationOnce(() => firstEndCall.promise)
        .mockImplementationOnce(() => secondEndCall.promise);
      const stop = startReaper(endCall);

      await vi.advanceTimersByTimeAsync(30_000);
      await vi.advanceTimersByTimeAsync(30_000);

      expect(endCall).toHaveBeenCalledTimes(1);

      if (throws) {
        firstEndCall.reject(failure);
      } else {
        firstEndCall.resolve({ success: false, error: "network" });
      }
      await firstEndCall.promise.catch(() => {});
      await Promise.resolve();
      expect(warn.mock.calls).toEqual([
        throws
          ? ["[voice-call] Reaper failed to end call call-stale:", failure]
          : ["[voice-call] Reaper failed to end call call-stale: network"],
      ]);
      await vi.advanceTimersByTimeAsync(30_000);

      expect(endCall).toHaveBeenCalledTimes(2);
      expect(endCall).toHaveBeenNthCalledWith(2, "call-stale");

      let stopped = false;
      const stopping = stop?.().then(() => {
        stopped = true;
      });
      try {
        await vi.advanceTimersByTimeAsync(60_000);
        expect(stopped).toBe(false);
        expect(endCall).toHaveBeenCalledTimes(2);
      } finally {
        if (throws) {
          secondEndCall.reject(failure);
        } else {
          secondEndCall.resolve({ success: true });
        }
        await stopping;
      }
      expect(stopped).toBe(true);
      if (throws) {
        expect(warn).toHaveBeenCalledTimes(2);
      }
    },
  );

  it.each(["speaking", "listening"] as const)(
    "does not reap live %s calls without answeredAt",
    async (state) => {
      const endCall = vi.fn(async () => ({ success: true }));
      const stop = startReaper(endCall, () => [
        { callId: `call-${state}`, startedAt: Date.now() - 120_000, state },
      ]);

      await vi.advanceTimersByTimeAsync(30_000);

      expect(endCall).not.toHaveBeenCalled();

      await stop?.();
    },
  );
});
