vi.mock("ccxt", () => ({}));

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PaperScheduler } from "../../src/paper/paper-scheduler.js";
import type { StrategyDefinition } from "../../src/shared/types.js";

function makeOHLCV(close: number, count = 20) {
  return Array.from({ length: count }, (_, i) => ({
    timestamp: Date.now() - (count - i) * 60_000,
    open: close - 1,
    high: close + 1,
    low: close - 2,
    close,
    volume: 1000,
  }));
}

function makeDefinition(overrides?: Partial<StrategyDefinition>): StrategyDefinition {
  return {
    id: `strat-${Date.now()}`,
    name: "Test Strategy",
    version: "1.0.0",
    markets: ["crypto"],
    symbols: ["BTC/USDT"],
    timeframes: ["1h"],
    parameters: { fast: 10, slow: 20 },
    onBar: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

function makeMockDeps() {
  const paperEngine = {
    listAccounts: vi.fn().mockReturnValue([
      { id: "acct-1", name: "Account 1", equity: 10000 },
      { id: "acct-2", name: "Account 2", equity: 5000 },
    ]),
    getAccountState: vi.fn().mockReturnValue({
      equity: 10000,
      cash: 10000,
      positions: [],
    }),
    submitOrder: vi.fn().mockReturnValue({ id: "order-1", status: "filled" }),
    recordSnapshot: vi.fn(),
  };

  const strategyRegistry = {
    list: vi.fn().mockReturnValue([]),
  };

  const dataProvider = {
    getOHLCV: vi.fn().mockResolvedValue(makeOHLCV(50000)),
  };

  return { paperEngine, strategyRegistry, dataProvider };
}

describe("PaperScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("start() sets tick + snapshot intervals", () => {
    const deps = makeMockDeps();
    const scheduler = new PaperScheduler({
      ...deps,
      tickIntervalMs: 5000,
      snapshotIntervalMs: 10000,
    });

    scheduler.start();
    expect(scheduler.getStats().running).toBe(true);

    // Advance past tick interval — tickAll should fire
    vi.advanceTimersByTime(5000);
    expect(deps.strategyRegistry.list).toHaveBeenCalled();

    scheduler.stop();
  });

  it("stop() clears intervals", () => {
    const deps = makeMockDeps();
    const scheduler = new PaperScheduler({
      ...deps,
      tickIntervalMs: 5000,
      snapshotIntervalMs: 10000,
    });

    scheduler.start();
    expect(scheduler.getStats().running).toBe(true);

    scheduler.stop();
    expect(scheduler.getStats().running).toBe(false);

    // Advance timers — nothing should fire after stop
    deps.strategyRegistry.list.mockClear();
    vi.advanceTimersByTime(20000);
    expect(deps.strategyRegistry.list).not.toHaveBeenCalled();
  });

  it("tickAll() executes all L2_PAPER strategies", async () => {
    const onBar1 = vi.fn().mockResolvedValue(null);
    const onBar2 = vi.fn().mockResolvedValue(null);

    const deps = makeMockDeps();
    deps.strategyRegistry.list.mockReturnValue([
      {
        id: "s1",
        name: "S1",
        level: "L2_PAPER",
        definition: makeDefinition({ id: "s1", onBar: onBar1 }),
      },
      {
        id: "s2",
        name: "S2",
        level: "L2_PAPER",
        definition: makeDefinition({ id: "s2", onBar: onBar2 }),
      },
    ]);

    const scheduler = new PaperScheduler(deps);
    const result = await scheduler.tickAll();

    expect(result.ticked).toBe(2);
    expect(onBar1).toHaveBeenCalledTimes(1);
    expect(onBar2).toHaveBeenCalledTimes(1);
  });

  it("tickAll() skips non-L2 strategies", async () => {
    const onBar = vi.fn().mockResolvedValue(null);

    const deps = makeMockDeps();
    deps.strategyRegistry.list.mockReturnValue([
      {
        id: "s1",
        name: "S1",
        level: "L0_INCUBATE",
        definition: makeDefinition({ id: "s1", onBar }),
      },
      {
        id: "s2",
        name: "S2",
        level: "L1_BACKTEST",
        definition: makeDefinition({ id: "s2", onBar }),
      },
    ]);

    const scheduler = new PaperScheduler(deps);
    const result = await scheduler.tickAll();

    expect(result.ticked).toBe(0);
    expect(onBar).not.toHaveBeenCalled();
  });

  it("tickAll() submits order when signal fires", async () => {
    const deps = makeMockDeps();
    const buySignal = {
      action: "buy" as const,
      symbol: "BTC/USDT",
      sizePct: 10,
      orderType: "market" as const,
      reason: "test buy",
      confidence: 0.8,
    };

    deps.strategyRegistry.list.mockReturnValue([
      {
        id: "s1",
        name: "Buyer",
        level: "L2_PAPER",
        definition: makeDefinition({
          id: "s1",
          onBar: vi.fn().mockResolvedValue(buySignal),
        }),
      },
    ]);

    const scheduler = new PaperScheduler(deps);
    const result = await scheduler.tickAll();

    expect(result.signals).toBe(1);
    expect(deps.paperEngine.submitOrder).toHaveBeenCalledTimes(1);
    expect(deps.paperEngine.submitOrder).toHaveBeenCalledWith(
      "acct-1",
      expect.objectContaining({
        symbol: "BTC/USDT",
        side: "buy",
        type: "market",
        strategyId: "s1",
      }),
      50000,
    );
  });

  it("tickAll() does not submit order when no signal", async () => {
    const deps = makeMockDeps();
    deps.strategyRegistry.list.mockReturnValue([
      {
        id: "s1",
        name: "NoSignal",
        level: "L2_PAPER",
        definition: makeDefinition({ id: "s1", onBar: vi.fn().mockResolvedValue(null) }),
      },
    ]);

    const scheduler = new PaperScheduler(deps);
    const result = await scheduler.tickAll();

    expect(result.signals).toBe(0);
    expect(deps.paperEngine.submitOrder).not.toHaveBeenCalled();
  });

  it("tickAll() single strategy error does not affect others", async () => {
    const onBarGood = vi.fn().mockResolvedValue(null);

    const deps = makeMockDeps();
    deps.strategyRegistry.list.mockReturnValue([
      {
        id: "s-bad",
        name: "Bad",
        level: "L2_PAPER",
        definition: makeDefinition({
          id: "s-bad",
          onBar: vi.fn().mockRejectedValue(new Error("boom")),
        }),
      },
      {
        id: "s-good",
        name: "Good",
        level: "L2_PAPER",
        definition: makeDefinition({ id: "s-good", onBar: onBarGood }),
      },
    ]);

    const scheduler = new PaperScheduler(deps);
    const result = await scheduler.tickAll();

    expect(result.ticked).toBe(2);
    expect(result.errors).toBe(1);
    expect(onBarGood).toHaveBeenCalledTimes(1);
    expect(scheduler.getStats().errorCount).toBe(1);
  });

  it("snapshotAll() records snapshot for all accounts", async () => {
    const deps = makeMockDeps();
    const scheduler = new PaperScheduler(deps);
    const result = await scheduler.snapshotAll();

    expect(result.snapshots).toBe(2);
    expect(deps.paperEngine.recordSnapshot).toHaveBeenCalledTimes(2);
    expect(deps.paperEngine.recordSnapshot).toHaveBeenCalledWith("acct-1");
    expect(deps.paperEngine.recordSnapshot).toHaveBeenCalledWith("acct-2");
  });
});
