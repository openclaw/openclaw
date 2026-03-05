import { afterEach, describe, it, expect, vi } from "vitest";
import { IdeationScheduler } from "../../src/ideation/ideation-scheduler.js";

function createScheduler(overrides?: {
  symbolCount?: number;
  existingNames?: string[];
  maxConcurrent?: number;
}) {
  const scanFn = vi.fn().mockResolvedValue({
    timestamp: Date.now(),
    symbols: Array.from({ length: overrides?.symbolCount ?? 5 }, (_, i) => ({
      symbol: `SYM${i}`,
      market: "crypto",
      regime: "bull",
      price: 100,
      change24hPct: 1,
      indicators: {
        rsi14: 50,
        sma50: 100,
        sma200: 100,
        macdHistogram: 0,
        bbPosition: 0.5,
        atr14Pct: 2,
      },
    })),
    regimeSummary: {},
    crossMarket: { cryptoBullishPct: 50, equityBullishPct: 50, highVolatilitySymbols: [] },
  });
  const triggerFn = vi.fn();
  const filterFn = vi.fn().mockReturnValue({ accepted: [], rejected: [] });
  const appendFn = vi.fn();

  const scheduler = new IdeationScheduler(
    {
      scanner: { scan: scanFn } as never,
      engine: { triggerIdeation: triggerFn } as never,
      filter: { filter: filterFn } as never,
      activityLog: { append: appendFn } as never,
      existingStrategyNamesResolver: () => overrides?.existingNames ?? [],
      maxConcurrentResolver: () => overrides?.maxConcurrent ?? 20,
    },
    { enabled: true, intervalMs: 1000 },
  );

  return { scheduler, scanFn, triggerFn, filterFn, appendFn };
}

describe("IdeationScheduler", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("start/stop controls the timer", () => {
    const { scheduler } = createScheduler();

    expect(scheduler.getStats().running).toBe(false);

    scheduler.start();
    expect(scheduler.getStats().running).toBe(true);

    scheduler.stop();
    expect(scheduler.getStats().running).toBe(false);
  });

  it("start is idempotent", () => {
    const { scheduler } = createScheduler();
    scheduler.start();
    scheduler.start(); // should not create second timer
    expect(scheduler.getStats().running).toBe(true);
    scheduler.stop();
  });

  it("runCycle scans and triggers ideation", async () => {
    const { scheduler, scanFn, triggerFn, appendFn } = createScheduler({ symbolCount: 3 });

    const result = await scheduler.runCycle();

    expect(scanFn).toHaveBeenCalledOnce();
    expect(triggerFn).toHaveBeenCalledOnce();
    expect(result.snapshot.symbols).toHaveLength(3);
    expect(scheduler.getStats().cycleCount).toBe(1);
    expect(scheduler.getStats().lastCycleAt).not.toBeNull();
    expect(scheduler.getLastResult()).toBe(result);

    // Activity log should have cycle_start and cycle_complete
    const categories = appendFn.mock.calls.map(
      (c: unknown[]) => (c[0] as { action: string }).action,
    );
    expect(categories).toContain("cycle_start");
    expect(categories).toContain("cycle_complete");
  });

  it("skips cycle when strategy count >= maxConcurrent", async () => {
    const { scheduler, scanFn, triggerFn, appendFn } = createScheduler({
      existingNames: Array.from({ length: 20 }, (_, i) => `strat-${i}`),
      maxConcurrent: 20,
    });

    const result = await scheduler.runCycle();

    expect(scanFn).not.toHaveBeenCalled();
    expect(triggerFn).not.toHaveBeenCalled();
    expect(result.created).toHaveLength(0);
    expect(scheduler.getStats().cycleCount).toBe(1);

    const actions = appendFn.mock.calls.map((c: unknown[]) => (c[0] as { action: string }).action);
    expect(actions).toContain("cycle_skip");
  });

  it("handles empty scan result gracefully", async () => {
    const { scheduler, triggerFn, appendFn } = createScheduler({ symbolCount: 0 });

    const result = await scheduler.runCycle();

    expect(triggerFn).not.toHaveBeenCalled();
    expect(result.snapshot.symbols).toHaveLength(0);

    const actions = appendFn.mock.calls.map((c: unknown[]) => (c[0] as { action: string }).action);
    expect(actions).toContain("cycle_empty");
  });

  it("getConfig returns current config", () => {
    const { scheduler } = createScheduler();
    const config = scheduler.getConfig();
    expect(config.enabled).toBe(true);
    expect(config.intervalMs).toBe(1000);
    expect(config.maxStrategiesPerCycle).toBe(3);
  });

  it("does not start when disabled", () => {
    const { scheduler } = createScheduler();
    // Access private config via getConfig to verify
    expect(scheduler.getConfig().enabled).toBe(true);

    // Create a disabled scheduler
    const disabledScheduler = new IdeationScheduler(
      {
        scanner: { scan: vi.fn() } as never,
        engine: { triggerIdeation: vi.fn() } as never,
        filter: { filter: vi.fn() } as never,
        existingStrategyNamesResolver: () => [],
      },
      { enabled: false },
    );

    disabledScheduler.start();
    expect(disabledScheduler.getStats().running).toBe(false);
  });
});
