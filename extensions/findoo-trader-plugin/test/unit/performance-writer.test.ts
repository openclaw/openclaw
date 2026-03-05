import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  PaperScheduler,
  isNewDay,
  type PaperSchedulerConfig,
} from "../../src/paper/paper-scheduler.js";

// Mock indicator-lib to avoid complex imports
vi.mock("../../src/strategy/indicator-lib.js", () => ({
  buildIndicatorLib: vi.fn(() => ({
    sma: () => [],
    ema: () => [],
    rsi: () => [],
    macd: () => ({ macd: [], signal: [], histogram: [] }),
    bollingerBands: () => ({ upper: [], middle: [], lower: [] }),
    atr: () => [],
  })),
}));

function makeMockPaperEngine() {
  return {
    listAccounts: vi.fn(() => [{ id: "acct-1", name: "Default", equity: 10000 }]),
    getAccountState: vi.fn((id: string) => ({
      equity: 10500,
      cash: 5000,
      positions: [
        {
          symbol: "BTC/USDT",
          side: "long",
          quantity: 0.1,
          entryPrice: 50000,
          currentPrice: 52000,
          unrealizedPnl: 200,
          strategyId: "strat-1",
        },
      ],
    })),
    submitOrder: vi.fn(() => ({ id: "ord-1", status: "filled" })),
    recordSnapshot: vi.fn(),
    getSnapshots: vi.fn(() => [
      { timestamp: Date.now(), equity: 10500, dailyPnl: 50, dailyPnlPct: 0.5 },
    ]),
  };
}

function makeMockPerfStore() {
  return {
    addSnapshot: vi.fn(),
    getLatest: vi.fn(() => []),
    getByPeriod: vi.fn(() => []),
    close: vi.fn(),
  };
}

function makeMockStrategyRegistry() {
  return {
    list: vi.fn(() => []),
  };
}

function makeScheduler(overrides?: Partial<PaperSchedulerConfig>) {
  const paperEngine = makeMockPaperEngine();
  const strategyRegistry = makeMockStrategyRegistry();
  const perfStore = makeMockPerfStore();
  const config: PaperSchedulerConfig = {
    paperEngine,
    strategyRegistry,
    perfStore: perfStore as never,
    ...overrides,
  };
  return { scheduler: new PaperScheduler(config), paperEngine, perfStore, strategyRegistry };
}

describe("isNewDay", () => {
  it("returns true when last is null", () => {
    expect(isNewDay(null)).toBe(true);
  });

  it("returns false when same day", () => {
    const now = new Date();
    expect(isNewDay(now)).toBe(false);
  });

  it("returns true when different day", () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    expect(isNewDay(yesterday)).toBe(true);
  });
});

describe("PaperScheduler daily perf snapshot", () => {
  it("writes perf snapshot on first snapshotAll call", async () => {
    const { scheduler, perfStore } = makeScheduler();
    await scheduler.snapshotAll();
    expect(perfStore.addSnapshot).toHaveBeenCalledTimes(1);
    const snap = perfStore.addSnapshot.mock.calls[0]![0];
    expect(snap.periodType).toBe("daily");
    expect(snap.totalPnl).toBe(50);
    expect(snap.bySymbolJson).toContain("BTC/USDT");
  });

  it("skips perf snapshot on same day", async () => {
    const { scheduler, perfStore } = makeScheduler();
    await scheduler.snapshotAll();
    expect(perfStore.addSnapshot).toHaveBeenCalledTimes(1);
    // Second call on same day should not write again
    await scheduler.snapshotAll();
    expect(perfStore.addSnapshot).toHaveBeenCalledTimes(1);
  });

  it("does not write perf snapshot when perfStore is not configured", async () => {
    const { scheduler, paperEngine } = makeScheduler({ perfStore: undefined });
    await scheduler.snapshotAll();
    // recordSnapshot should still be called for accounts
    expect(paperEngine.recordSnapshot).toHaveBeenCalledWith("acct-1");
  });

  it("aggregates correctly with empty accounts", async () => {
    const paperEngine = {
      ...makeMockPaperEngine(),
      listAccounts: vi.fn(() => []),
      getAccountState: vi.fn(() => null),
      getSnapshots: vi.fn(() => []),
    };
    const { scheduler, perfStore } = makeScheduler({ paperEngine });
    await scheduler.snapshotAll();
    // Should still write a snapshot with zero values
    expect(perfStore.addSnapshot).toHaveBeenCalledTimes(1);
    const snap = perfStore.addSnapshot.mock.calls[0]![0];
    expect(snap.totalPnl).toBe(0);
    expect(snap.totalReturn).toBe(0);
  });

  it("includes strategy breakdown in byStrategyJson", async () => {
    const { scheduler, perfStore } = makeScheduler();
    await scheduler.snapshotAll();
    const snap = perfStore.addSnapshot.mock.calls[0]![0];
    expect(snap.byStrategyJson).not.toBeNull();
    const parsed = JSON.parse(snap.byStrategyJson);
    expect(parsed["strat-1"]).toBe(200);
  });
});
