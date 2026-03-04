vi.mock("ccxt", () => ({}));

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DailyBriefScheduler } from "../../src/core/daily-brief-scheduler.js";

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
  };

  const strategyRegistry = {
    list: vi.fn().mockReturnValue([
      { id: "s1", name: "Alpha", level: "L2_PAPER", lastBacktest: { totalReturn: 0.15 } },
      { id: "s2", name: "Beta", level: "L1_BACKTEST", lastBacktest: { totalReturn: -0.05 } },
      { id: "s3", name: "Gamma", level: "L2_PAPER", lastBacktest: { totalReturn: 0.25 } },
    ]),
  };

  const eventStore = {
    addEvent: vi.fn().mockReturnValue({ id: "evt-1", timestamp: Date.now() }),
  };

  return { paperEngine, strategyRegistry, eventStore };
}

describe("DailyBriefScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("start() sets interval timer", () => {
    const deps = makeMockDeps();
    const scheduler = new DailyBriefScheduler({ ...deps, intervalMs: 5000 });
    scheduler.start();
    expect(scheduler.getStats().running).toBe(true);
    scheduler.stop();
  });

  it("stop() clears interval timer", () => {
    const deps = makeMockDeps();
    const scheduler = new DailyBriefScheduler({ ...deps, intervalMs: 5000 });
    scheduler.start();
    scheduler.stop();
    expect(scheduler.getStats().running).toBe(false);
  });

  it("generateBrief() returns complete DailyBrief structure", async () => {
    const deps = makeMockDeps();
    const scheduler = new DailyBriefScheduler(deps);
    const brief = await scheduler.generateBrief();

    expect(brief.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(brief.marketSummary).toBeTruthy();
    expect(brief.portfolioChange).toHaveProperty("totalEquity");
    expect(brief.portfolioChange).toHaveProperty("dailyPnl");
    expect(brief.portfolioChange).toHaveProperty("dailyPnlPct");
    expect(brief.alerts).toBeInstanceOf(Array);
    expect(brief.recommendation).toBeTruthy();
  });

  it("generateBrief() returns degraded data without paperEngine", async () => {
    const scheduler = new DailyBriefScheduler({});
    const brief = await scheduler.generateBrief();

    expect(brief.portfolioChange.totalEquity).toBe(0);
    expect(brief.topStrategy).toBeUndefined();
    expect(brief.worstStrategy).toBeUndefined();
  });

  it("generateBrief() finds top and worst strategies", async () => {
    const deps = makeMockDeps();
    const scheduler = new DailyBriefScheduler(deps);
    const brief = await scheduler.generateBrief();

    expect(brief.topStrategy?.name).toBe("Gamma"); // 0.25 return
    expect(brief.worstStrategy?.name).toBe("Beta"); // -0.05 return
  });

  it("generateBrief() writes to eventStore", async () => {
    const deps = makeMockDeps();
    const scheduler = new DailyBriefScheduler(deps);
    await scheduler.generateBrief();

    expect(deps.eventStore.addEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "system",
        title: "Daily Brief",
        status: "completed",
      }),
    );
  });

  it("getStats() returns briefCount and lastBriefAt", async () => {
    const deps = makeMockDeps();
    const scheduler = new DailyBriefScheduler(deps);

    expect(scheduler.getStats().briefCount).toBe(0);
    expect(scheduler.getStats().lastBriefAt).toBeNull();

    await scheduler.generateBrief();

    expect(scheduler.getStats().briefCount).toBe(1);
    expect(scheduler.getStats().lastBriefAt).toBeTypeOf("number");
  });
});
