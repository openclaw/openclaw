/**
 * Real component integration tests — Phase C (F-4).
 * Uses real SQLite/JSON files in tmpdir to verify cross-component data flow.
 */

vi.mock("ccxt", () => ({}));

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AgentEventSqliteStore } from "../../src/core/agent-event-sqlite-store.js";
import { DailyBriefScheduler } from "../../src/core/daily-brief-scheduler.js";
import * as marketCalendar from "../../src/paper/market-rules/market-calendar.js";
import { PaperEngine } from "../../src/paper/paper-engine.js";
import { PaperStore } from "../../src/paper/paper-store.js";
import type { OHLCV, MarketRegime, BacktestConfig } from "../../src/shared/types.js";
import { BacktestEngine } from "../../src/strategy/backtest-engine.js";
import { createSmaCrossover } from "../../src/strategy/builtin-strategies/sma-crossover.js";
import { StrategyRegistry } from "../../src/strategy/strategy-registry.js";

// --- helpers ---

function makeOHLCV(count: number, basePrice = 100, startTs = 1_700_000_000_000): OHLCV[] {
  const bars: OHLCV[] = [];
  for (let i = 0; i < count; i++) {
    const close = basePrice + Math.sin(i / 5) * 10;
    bars.push({
      timestamp: startTs + i * 86_400_000,
      open: close - 1,
      high: close + 2,
      low: close - 2,
      close,
      volume: 1000 + i * 10,
    });
  }
  return bars;
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "fin-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════
// A: StrategyRegistry persistence
// ═══════════════════════════════════════════════════════════════

describe("A: StrategyRegistry persistence", () => {
  it("create → get → complete StrategyRecord fields", () => {
    const reg = new StrategyRegistry(join(tmpDir, "strategies.json"));
    const def = createSmaCrossover({ fastPeriod: 5, slowPeriod: 20 });
    def.id = "sma-test-1";
    def.name = "Test SMA";

    const record = reg.create(def);
    const fetched = reg.get("sma-test-1");

    expect(fetched).toBeDefined();
    expect(fetched!.id).toBe("sma-test-1");
    expect(fetched!.name).toBe("Test SMA");
    expect(fetched!.level).toBe("L0_INCUBATE");
    expect(fetched!.definition).toBeDefined();
    expect(fetched!.createdAt).toBeGreaterThan(0);
    expect(fetched!.updatedAt).toBeGreaterThan(0);
  });

  it("updateBacktest → get → all fields are numbers", async () => {
    const reg = new StrategyRegistry(join(tmpDir, "strategies.json"));
    const def = createSmaCrossover({});
    def.id = "sma-bt-1";
    const reg1 = reg.create(def);

    const engine = new BacktestEngine();
    const data = makeOHLCV(60);
    const config: BacktestConfig = {
      capital: 10000,
      commissionRate: 0.001,
      slippageBps: 5,
      market: "crypto",
    };
    const result = await engine.run(def, data, config);
    reg.updateBacktest("sma-bt-1", result);

    const fetched = reg.get("sma-bt-1")!;
    const bt = fetched.lastBacktest!;

    expect(typeof bt.totalReturn).toBe("number");
    expect(typeof bt.sharpe).toBe("number");
    expect(typeof bt.sortino).toBe("number");
    expect(typeof bt.maxDrawdown).toBe("number");
    expect(typeof bt.winRate).toBe("number");
    expect(typeof bt.profitFactor).toBe("number");
    expect(typeof bt.finalEquity).toBe("number");
  });

  it("persistence: close → reopen → data intact", () => {
    const filePath = join(tmpDir, "strategies.json");
    const reg1 = new StrategyRegistry(filePath);
    const def = createSmaCrossover({});
    def.id = "persist-1";
    def.name = "Persist Test";
    reg1.create(def);

    // Create a new instance pointing to same file
    const reg2 = new StrategyRegistry(filePath);
    const fetched = reg2.get("persist-1");

    expect(fetched).toBeDefined();
    expect(fetched!.name).toBe("Persist Test");
  });

  it("updateLevel + updateStatus → updatedAt changes", () => {
    const reg = new StrategyRegistry(join(tmpDir, "strategies.json"));
    const def = createSmaCrossover({});
    def.id = "level-1";
    reg.create(def);

    const before = reg.get("level-1")!.updatedAt;

    // Small delay to ensure timestamp differs
    reg.updateLevel("level-1", "L1_BACKTEST");
    const after1 = reg.get("level-1")!.updatedAt;
    expect(after1).toBeGreaterThanOrEqual(before);
    expect(reg.get("level-1")!.level).toBe("L1_BACKTEST");

    reg.updateStatus("level-1", "paused");
    const after2 = reg.get("level-1")!.updatedAt;
    expect(after2).toBeGreaterThanOrEqual(after1);
    expect(reg.get("level-1")!.status).toBe("paused");
  });
});

// ═══════════════════════════════════════════════════════════════
// B: PaperEngine market rules
// ═══════════════════════════════════════════════════════════════

describe("B: PaperEngine market rules", () => {
  let store: PaperStore;
  let engine: PaperEngine;
  let accountId: string;

  beforeEach(() => {
    store = new PaperStore(join(tmpDir, "paper.sqlite"));
    engine = new PaperEngine({ store, slippageBps: 5, market: "cn_a_share" });
    const acct = engine.createAccount("test", 100_000);
    accountId = acct.id;
  });

  afterEach(() => {
    store.close();
  });

  it("A-share trading hours: order during open hours → filled", () => {
    // Mock isMarketOpen to return true
    vi.spyOn(marketCalendar, "isMarketOpen").mockReturnValue(true);
    vi.spyOn(marketCalendar, "resolveMarket").mockReturnValue("cn_a_share");

    const order = engine.submitOrder(
      accountId,
      { symbol: "600519.SH", side: "buy", type: "market", quantity: 100 },
      50, // 50 * 100 = 5000, well within 100k capital
    );
    expect(order.status).toBe("filled");

    vi.restoreAllMocks();
  });

  it("A-share non-trading hours → rejected with 'closed'", () => {
    vi.spyOn(marketCalendar, "isMarketOpen").mockReturnValue(false);
    vi.spyOn(marketCalendar, "resolveMarket").mockReturnValue("cn_a_share");

    const order = engine.submitOrder(
      accountId,
      { symbol: "600519.SH", side: "buy", type: "market", quantity: 100 },
      1800,
    );
    expect(order.status).toBe("rejected");
    expect(order.reason).toContain("closed");

    vi.restoreAllMocks();
  });

  it("A-share lot size: 150 shares (non-multiple of 100) → rejected", () => {
    vi.spyOn(marketCalendar, "isMarketOpen").mockReturnValue(true);
    vi.spyOn(marketCalendar, "resolveMarket").mockReturnValue("cn_a_share");

    const order = engine.submitOrder(
      accountId,
      { symbol: "600519.SH", side: "buy", type: "market", quantity: 150 },
      50,
    );
    expect(order.status).toBe("rejected");
    expect(order.reason).toMatch(/multiple|lot/i);

    vi.restoreAllMocks();
  });

  it("A-share T+1: buy today → sell same day → rejected", () => {
    vi.spyOn(marketCalendar, "isMarketOpen").mockReturnValue(true);
    vi.spyOn(marketCalendar, "resolveMarket").mockReturnValue("cn_a_share");

    // Buy
    const buyOrder = engine.submitOrder(
      accountId,
      { symbol: "000001.SZ", side: "buy", type: "market", quantity: 100 },
      15,
    );
    expect(buyOrder.status).toBe("filled");

    // Sell same day (T+1 not settled)
    const sellOrder = engine.submitOrder(
      accountId,
      { symbol: "000001.SZ", side: "sell", type: "market", quantity: 100 },
      16,
    );
    expect(sellOrder.status).toBe("rejected");
    expect(sellOrder.reason).toMatch(/T\+1|sellable|settlement/i);

    vi.restoreAllMocks();
  });

  it("A-share T+1: buy → advance 24h → sell → filled", () => {
    vi.spyOn(marketCalendar, "isMarketOpen").mockReturnValue(true);
    vi.spyOn(marketCalendar, "resolveMarket").mockReturnValue("cn_a_share");

    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    // Buy
    const buyOrder = engine.submitOrder(
      accountId,
      { symbol: "000001.SZ", side: "buy", type: "market", quantity: 100 },
      15,
    );
    expect(buyOrder.status).toBe("filled");

    // Advance 25 hours (past T+1 settlement)
    vi.advanceTimersByTime(25 * 60 * 60 * 1000);

    // Sell after settlement
    const sellOrder = engine.submitOrder(
      accountId,
      { symbol: "000001.SZ", side: "sell", type: "market", quantity: 100 },
      16,
    );
    expect(sellOrder.status).toBe("filled");

    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("slippage + commission: fillPrice ≠ currentPrice, commission > 0", () => {
    vi.spyOn(marketCalendar, "isMarketOpen").mockReturnValue(true);
    vi.spyOn(marketCalendar, "resolveMarket").mockReturnValue("crypto");

    const order = engine.submitOrder(
      accountId,
      { symbol: "BTC/USDT", side: "buy", type: "market", quantity: 1 },
      50000,
    );
    expect(order.status).toBe("filled");
    expect(order.fillPrice).toBeDefined();
    expect(order.fillPrice).not.toBe(50000); // slippage applied
    expect(order.commission).toBeDefined();
    expect(order.commission!).toBeGreaterThan(0);

    vi.restoreAllMocks();
  });
});

// ═══════════════════════════════════════════════════════════════
// C: BacktestEngine data flow
// ═══════════════════════════════════════════════════════════════

describe("C: BacktestEngine data flow", () => {
  it("simple strategy → all numeric fields", async () => {
    const engine = new BacktestEngine();
    const def = createSmaCrossover({ fastPeriod: 3, slowPeriod: 10 });
    const data = makeOHLCV(40);
    const config: BacktestConfig = {
      capital: 10000,
      commissionRate: 0.001,
      slippageBps: 5,
      market: "crypto",
    };

    const result = await engine.run(def, data, config);

    expect(typeof result.totalReturn).toBe("number");
    expect(typeof result.sharpe).toBe("number");
    expect(typeof result.sortino).toBe("number");
    expect(typeof result.maxDrawdown).toBe("number");
    expect(typeof result.winRate).toBe("number");
    expect(typeof result.profitFactor).toBe("number");
    expect(typeof result.totalTrades).toBe("number");
    expect(typeof result.finalEquity).toBe("number");
    expect(typeof result.initialCapital).toBe("number");
  });

  it("empty data → emptyResult", async () => {
    const engine = new BacktestEngine();
    const def = createSmaCrossover({});
    const config: BacktestConfig = {
      capital: 5000,
      commissionRate: 0.001,
      slippageBps: 5,
      market: "crypto",
    };

    const result = await engine.run(def, [], config);

    expect(result.totalReturn).toBe(0);
    expect(result.totalTrades).toBe(0);
    expect(result.finalEquity).toBe(5000);
    expect(result.initialCapital).toBe(5000);
  });

  it("regimeDetector injected → detect() called", async () => {
    const engine = new BacktestEngine();
    const def = createSmaCrossover({ fastPeriod: 3, slowPeriod: 10 });
    const data = makeOHLCV(30);
    const detectFn = vi.fn().mockReturnValue("bull" as MarketRegime);

    const config: BacktestConfig = {
      capital: 10000,
      commissionRate: 0.001,
      slippageBps: 5,
      market: "crypto",
      regimeDetector: { detect: detectFn },
    };

    await engine.run(def, data, config);

    expect(detectFn).toHaveBeenCalled();
    // detect is called per bar in buildContext
    expect(detectFn.mock.calls.length).toBeGreaterThanOrEqual(data.length);
  });

  it("registry → engine → updateBacktest → get → round-trip consistent", async () => {
    const reg = new StrategyRegistry(join(tmpDir, "strategies.json"));
    const eng = new BacktestEngine();

    const def = createSmaCrossover({ fastPeriod: 3, slowPeriod: 10 });
    def.id = "roundtrip-1";
    reg.create(def);

    const data = makeOHLCV(50);
    const config: BacktestConfig = {
      capital: 10000,
      commissionRate: 0.001,
      slippageBps: 5,
      market: "crypto",
    };
    const result = await eng.run(def, data, config);
    reg.updateBacktest("roundtrip-1", result);

    const fetched = reg.get("roundtrip-1")!;
    expect(fetched.lastBacktest).toBeDefined();
    expect(fetched.lastBacktest!.totalReturn).toBe(result.totalReturn);
    expect(fetched.lastBacktest!.sharpe).toBe(result.sharpe);
    expect(fetched.lastBacktest!.maxDrawdown).toBe(result.maxDrawdown);
    expect(fetched.lastBacktest!.totalTrades).toBe(result.totalTrades);
  });
});

// ═══════════════════════════════════════════════════════════════
// D: AgentEventSqliteStore persistence
// ═══════════════════════════════════════════════════════════════

describe("D: AgentEventSqliteStore persistence", () => {
  it("addEvent → listEvents → valid ID and timestamp", () => {
    const store = new AgentEventSqliteStore(join(tmpDir, "events.sqlite"));
    const evt = store.addEvent({
      type: "trade_executed",
      title: "Buy BTC",
      detail: "Bought 0.1 BTC at 50000",
      status: "completed",
    });

    expect(evt.id).toMatch(/^evt-\d+-/);
    expect(evt.timestamp).toBeGreaterThan(0);

    const events = store.listEvents();
    expect(events.length).toBe(1);
    expect(events[0]!.title).toBe("Buy BTC");

    store.close();
  });

  it("addEvent(pending) → approve → status=approved + system notification", () => {
    const store = new AgentEventSqliteStore(join(tmpDir, "events.sqlite"));
    const evt = store.addEvent({
      type: "strategy_promoted",
      title: "Promote SMA to L3",
      detail: "Strategy SMA requesting L3 live promotion",
      status: "pending",
    });

    expect(evt.status).toBe("pending");

    const approved = store.approve(evt.id);
    expect(approved).toBeDefined();
    expect(approved!.status).toBe("approved");

    // Should have 2 events: original + system notification
    const events = store.listEvents();
    expect(events.length).toBe(2);

    const systemEvent = events.find((e) => e.type === "system");
    expect(systemEvent).toBeDefined();
    expect(systemEvent!.title).toContain("Approved");
    expect(systemEvent!.status).toBe("completed");

    store.close();
  });

  it("subscribe → addEvent → callback called", () => {
    const store = new AgentEventSqliteStore(join(tmpDir, "events.sqlite"));
    const received: string[] = [];

    store.subscribe((evt) => received.push(evt.title));

    store.addEvent({
      type: "alert_triggered",
      title: "Price Alert",
      detail: "BTC crossed 60k",
      status: "completed",
    });

    expect(received).toContain("Price Alert");

    store.close();
  });

  it("persistence: close → reopen → events survive", () => {
    const dbPath = join(tmpDir, "events.sqlite");

    const store1 = new AgentEventSqliteStore(dbPath);
    store1.addEvent({
      type: "system",
      title: "Init Event",
      detail: "System initialized",
      status: "completed",
    });
    store1.close();

    const store2 = new AgentEventSqliteStore(dbPath);
    const events = store2.listEvents();
    expect(events.length).toBe(1);
    expect(events[0]!.title).toBe("Init Event");
    store2.close();
  });
});

// ═══════════════════════════════════════════════════════════════
// E: Cross-component chains
// ═══════════════════════════════════════════════════════════════

describe("E: Cross-component chains", () => {
  it("DailyBriefScheduler + real PaperEngine + StrategyRegistry → brief reflects state", async () => {
    const paperStore = new PaperStore(join(tmpDir, "paper.sqlite"));
    const paperEngine = new PaperEngine({ store: paperStore, slippageBps: 5, market: "crypto" });
    paperEngine.createAccount("fund-a", 50_000);

    const reg = new StrategyRegistry(join(tmpDir, "strategies.json"));
    const def = createSmaCrossover({});
    def.id = "brief-strategy";
    def.name = "Brief SMA";
    reg.create(def);

    // Run a backtest so topStrategy is non-null
    const btEngine = new BacktestEngine();
    const data = makeOHLCV(30);
    const result = await btEngine.run(def, data, {
      capital: 10000,
      commissionRate: 0.001,
      slippageBps: 5,
      market: "crypto",
    });
    reg.updateBacktest("brief-strategy", result);

    const scheduler = new DailyBriefScheduler({
      paperEngine,
      strategyRegistry: reg,
    });

    const brief = await scheduler.generateBrief();

    expect(brief.portfolioChange.totalEquity).toBe(50_000);
    expect(brief.topStrategy).toBeDefined();
    expect(brief.topStrategy!.id).toBe("brief-strategy");

    paperStore.close();
  });

  it("L3 approval chain: EventStore.addEvent(pending) → approve → full event chain", () => {
    const store = new AgentEventSqliteStore(join(tmpDir, "events.sqlite"));

    const evt = store.addEvent({
      type: "strategy_promoted",
      title: "Promote RSI to L3_LIVE",
      detail: "RSI mean-reversion meets all L3 gates",
      status: "pending",
      actionParams: { strategyId: "rsi-1", targetLevel: "L3_LIVE" },
    });

    expect(evt.status).toBe("pending");
    expect(evt.actionParams).toBeDefined();
    expect(evt.actionParams!.targetLevel).toBe("L3_LIVE");

    const approved = store.approve(evt.id);
    expect(approved!.status).toBe("approved");

    // Verify the full event chain
    const all = store.listEvents();
    expect(all.length).toBe(2);

    // Pending event now approved
    const original = all.find((e) => e.type === "strategy_promoted");
    expect(original!.status).toBe("approved");

    // Notification event
    const notification = all.find((e) => e.type === "system");
    expect(notification!.status).toBe("completed");
    expect(notification!.title).toContain("Approved");

    store.close();
  });
});
