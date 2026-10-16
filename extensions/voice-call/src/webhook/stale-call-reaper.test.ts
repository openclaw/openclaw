// Voice Call tests cover stale call reaper plugin behavior.
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startStaleCallReaper } from "./stale-call-reaper.js";

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

    expect(
      startStaleCallReaper({
        scheduler: createTestPluginServiceScheduler(),
        manager,
      }),
    ).toBeNull();
    expect(
      startStaleCallReaper({
        scheduler: createTestPluginServiceScheduler(),
        manager,
        staleCallReaperSeconds: 0,
      }),
    ).toBeNull();
  });

  it("reaps stale calls and ignores fresh ones", async () => {
    const endCall = vi.fn(async () => ({ success: true }));
    const manager = {
      getActiveCalls: vi.fn(() => [
        {
          callId: "call-stale",
          startedAt: Date.now() - 61_000,
          state: "active" as const,
        },
        {
          callId: "call-fresh",
          startedAt: Date.now() - 10_000,
          state: "active" as const,
        },
      ]),
      endCall,
    };

    const stop = startStaleCallReaper({
      scheduler: createTestPluginServiceScheduler(),
      manager,
      staleCallReaperSeconds: 60,
    });

    await vi.advanceTimersByTimeAsync(30_000);

    expect(endCall).toHaveBeenCalledTimes(1);
    expect(endCall).toHaveBeenCalledWith("call-stale");

    await stop?.();
  });

  it("does not overlap reaps and retries after settlement", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const firstEndCall = createDeferred<{ success: false; error: string }>();
    const secondEndCall = createDeferred<{ success: true }>();
    const endCall = vi
      .fn()
      .mockImplementationOnce(() => firstEndCall.promise)
      .mockImplementationOnce(() => secondEndCall.promise);
    const manager = {
      getActiveCalls: vi.fn(() => [
        {
          callId: "call-stale",
          startedAt: Date.now() - 61_000,
          state: "active" as const,
        },
      ]),
      endCall,
    };

    const stop = startStaleCallReaper({
      scheduler: createTestPluginServiceScheduler(),
      manager,
      staleCallReaperSeconds: 60,
    });

    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(endCall).toHaveBeenCalledTimes(1);

    firstEndCall.resolve({ success: false, error: "network" });
    await firstEndCall.promise;
    await Promise.resolve();
    expect(warn).toHaveBeenCalledWith("[voice-call] Reaper failed to end call call-stale: network");
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
      secondEndCall.resolve({ success: true });
      await stopping;
    }
    expect(stopped).toBe(true);
  });

  it.each(["speaking", "listening"] as const)(
    "does not reap live %s calls without answeredAt",
    async (state) => {
      const endCall = vi.fn(async () => ({ success: true }));
      const manager = {
        getActiveCalls: vi.fn(() => [
          {
            callId: `call-${state}`,
            startedAt: Date.now() - 120_000,
            state,
          },
        ]),
        endCall,
      };

      const stop = startStaleCallReaper({
        scheduler: createTestPluginServiceScheduler(),
        manager,
        staleCallReaperSeconds: 60,
      });

      await vi.advanceTimersByTimeAsync(30_000);

      expect(endCall).not.toHaveBeenCalled();

      await stop?.();
    },
  );

  it("logs and swallows endCall failures", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const endCallError = new Error("network");
    const endCall = vi.fn(async () => {
      throw endCallError;
    });
    const manager = {
      getActiveCalls: vi.fn(() => [
        {
          callId: "call-stale",
          startedAt: Date.now() - 61_000,
          state: "active" as const,
        },
      ]),
      endCall,
    };

    const stop = startStaleCallReaper({
      scheduler: createTestPluginServiceScheduler(),
      manager,
      staleCallReaperSeconds: 60,
    });

    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.resolve();

    expect(warn).toHaveBeenCalledWith(
      "[voice-call] Reaper failed to end call call-stale:",
      endCallError,
    );

    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.resolve();

    expect(endCall).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(2);

    await stop?.();
  });
});
