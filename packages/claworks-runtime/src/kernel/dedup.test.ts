import { describe, expect, it, vi } from "vitest";
import { createDedupGuard } from "./dedup.js";

describe("DedupGuard", () => {
  it("returns false for first record", () => {
    const guard = createDedupGuard(1000);
    const key = guard.buildKey("connector", "alarm.created", "diagnose");
    expect(guard.shouldSkip(key)).toBe(false);
    guard.record(key);
    expect(guard.shouldSkip(key)).toBe(true);
  });

  it("expires after window", () => {
    vi.useFakeTimers();
    const guard = createDedupGuard(100);
    const key = guard.buildKey("source", "type", "playbook");
    guard.record(key);
    expect(guard.shouldSkip(key)).toBe(true);
    vi.advanceTimersByTime(200);
    expect(guard.shouldSkip(key)).toBe(false);
    vi.useRealTimers();
  });

  it("different keys are independent", () => {
    const guard = createDedupGuard(60_000);
    const k1 = guard.buildKey("src", "alarm.created", "p1");
    const k2 = guard.buildKey("src", "alarm.created", "p2");
    guard.record(k1);
    expect(guard.shouldSkip(k1)).toBe(true);
    expect(guard.shouldSkip(k2)).toBe(false);
  });
});
