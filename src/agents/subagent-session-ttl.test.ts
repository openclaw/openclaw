import { afterEach, describe, expect, it, vi } from "vitest";
import {
  computeSessionMetrics,
  configureSessionTtl,
  identifyCleanupTargets,
  isCompletedExpired,
  isZombie,
  logSessionMetrics,
  resetSessionTtlForTests,
  startPeriodicCleanup,
  stopPeriodicCleanup,
  type SessionRecord,
} from "./subagent-session-ttl.js";

const mockLog = vi.fn();
vi.mock("../runtime.js", () => ({
  defaultRuntime: { log: (...args: unknown[]) => mockLog(...args) },
}));

afterEach(() => {
  resetSessionTtlForTests();
  mockLog.mockClear();
});

const now = 1_700_000_000_000;

function makeRecord(
  overrides: Partial<SessionRecord> & { childSessionKey: string },
): SessionRecord {
  return {
    startedAt: now - 600_000,
    ...overrides,
  };
}

describe("subagent-session-ttl", () => {
  describe("isCompletedExpired", () => {
    it("returns false for sessions without endedAt", () => {
      expect(isCompletedExpired(makeRecord({ childSessionKey: "s1" }), now)).toBe(false);
    });

    it("returns false for recently completed sessions", () => {
      const record = makeRecord({ childSessionKey: "s1", endedAt: now - 60_000 });
      expect(isCompletedExpired(record, now)).toBe(false);
    });

    it("returns true for sessions past TTL", () => {
      const record = makeRecord({ childSessionKey: "s1", endedAt: now - 31 * 60_000 });
      expect(isCompletedExpired(record, now)).toBe(true);
    });

    it("respects custom TTL config", () => {
      configureSessionTtl({ completedTtlMinutes: 5 });
      const record = makeRecord({ childSessionKey: "s1", endedAt: now - 6 * 60_000 });
      expect(isCompletedExpired(record, now)).toBe(true);
    });
  });

  describe("isZombie", () => {
    it("returns false for completed sessions", () => {
      const record = makeRecord({ childSessionKey: "s1", endedAt: now - 60_000 });
      expect(isZombie(record, now)).toBe(false);
    });

    it("returns false for active sessions with recent activity", () => {
      const record = makeRecord({ childSessionKey: "s1", lastActivityAt: now - 60_000 });
      expect(isZombie(record, now)).toBe(false);
    });

    it("returns true for sessions with no activity beyond threshold", () => {
      const record = makeRecord({
        childSessionKey: "s1",
        startedAt: now - 20 * 60_000,
        lastActivityAt: now - 16 * 60_000,
      });
      expect(isZombie(record, now)).toBe(true);
    });

    it("uses startedAt when lastActivityAt is missing", () => {
      const record = makeRecord({
        childSessionKey: "s1",
        startedAt: now - 20 * 60_000,
      });
      expect(isZombie(record, now)).toBe(true);
    });

    it("returns true for sessions with no timestamps", () => {
      const record: SessionRecord = { childSessionKey: "s1" };
      expect(isZombie(record, now)).toBe(true);
    });

    it("respects custom zombie config", () => {
      configureSessionTtl({ zombieInactivityMinutes: 5 });
      const record = makeRecord({
        childSessionKey: "s1",
        lastActivityAt: now - 6 * 60_000,
      });
      expect(isZombie(record, now)).toBe(true);
    });
  });

  describe("computeSessionMetrics", () => {
    it("computes correct metrics for mixed sessions", () => {
      const records: SessionRecord[] = [
        makeRecord({ childSessionKey: "active", lastActivityAt: now - 60_000 }),
        makeRecord({ childSessionKey: "completed", endedAt: now - 5 * 60_000 }),
        makeRecord({ childSessionKey: "expired", endedAt: now - 35 * 60_000 }),
        makeRecord({ childSessionKey: "zombie", startedAt: now - 20 * 60_000 }),
      ];
      const metrics = computeSessionMetrics(records, now);
      expect(metrics.total).toBe(4);
      expect(metrics.active).toBe(1);
      expect(metrics.completed).toBe(2);
      expect(metrics.zombie).toBe(1);
      expect(metrics.expiredCompleted).toBe(1);
    });

    it("handles empty input", () => {
      const metrics = computeSessionMetrics([], now);
      expect(metrics.total).toBe(0);
    });
  });

  describe("identifyCleanupTargets", () => {
    it("identifies expired completed and zombie sessions", () => {
      const records: SessionRecord[] = [
        makeRecord({ childSessionKey: "active", lastActivityAt: now - 60_000 }),
        makeRecord({ childSessionKey: "expired", endedAt: now - 35 * 60_000 }),
        makeRecord({ childSessionKey: "zombie", startedAt: now - 20 * 60_000 }),
      ];
      const result = identifyCleanupTargets(records, now);
      expect(result.expiredSessionKeys).toEqual(["expired"]);
      expect(result.zombieSessionKeys).toEqual(["zombie"]);
      expect(result.metrics.total).toBe(3);
    });
  });

  describe("logSessionMetrics", () => {
    it("logs metrics string", () => {
      logSessionMetrics({ total: 10, active: 5, completed: 3, zombie: 2, expiredCompleted: 1 });
      expect(mockLog).toHaveBeenCalledWith(expect.stringContaining("total=10"));
    });
  });

  describe("periodic cleanup", () => {
    it("starts and stops cleanup timer", () => {
      vi.useFakeTimers();
      const fn = vi.fn();
      startPeriodicCleanup(fn);
      vi.advanceTimersByTime(5 * 60_000);
      expect(fn).toHaveBeenCalledTimes(1);
      stopPeriodicCleanup();
      vi.advanceTimersByTime(5 * 60_000);
      expect(fn).toHaveBeenCalledTimes(1);
      vi.useRealTimers();
    });

    it("respects cleanupIntervalMs config override", () => {
      vi.useFakeTimers();
      configureSessionTtl({ cleanupIntervalMs: 10_000 });
      const fn = vi.fn();
      startPeriodicCleanup(fn);
      vi.advanceTimersByTime(10_000);
      expect(fn).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(10_000);
      expect(fn).toHaveBeenCalledTimes(2);
      stopPeriodicCleanup();
      vi.useRealTimers();
    });

    it("catches errors from cleanupFn without unhandled rejection", () => {
      vi.useFakeTimers();
      const fn = vi.fn().mockRejectedValue(new Error("cleanup boom"));
      startPeriodicCleanup(fn);
      // Should not throw
      vi.advanceTimersByTime(5 * 60_000);
      expect(fn).toHaveBeenCalledTimes(1);
      stopPeriodicCleanup();
      vi.useRealTimers();
    });

    it("does not start multiple timers", () => {
      vi.useFakeTimers();
      const fn = vi.fn();
      startPeriodicCleanup(fn);
      startPeriodicCleanup(fn);
      vi.advanceTimersByTime(5 * 60_000);
      expect(fn).toHaveBeenCalledTimes(1);
      stopPeriodicCleanup();
      vi.useRealTimers();
    });
  });
});
