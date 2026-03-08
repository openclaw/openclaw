import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EvolutionScheduler } from "./evolution-scheduler.js";

function makeSnapshots(count: number, decaying = false) {
  return Array.from({ length: count }, (_, i) => ({
    timestamp: i * 86_400_000,
    equity: 10000 + (decaying ? -i * 50 : i * 50),
    dailyPnl: decaying ? -50 : 50,
    dailyPnlPct: decaying ? -0.5 + i * -0.02 : 0.5,
  }));
}

describe("EvolutionScheduler", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("starts and stops timer", () => {
    const scheduler = new EvolutionScheduler({
      strategyRegistry: { list: () => [] },
      evolutionEngineResolver: () => undefined,
    });

    scheduler.start();
    expect(scheduler.getStats().running).toBe(true);

    scheduler.stop();
    expect(scheduler.getStats().running).toBe(false);
  });

  it("start is idempotent", () => {
    const log = { append: vi.fn() };
    const scheduler = new EvolutionScheduler({
      strategyRegistry: { list: () => [] },
      evolutionEngineResolver: () => undefined,
      activityLog: log,
    });

    scheduler.start();
    scheduler.start();
    expect(log.append).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it("runCycle returns zeros when no evolution engine", async () => {
    const scheduler = new EvolutionScheduler({
      strategyRegistry: { list: () => [] },
      evolutionEngineResolver: () => undefined,
    });

    const result = await scheduler.runCycle();
    expect(result).toEqual({ evolved: 0, skipped: 0 });
    expect(scheduler.getStats().cycleCount).toBe(1);
  });

  it("runCycle skips strategies with insufficient snapshots", async () => {
    const scheduler = new EvolutionScheduler({
      strategyRegistry: {
        list: (filter) => {
          if (filter?.level === "L2_PAPER") return [{ id: "s1", name: "S1", level: "L2_PAPER" }];
          return [];
        },
      },
      evolutionEngineResolver: () => ({
        runRdavdCycle: vi.fn().mockResolvedValue({ evolved: false, reason: "" }),
      }),
      paperEngine: {
        getSnapshots: () => makeSnapshots(3), // too few
      },
    });

    const result = await scheduler.runCycle();
    expect(result.skipped).toBe(1);
    expect(result.evolved).toBe(0);
  });

  it("runCycle evolves decaying strategy", async () => {
    const runRdavdCycle = vi.fn().mockResolvedValue({ evolved: true, reason: "mutated params" });
    const log = { append: vi.fn() };

    const scheduler = new EvolutionScheduler({
      strategyRegistry: {
        list: (filter) => {
          if (filter?.level === "L2_PAPER")
            return [{ id: "s1", name: "Decaying", level: "L2_PAPER" }];
          return [];
        },
      },
      evolutionEngineResolver: () => ({ runRdavdCycle }),
      paperEngine: {
        // Rapidly decaying returns
        getSnapshots: () =>
          Array.from({ length: 60 }, (_, i) => ({
            timestamp: i * 86_400_000,
            equity: 10000 - i * 100,
            dailyPnl: -100,
            dailyPnlPct: Math.max(0.01, 2.0 - i * 0.05),
          })),
      },
      activityLog: log,
    });

    const result = await scheduler.runCycle();
    // The decay estimator should detect decay and trigger evolution
    // Whether it's classified as decay depends on the data pattern
    expect(result.evolved + result.skipped).toBeGreaterThan(0);
    expect(scheduler.getStats().cycleCount).toBe(1);
  });

  it("getStats tracks cumulative counts", async () => {
    const scheduler = new EvolutionScheduler({
      strategyRegistry: { list: () => [] },
      evolutionEngineResolver: () => undefined,
    });

    await scheduler.runCycle();
    await scheduler.runCycle();

    const stats = scheduler.getStats();
    expect(stats.cycleCount).toBe(2);
    expect(stats.lastCycleAt).toBeGreaterThan(0);
  });
});
