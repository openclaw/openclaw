/**
 * Scenario A: Real market data flow
 *
 * Tests: real OHLCV → real indicators → real signals → real paper orders
 * Gate: LIVE=1
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OHLCV, StrategyContext, Signal } from "../../../src/shared/types.js";
import { createSmaCrossover } from "../../../src/strategy/builtin-strategies/sma-crossover.js";
import { buildIndicatorLib } from "../../../src/strategy/indicator-lib.js";
import {
  LIVE,
  createLiveChainServer,
  parseResult,
  retry,
  type LiveChainContext,
  type ToolMap,
} from "./live-harness.js";

describe.skipIf(!LIVE)("Scenario A: Real Market Data Flow", { timeout: 120_000 }, () => {
  let ctx: LiveChainContext;
  let tools: ToolMap;
  let dataProvider: {
    getOHLCV: (params: {
      symbol: string;
      market: string;
      timeframe: string;
      limit?: number;
    }) => Promise<OHLCV[]>;
    getTicker: (
      symbol: string,
      market: string,
    ) => Promise<{ symbol: string; market: string; last: number; timestamp: number }>;
  };

  beforeAll(async () => {
    ctx = await createLiveChainServer();
    tools = ctx.tools;
    dataProvider = ctx.services.dataProvider as typeof dataProvider;
  });

  afterAll(() => {
    ctx?.cleanup();
  });

  it("A.1 — Real OHLCV fetch from DataHub", async () => {
    const ohlcv = await retry(() =>
      dataProvider.getOHLCV({
        symbol: "600519.SH",
        market: "equity",
        timeframe: "1d",
        limit: 200,
      }),
    );

    expect(ohlcv.length).toBeGreaterThan(100);

    const bar = ohlcv[0]!;
    expect(typeof bar.timestamp).toBe("number");
    expect(bar.timestamp).toBeGreaterThan(0);
    expect(typeof bar.open).toBe("number");
    expect(typeof bar.close).toBe("number");
    expect(bar.high).toBeGreaterThanOrEqual(bar.low);
    expect(bar.close).toBeGreaterThan(100);
  }, 30_000);

  it("A.2 — Real indicator computation (SMA/RSI/MACD non-NaN)", async () => {
    const ohlcv = await retry(() =>
      dataProvider.getOHLCV({
        symbol: "600519.SH",
        market: "equity",
        timeframe: "1d",
        limit: 200,
      }),
    );

    const indicators = buildIndicatorLib(ohlcv);

    const sma20 = indicators.sma(20);
    expect(sma20.length).toBe(ohlcv.length);
    const lastSma = sma20[sma20.length - 1]!;
    expect(Number.isNaN(lastSma)).toBe(false);
    expect(lastSma).toBeGreaterThan(0);

    const rsi14 = indicators.rsi(14);
    const lastRsi = rsi14[rsi14.length - 1]!;
    expect(Number.isNaN(lastRsi)).toBe(false);
    expect(lastRsi).toBeGreaterThan(0);
    expect(lastRsi).toBeLessThan(100);

    const macdResult = indicators.macd();
    const lastMacd = macdResult.macd[macdResult.macd.length - 1]!;
    expect(Number.isNaN(lastMacd)).toBe(false);
  }, 30_000);

  it("A.3 — Real onBar() signal (sma-crossover with real data)", async () => {
    const ohlcv = await retry(() =>
      dataProvider.getOHLCV({
        symbol: "600519.SH",
        market: "equity",
        timeframe: "1d",
        limit: 200,
      }),
    );

    const strategy = createSmaCrossover({ symbol: "600519.SH" });
    const latestBar = ohlcv[ohlcv.length - 1]!;
    const indicators = buildIndicatorLib(ohlcv);

    const stratCtx: StrategyContext = {
      portfolio: { equity: 10000, cash: 10000, positions: [] },
      history: ohlcv,
      indicators,
      regime: "sideways",
      memory: new Map(),
      log: () => {},
    };

    const signal: Signal | null = await strategy.onBar(latestBar, stratCtx);
    // Signal may be null (no crossover right now) — both are valid
    if (signal) {
      expect(["buy", "sell", "close"]).toContain(signal.action);
      expect(signal.confidence).toBeGreaterThan(0);
      expect(signal.confidence).toBeLessThanOrEqual(1);
      expect(signal.reason).toBeTruthy();
      expect(signal.reason).toMatch(/\d+\.\d+/);
    }
    // Test passes either way — no crash with real data
    expect(true).toBe(true);
  }, 30_000);

  it("A.4 — fin_strategy_tick dryRun with real data", async () => {
    // Seed a strategy at L2_PAPER — must use markets: ["equity"] first
    // so fin_strategy_tick picks equity provider (tushare) not crypto (binance)
    const base = createSmaCrossover({ symbol: "600519.SH" });
    const strategy = { ...base, markets: ["equity" as const] };
    ctx.services.strategyRegistry.create(strategy);
    ctx.services.strategyRegistry.updateLevel("sma-crossover", "L2_PAPER");

    ctx.services.paperEngine.createAccount("live-paper", 10000);

    const tool = tools.get("fin_strategy_tick")!;
    // Retry since DataHub may 502 transiently
    const result = await retry(async () => {
      const r = parseResult(
        await tool.execute("a4", { strategyId: "sma-crossover", dryRun: true }),
      );
      if ((r.ticked as number) === 0 && (r.errors as string[])?.length > 0) {
        throw new Error(`DataHub transient: ${(r.errors as string[]).join(", ")}`);
      }
      return r;
    });

    expect(result.ticked).toBe(1);
    expect(result.dryRun).toBe(true);
    expect(Array.isArray(result.signals)).toBe(true);
  }, 60_000);

  it("A.5 — Real paper order + P&L from fin_strategy_tick", async () => {
    const forceBuyStrategy = {
      id: "force-buy-test",
      name: "Force Buy Test",
      version: "1.0.0",
      markets: ["equity" as const],
      symbols: ["600519.SH"],
      timeframes: ["1d"],
      parameters: {},
      async onBar(_bar: OHLCV, _ctx: StrategyContext): Promise<Signal | null> {
        return {
          action: "buy",
          symbol: "600519.SH",
          sizePct: 10,
          orderType: "market" as const,
          reason: "Force buy for live test",
          confidence: 0.9,
        };
      },
    };

    ctx.services.strategyRegistry.create(forceBuyStrategy);
    ctx.services.strategyRegistry.updateLevel("force-buy-test", "L2_PAPER");

    const tool = tools.get("fin_strategy_tick")!;
    const result = await retry(async () => {
      const r = parseResult(
        await tool.execute("a5", { strategyId: "force-buy-test", dryRun: false }),
      );
      if ((r.ticked as number) === 0 && (r.errors as string[])?.length > 0) {
        throw new Error(`DataHub transient: ${(r.errors as string[]).join(", ")}`);
      }
      return r;
    });

    expect(result.ticked).toBe(1);
    const signals = result.signals as Array<Record<string, unknown>>;
    expect(signals.length).toBe(1);
    expect(signals[0]!.action).toBe("buy");
    expect(signals[0]!.orderResult).toBeDefined();

    // Order may be filled or rejected (market hours check for cn_a_share)
    const orderResult = signals[0]!.orderResult as Record<string, unknown>;
    expect(["filled", "rejected"]).toContain(orderResult.status);

    if (orderResult.status === "filled") {
      // Verify paper account now has an order
      const accounts = ctx.services.paperEngine.listAccounts();
      expect(accounts.length).toBeGreaterThan(0);
      const activeId = accounts[0]!.id;
      const state = ctx.services.paperEngine.getAccountState(activeId);
      expect(state).toBeDefined();
      expect(state!.orders.length).toBeGreaterThan(0);
    }
  }, 60_000);
});
