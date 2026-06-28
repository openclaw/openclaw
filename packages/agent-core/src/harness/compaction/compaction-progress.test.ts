import { describe, expect, it } from "vitest";
import {
  compactionMadeProgress,
  CompactionProgressTracker,
  DEFAULT_COMPACTION_TIMEOUT_MS,
  INEFFECTIVE_SAVINGS_THRESHOLD,
  MAX_COMPACTION_PASSES,
  MAX_INEFFECTIVE_COMPRESSIONS,
  PROGRESS_THRESHOLD,
} from "./compaction-progress.js";

// -- Suite A: Progress Detection & Anti-Thrashing --

describe("compactionMadeProgress", () => {
  it("returns true when token reduction exceeds threshold", () => {
    expect(compactionMadeProgress(200000, 100000, 0.05)).toBe(true);
  });

  it("returns false when token reduction is below threshold", () => {
    // 195000 < 200000 * 0.95 = 190000? -> 195000 > 190000 -> false
    expect(compactionMadeProgress(200000, 195000, 0.05)).toBe(false);
  });

  it("returns false when tokens are unchanged", () => {
    expect(compactionMadeProgress(200000, 200000, 0.05)).toBe(false);
  });

  it("returns false when tokens increase", () => {
    expect(compactionMadeProgress(200000, 210000, 0.05)).toBe(false);
  });

  it("returns true at just below the threshold boundary", () => {
    // 189999 < 200000 * 0.95 = 190000 -> true
    expect(compactionMadeProgress(200000, 189999, 0.05)).toBe(true);
  });

  it("returns false at exactly the threshold boundary", () => {
    // 190000 < 190000 -> false (not strictly less)
    expect(compactionMadeProgress(200000, 190000, 0.05)).toBe(false);
  });

  it("handles zero origTokens gracefully", () => {
    expect(compactionMadeProgress(0, 0, 0.05)).toBe(false);
  });

  it("handles origTokens=1 edge case", () => {
    expect(compactionMadeProgress(1, 0, 0.05)).toBe(true);
  });

  it("respects custom threshold of 10%", () => {
    // 91000 < 100000 * 0.90 = 90000? -> 91000 > 90000 -> false
    expect(compactionMadeProgress(100000, 91000, 0.1)).toBe(false);
  });

  it("respects custom threshold of 1%", () => {
    // 98500 < 100000 * 0.99 = 99000? -> 98500 < 99000 -> true
    expect(compactionMadeProgress(100000, 98500, 0.01)).toBe(true);
  });

  it("handles very small origTokens with large threshold", () => {
    // 4 < 10 * 0.50 = 5 -> true
    expect(compactionMadeProgress(10, 4, 0.5)).toBe(true);
  });

  it("returns false when new tokens equal threshold-adjusted value", () => {
    // 950 < 1000 * 0.95 = 950? -> false
    expect(compactionMadeProgress(1000, 950, 0.05)).toBe(false);
  });
});

describe("CompactionProgressTracker", () => {
  it("recordCompaction with effective pass resets counter", () => {
    const tracker = new CompactionProgressTracker();
    tracker.recordCompaction(200000, 100000); // 50% savings
    expect(tracker.getState().consecutiveIneffective).toBe(0);
    expect(tracker.shouldSuppressCompaction()).toBe(false);
  });

  it("recordCompaction with ineffective pass increments counter", () => {
    const tracker = new CompactionProgressTracker();
    tracker.recordCompaction(200000, 195000); // 2.5% savings < 10%
    expect(tracker.getState().consecutiveIneffective).toBe(1);
  });

  it("shouldSuppressCompaction returns true after 2 consecutive ineffective", () => {
    const tracker = new CompactionProgressTracker();
    tracker.recordCompaction(200000, 195000); // 2.5% < 10%
    tracker.recordCompaction(200000, 195000); // 2.5% < 10%
    expect(tracker.shouldSuppressCompaction()).toBe(true);
  });

  it("shouldSuppressCompaction returns false after reset", () => {
    const tracker = new CompactionProgressTracker();
    tracker.recordCompaction(200000, 195000);
    tracker.recordCompaction(200000, 195000);
    expect(tracker.shouldSuppressCompaction()).toBe(true);
    tracker.reset();
    expect(tracker.shouldSuppressCompaction()).toBe(false);
  });

  it("shouldSuppressCompaction returns false after effective pass resets chain", () => {
    const tracker = new CompactionProgressTracker();
    tracker.recordCompaction(200000, 195000); // ineffective
    tracker.recordCompaction(200000, 100000); // effective -> resets counter
    tracker.recordCompaction(200000, 195000); // ineffective (counter=1)
    expect(tracker.shouldSuppressCompaction()).toBe(false);
  });

  it("getState returns correct snapshot", () => {
    const tracker = new CompactionProgressTracker();
    tracker.recordCompaction(200000, 150000); // 25% savings -- effective
    const state = tracker.getState();
    expect(state.totalCompactions).toBe(1);
    expect(state.consecutiveIneffective).toBe(0);
    expect(state.lastSavingsPct).toBeCloseTo(0.25, 5);
  });

  it("reset clears all state", () => {
    const tracker = new CompactionProgressTracker();
    tracker.recordCompaction(200000, 150000);
    tracker.recordCompaction(200000, 195000);
    tracker.reset();
    const state = tracker.getState();
    expect(state.totalCompactions).toBe(0);
    expect(state.consecutiveIneffective).toBe(0);
    expect(state.lastSavingsPct).toBe(0);
  });
});

describe("compaction-progress constants", () => {
  it("MAX_COMPACTION_PASSES is 3", () => {
    expect(MAX_COMPACTION_PASSES).toBe(3);
  });

  it("PROGRESS_THRESHOLD is 0.05", () => {
    expect(PROGRESS_THRESHOLD).toBe(0.05);
  });

  it("INEFFECTIVE_SAVINGS_THRESHOLD is 0.10", () => {
    expect(INEFFECTIVE_SAVINGS_THRESHOLD).toBe(0.1);
  });

  it("MAX_INEFFECTIVE_COMPRESSIONS is 2", () => {
    expect(MAX_INEFFECTIVE_COMPRESSIONS).toBe(2);
  });

  it("DEFAULT_COMPACTION_TIMEOUT_MS is 180_000", () => {
    expect(DEFAULT_COMPACTION_TIMEOUT_MS).toBe(180_000);
  });
});
