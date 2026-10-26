// Telegram tests cover polling liveness plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { TelegramPollingLivenessTracker } from "./polling-liveness.js";

const POLL_STALL_THRESHOLD_MS = 90_000;

afterEach(() => vi.restoreAllMocks());

describe("TelegramPollingLivenessTracker", () => {
  it("does not treat a wall-clock correction as an active getUpdates stall", () => {
    const wallClock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    let monotonicNow = 0;
    const tracker = new TelegramPollingLivenessTracker({
      monotonicNow: () => monotonicNow,
    });

    tracker.noteGetUpdatesStarted({ offset: 7 }, Date.now());

    wallClock.mockReturnValue(155_000);
    monotonicNow += 30_000;

    expect(tracker.detectStall({ thresholdMs: POLL_STALL_THRESHOLD_MS })).toBeNull();

    monotonicNow += POLL_STALL_THRESHOLD_MS - 30_000 + 1;
    const stall = tracker.detectStall({
      thresholdMs: POLL_STALL_THRESHOLD_MS,
    });

    expect(stall?.message).toContain("active getUpdates stuck");
  });

  it("rebases liveness after the watchdog itself was paused", () => {
    let now = 1_000;
    const tracker = new TelegramPollingLivenessTracker({
      monotonicNow: () => now,
    });
    tracker.noteGetUpdatesStarted({ offset: 7 }, now);

    now += 10 * 60 * 60 * 1_000;
    expect(tracker.detectStall({ thresholdMs: POLL_STALL_THRESHOLD_MS })).toBeNull();

    now += 30_000;
    expect(tracker.detectStall({ thresholdMs: POLL_STALL_THRESHOLD_MS })).toBeNull();
    now += 30_000;
    expect(tracker.detectStall({ thresholdMs: POLL_STALL_THRESHOLD_MS })).toBeNull();
    now += 30_001;
    expect(tracker.detectStall({ thresholdMs: POLL_STALL_THRESHOLD_MS })?.message).toContain(
      "active getUpdates stuck",
    );
  });
  it("starts a fresh stall window after a failed poll completes", () => {
    let now = 0;
    const tracker = new TelegramPollingLivenessTracker({ monotonicNow: () => now });
    tracker.noteGetUpdatesStarted({ offset: 1 }, Date.now());
    now = 80_000;
    tracker.noteGetUpdatesError(new Error("network unavailable"), Date.now());
    tracker.noteGetUpdatesFinished();
    now = 120_000;
    expect(tracker.detectStall({ thresholdMs: POLL_STALL_THRESHOLD_MS })).toBeNull();
    now = 170_001;
    expect(tracker.detectStall({ thresholdMs: POLL_STALL_THRESHOLD_MS })?.message).toContain(
      "Polling stall detected",
    );
  });
});
