// Telegram tests cover polling liveness plugin behavior.
import { describe, expect, it } from "vitest";
import { TelegramPollingLivenessTracker } from "./polling-liveness.js";

const POLL_STALL_THRESHOLD_MS = 90_000;

describe("TelegramPollingLivenessTracker", () => {
  it("does not treat a wall-clock correction as an active getUpdates stall", () => {
    let wallNow = 1_000;
    let monotonicNow = 0;
    const tracker = new TelegramPollingLivenessTracker({
      now: () => wallNow,
      monotonicNow: () => monotonicNow,
    });

    tracker.noteGetUpdatesStarted({ offset: 7 });

    wallNow += 154_000;
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
      now: () => now,
      monotonicNow: () => now,
    });
    tracker.noteGetUpdatesStarted({ offset: 7 });

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
    tracker.noteGetUpdatesStarted({ offset: 1 });
    now = 80_000;
    tracker.noteGetUpdatesError(new Error("network unavailable"));
    tracker.noteGetUpdatesFinished();
    now = 120_000;
    expect(tracker.detectStall({ thresholdMs: POLL_STALL_THRESHOLD_MS })).toBeNull();
    now = 170_001;
    expect(tracker.detectStall({ thresholdMs: POLL_STALL_THRESHOLD_MS })?.message).toContain(
      "Polling stall detected",
    );
  });
});
