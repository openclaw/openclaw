import { describe, expect, it, vi } from "vitest";
import { DailyBriefGenerator, type BriefDataSource } from "./daily-brief.js";

// ── Test helpers ──

function makeDataSource(overrides?: Partial<BriefDataSource>): BriefDataSource {
  return {
    getRecentEvents: vi.fn().mockResolvedValue([]),
    getPortfolioSummary: vi.fn().mockResolvedValue(null),
    getStrategies: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function makeEvents(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `evt-${i}`,
    type: i === 0 ? "emergency_stop" : "trade_executed",
    title: `Event ${i}`,
    detail: `Detail ${i}`,
    timestamp: Date.now() - (count - i) * 1000,
    status: "completed" as const,
  }));
}

describe("DailyBriefGenerator", () => {
  // ── generate() — full data ──

  it("produces brief with full data (events, portfolio, strategies, markets)", async () => {
    const events = makeEvents(3);
    const ds = makeDataSource({
      getRecentEvents: vi.fn().mockResolvedValue(events),
      getPortfolioSummary: vi.fn().mockResolvedValue({ totalEquity: 10000, dailyPnl: 250 }),
      getStrategies: vi.fn().mockResolvedValue([
        { name: "MomentumAlpha", level: "L2_PAPER", status: "running", pnl: 120 },
        { name: "MeanRevert", level: "L1_BACKTEST", status: "idle", pnl: -30 },
      ]),
    });

    const gen = new DailyBriefGenerator(ds);
    const brief = await gen.generate();

    expect(brief.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(brief.portfolio.totalEquity).toBe(10000);
    expect(brief.portfolio.dailyPnl).toBe(250);
    expect(brief.topEvents).toHaveLength(3);
    expect(brief.strategyHighlights).toHaveLength(2);
    expect(brief.marketStatus).toHaveLength(4);
    expect(brief.generatedAt).toBeGreaterThan(0);
    expect(brief.summary).toContain("$10,000");
    // content field includes summary + strategy info for dashboard rendering
    expect(brief.content).toContain("$10,000");
    expect(brief.content).toContain("MomentumAlpha");
  });

  // ── generate() — fallback when no data ──

  it("produces fallback brief when no data available", async () => {
    const ds = makeDataSource();
    const gen = new DailyBriefGenerator(ds);
    const brief = await gen.generate();

    expect(brief.portfolio.totalEquity).toBe(0);
    expect(brief.portfolio.dailyPnl).toBe(0);
    expect(brief.portfolio.dailyPnlPct).toBe(0);
    expect(brief.topEvents).toHaveLength(0);
    expect(brief.strategyHighlights).toHaveLength(0);
    expect(brief.summary).toContain("No portfolio data available");
    expect(brief.content).toContain("No portfolio data available");
  });

  // ── generate() — market status ──

  it("includes correct market status for all 4 markets", async () => {
    const ds = makeDataSource();
    const gen = new DailyBriefGenerator(ds);
    const brief = await gen.generate();

    const markets = brief.marketStatus.map((m) => m.market);
    expect(markets).toContain("crypto");
    expect(markets).toContain("us-equity");
    expect(markets).toContain("hk-equity");
    expect(markets).toContain("cn-a-share");

    // Crypto is always open
    const crypto = brief.marketStatus.find((m) => m.market === "crypto");
    expect(crypto?.isOpen).toBe(true);
  });

  // ── generate() — limits topEvents to 5 ──

  it("limits topEvents to 5 most recent", async () => {
    const events = makeEvents(10);
    const ds = makeDataSource({
      getRecentEvents: vi.fn().mockResolvedValue(events),
    });

    const gen = new DailyBriefGenerator(ds);
    const brief = await gen.generate();

    expect(brief.topEvents).toHaveLength(5);
    // Should be the 5 most recent (highest timestamps)
    expect(brief.topEvents[0]!.title).toBe("Event 9");
    expect(brief.topEvents[4]!.title).toBe("Event 5");
  });

  // ── generate() — dailyPnlPct calculation ──

  it("calculates dailyPnlPct correctly", async () => {
    const ds = makeDataSource({
      getPortfolioSummary: vi.fn().mockResolvedValue({ totalEquity: 10500, dailyPnl: 500 }),
    });

    const gen = new DailyBriefGenerator(ds);
    const brief = await gen.generate();

    // pnlPct = pnl / (equity - pnl) * 100 = 500 / (10500 - 500) * 100 = 5%
    expect(brief.portfolio.dailyPnlPct).toBeCloseTo(5.0, 1);
  });

  // ── generate() — empty strategies ──

  it("handles empty strategy list", async () => {
    const ds = makeDataSource({
      getPortfolioSummary: vi.fn().mockResolvedValue({ totalEquity: 5000, dailyPnl: 100 }),
      getStrategies: vi.fn().mockResolvedValue([]),
    });

    const gen = new DailyBriefGenerator(ds);
    const brief = await gen.generate();

    expect(brief.strategyHighlights).toHaveLength(0);
    expect(brief.summary).toContain("0 strategies");
  });

  // ── generate() — empty events ──

  it("handles empty event list", async () => {
    const ds = makeDataSource({
      getRecentEvents: vi.fn().mockResolvedValue([]),
      getPortfolioSummary: vi.fn().mockResolvedValue({ totalEquity: 5000, dailyPnl: 0 }),
    });

    const gen = new DailyBriefGenerator(ds);
    const brief = await gen.generate();

    expect(brief.topEvents).toHaveLength(0);
    expect(brief.summary).toContain("0 pending events");
  });

  // ── generate() — risk alerts ──

  it("generates risk alert when emergency_stop event exists", async () => {
    const events = [
      {
        id: "evt-1",
        type: "emergency_stop",
        title: "Emergency Stop Triggered",
        detail: "Circuit breaker hit",
        timestamp: Date.now(),
        status: "completed" as const,
      },
    ];
    const ds = makeDataSource({
      getRecentEvents: vi.fn().mockResolvedValue(events),
      getPortfolioSummary: vi.fn().mockResolvedValue({ totalEquity: 8000, dailyPnl: -600 }),
    });

    const gen = new DailyBriefGenerator(ds);
    const brief = await gen.generate();

    expect(brief.riskAlerts.length).toBeGreaterThan(0);
    expect(brief.riskAlerts.some((a) => a.includes("emergency"))).toBe(true);
  });

  // ── getCachedBrief() — null before generate ──

  it("returns null when no brief generated yet", () => {
    const ds = makeDataSource();
    const gen = new DailyBriefGenerator(ds);

    expect(gen.getCachedBrief()).toBeNull();
  });

  // ── getCachedBrief() — returns last generated ──

  it("returns last generated brief", async () => {
    const ds = makeDataSource({
      getPortfolioSummary: vi.fn().mockResolvedValue({ totalEquity: 7500, dailyPnl: 150 }),
    });
    const gen = new DailyBriefGenerator(ds);

    const brief = await gen.generate();
    const cached = gen.getCachedBrief();

    expect(cached).not.toBeNull();
    expect(cached).toBe(brief);
    expect(cached!.portfolio.totalEquity).toBe(7500);
  });
});
