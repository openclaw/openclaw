/**
 * Phase F -- Scenario: Backtest Sprint (Day 7-14)
 *
 * Simulates a one-person quant fund's first backtest sprint:
 *   1. Create 3 strategies from different templates via HTTP API
 *   2. Run backtests on each using the real BacktestEngine with synthetic OHLCV
 *   3. Store results via StrategyRegistry.updateBacktest()
 *   4. Verify the HTTP API reflects backtest data
 *   5. Rank strategies by Sharpe, kill the worst, promote the best
 *   6. Verify the dashboard/strategy pipeline counts
 *
 * Key design: The HTTP /strategies/create route stores definitions WITHOUT an
 * `onBar` function (template metadata only). For backtesting we therefore use
 * the real builtin strategy factory functions, link them to the API-created
 * strategy IDs, and run BacktestEngine.run() directly.
 *
 * Run:
 *   npx vitest run extensions/findoo-trader-plugin/test/e2e/fullchain/scenario-backtest-sprint.test.ts
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { BacktestResult } from "../../../src/shared/types.js";
import { createBollingerBands } from "../../../src/strategy/builtin-strategies/bollinger-bands.js";
import { createRsiMeanReversion } from "../../../src/strategy/builtin-strategies/rsi-mean-reversion.js";
import { createSmaCrossover } from "../../../src/strategy/builtin-strategies/sma-crossover.js";
import { createFullChainServer, fetchJson, type FullChainContext } from "./harness.js";

vi.mock("ccxt", () => {
  class MockExchange {
    setSandboxMode = vi.fn();
    close = vi.fn();
  }
  return {
    binance: MockExchange,
    okx: MockExchange,
    bybit: MockExchange,
    hyperliquid: MockExchange,
  };
});

// ---------------------------------------------------------------------------
// Synthetic OHLCV generator — slight upward bias for realistic backtest
// ---------------------------------------------------------------------------

function generateSyntheticOHLCV(
  bars: number,
): Array<{
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}> {
  const data: Array<{
    timestamp: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }> = [];
  let price = 100;
  const now = Date.now();
  for (let i = 0; i < bars; i++) {
    const change = (Math.random() - 0.48) * 3; // slight upward bias
    const open = price;
    const close = Math.max(price + change, 1); // floor at 1
    const high = Math.max(open, close) + Math.random() * 2;
    const low = Math.min(open, close) - Math.random() * 2;
    price = close;
    data.push({
      timestamp: now - (bars - i) * 86400000,
      open,
      high,
      low: Math.max(low, 0.5),
      close,
      volume: 1000 + Math.random() * 9000,
    });
  }
  return data;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("Phase F -- Scenario: Backtest Sprint (Day 7-14)", () => {
  let ctx: FullChainContext;
  const syntheticOHLCV = generateSyntheticOHLCV(365);

  // Strategy IDs created via the HTTP API
  const strategyIds: string[] = [];
  // Backtest results keyed by strategyId
  const backtestResults: Map<string, BacktestResult> = new Map();

  beforeAll(async () => {
    ctx = await createFullChainServer();
  });

  afterAll(() => {
    ctx.cleanup();
  });

  // ---- 1. Create 3 strategies from different templates -----------------------

  it("creates 3 strategies from different templates via HTTP API", async () => {
    const templateConfigs = [
      {
        templateId: "sma-crossover",
        name: "Sprint SMA Crossover",
        symbol: "BTC/USDT",
        timeframe: "1d",
        exchangeId: "binance",
        parameters: { fastPeriod: 10, slowPeriod: 30, positionSizePct: 20 },
      },
      {
        templateId: "rsi-mean-reversion",
        name: "Sprint RSI Reversion",
        symbol: "BTC/USDT",
        timeframe: "1d",
        exchangeId: "binance",
        parameters: { rsiPeriod: 14, oversold: 30, overbought: 70, positionSizePct: 20 },
      },
      {
        templateId: "bollinger-bands",
        name: "Sprint Bollinger Bands",
        symbol: "BTC/USDT",
        timeframe: "1d",
        exchangeId: "binance",
        parameters: { period: 20, stdDev: 2, positionSizePct: 20 },
      },
    ];

    for (const cfg of templateConfigs) {
      const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategies/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cfg),
      });

      expect(status).toBe(201);
      const data = body as { strategy: { id: string; name: string; level: string } };
      expect(data.strategy).toBeDefined();
      expect(data.strategy.id).toBeTruthy();
      expect(data.strategy.level).toBe("L0_INCUBATE");
      strategyIds.push(data.strategy.id);
    }

    expect(strategyIds).toHaveLength(3);
  });

  // ---- 2. Run backtest on strategy 1 via BacktestEngine ---------------------

  it("runs backtest on strategy 1 (SMA Crossover) with synthetic OHLCV", async () => {
    const definition = createSmaCrossover({
      fastPeriod: 10,
      slowPeriod: 30,
      sizePct: 20,
      symbol: "BTC/USDT",
    });
    // Override the definition id to match the API-created strategy
    definition.id = strategyIds[0]!;

    const result = await ctx.services.backtestEngine.run(definition, syntheticOHLCV, {
      capital: 10000,
      commissionRate: 0.001,
      slippageBps: 5,
      market: "crypto",
    });

    expect(result.strategyId).toBe(strategyIds[0]);
    expect(typeof result.totalReturn).toBe("number");
    expect(typeof result.sharpe).toBe("number");
    expect(typeof result.maxDrawdown).toBe("number");
    expect(typeof result.totalTrades).toBe("number");
    expect(result.initialCapital).toBe(10000);
    expect(result.equityCurve.length).toBe(365);

    // Persist in registry
    ctx.services.strategyRegistry.updateBacktest(strategyIds[0]!, result);
    backtestResults.set(strategyIds[0]!, result);
  });

  // ---- 3. Run backtests on strategies 2 and 3 ------------------------------

  it("runs backtests on strategies 2 (RSI) and 3 (Bollinger) with synthetic OHLCV", async () => {
    // Strategy 2: RSI Mean Reversion
    const rsiDef = createRsiMeanReversion({
      period: 14,
      oversold: 30,
      overbought: 70,
      sizePct: 20,
      symbol: "BTC/USDT",
    });
    rsiDef.id = strategyIds[1]!;

    const rsiResult = await ctx.services.backtestEngine.run(rsiDef, syntheticOHLCV, {
      capital: 10000,
      commissionRate: 0.001,
      slippageBps: 5,
      market: "crypto",
    });
    expect(rsiResult.strategyId).toBe(strategyIds[1]);
    expect(typeof rsiResult.sharpe).toBe("number");
    ctx.services.strategyRegistry.updateBacktest(strategyIds[1]!, rsiResult);
    backtestResults.set(strategyIds[1]!, rsiResult);

    // Strategy 3: Bollinger Bands
    const bbDef = createBollingerBands({
      period: 20,
      stdDev: 2,
      sizePct: 20,
      symbol: "BTC/USDT",
    });
    bbDef.id = strategyIds[2]!;

    const bbResult = await ctx.services.backtestEngine.run(bbDef, syntheticOHLCV, {
      capital: 10000,
      commissionRate: 0.001,
      slippageBps: 5,
      market: "crypto",
    });
    expect(bbResult.strategyId).toBe(strategyIds[2]);
    expect(typeof bbResult.sharpe).toBe("number");
    ctx.services.strategyRegistry.updateBacktest(strategyIds[2]!, bbResult);
    backtestResults.set(strategyIds[2]!, bbResult);

    // All 3 strategies should now have backtest results
    expect(backtestResults.size).toBe(3);
  });

  // ---- 4. GET /strategies shows backtest data for all 3 ---------------------

  it("GET /strategies reflects backtest data for all 3 strategies", async () => {
    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategies`);
    expect(status).toBe(200);

    const data = body as {
      strategies: Array<{
        id: string;
        name: string;
        level: string;
        lastBacktest?: {
          sharpe: number;
          totalReturn: number;
          maxDrawdown: number;
          totalTrades: number;
        };
      }>;
    };

    expect(data.strategies).toHaveLength(3);

    for (const s of data.strategies) {
      expect(s.lastBacktest).toBeDefined();
      expect(typeof s.lastBacktest!.sharpe).toBe("number");
      expect(typeof s.lastBacktest!.totalReturn).toBe("number");
      expect(typeof s.lastBacktest!.maxDrawdown).toBe("number");
      expect(typeof s.lastBacktest!.totalTrades).toBe("number");
    }
  });

  // ---- 5. Compare and rank by Sharpe ratio ----------------------------------

  it("ranks strategies by Sharpe ratio and identifies best/worst", async () => {
    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategies`);
    expect(status).toBe(200);

    const data = body as {
      strategies: Array<{
        id: string;
        name: string;
        lastBacktest?: { sharpe: number; totalReturn: number };
      }>;
    };

    // Sort descending by Sharpe
    const ranked = [...data.strategies]
      .filter((s) => s.lastBacktest != null)
      .sort((a, b) => (b.lastBacktest?.sharpe ?? 0) - (a.lastBacktest?.sharpe ?? 0));

    expect(ranked.length).toBe(3);

    const best = ranked[0]!;
    const worst = ranked[ranked.length - 1]!;

    // Best Sharpe should be >= worst Sharpe
    expect(best.lastBacktest!.sharpe).toBeGreaterThanOrEqual(worst.lastBacktest!.sharpe);

    // Store for subsequent tests (use the actual strategy IDs)
    // We keep track via the ranked array accessible through closure
    (globalThis as Record<string, unknown>).__bestId = best.id;
    (globalThis as Record<string, unknown>).__worstId = worst.id;
  });

  // ---- 6. Kill the worst performer ------------------------------------------

  it("kills the worst performing strategy by Sharpe", async () => {
    const worstId = (globalThis as Record<string, unknown>).__worstId as string;
    expect(worstId).toBeTruthy();

    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategies/kill`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: worstId }),
    });

    expect(status).toBe(200);
    const data = body as { status: string; id: string };
    expect(data.status).toBe("killed");
    expect(data.id).toBe(worstId);

    // Verify the strategy is now KILLED in the registry
    const record = ctx.services.strategyRegistry.get(worstId);
    expect(record).toBeDefined();
    expect(record!.level).toBe("KILLED");
  });

  // ---- 7. Promote best performer to L1_BACKTEST ----------------------------

  it("promotes the best performing strategy from L0 to L1_BACKTEST", async () => {
    const bestId = (globalThis as Record<string, unknown>).__bestId as string;
    expect(bestId).toBeTruthy();

    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategies/promote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: bestId }),
    });

    expect(status).toBe(200);
    const data = body as { status: string; id: string; to: string };
    expect(data.status).toBe("promoted");
    expect(data.to).toBe("L1_BACKTEST");
    expect(data.id).toBe(bestId);

    // Verify in registry
    const record = ctx.services.strategyRegistry.get(bestId);
    expect(record).toBeDefined();
    expect(record!.level).toBe("L1_BACKTEST");
  });

  // ---- 8. Dashboard /strategy reflects updated pipeline ---------------------

  it("GET /dashboard/strategy JSON reflects pipeline counts (L0=1, L1=1, KILLED=1)", async () => {
    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/finance/dashboard/strategy`);
    expect(status).toBe(200);

    const data = body as {
      pipeline: {
        l0: number;
        l1: number;
        l2: number;
        l3: number;
        killed: number;
        total: number;
      };
      strategies: Array<{
        id: string;
        name: string;
        level: string;
        sharpe?: number;
        totalReturn?: number;
        maxDrawdown?: number;
        totalTrades?: number;
      }>;
    };

    // Pipeline breakdown: 1 at L0, 1 at L1, 0 at L2, 0 at L3, 1 killed
    expect(data.pipeline.l0).toBe(1);
    expect(data.pipeline.l1).toBe(1);
    expect(data.pipeline.l2).toBe(0);
    expect(data.pipeline.l3).toBe(0);
    expect(data.pipeline.killed).toBe(1);
    expect(data.pipeline.total).toBe(3);

    // All strategies should still have backtest metrics
    for (const s of data.strategies) {
      expect(typeof s.sharpe).toBe("number");
      expect(typeof s.totalReturn).toBe("number");
      expect(typeof s.maxDrawdown).toBe("number");
    }

    // Verify the specific levels per strategy
    const bestId = (globalThis as Record<string, unknown>).__bestId as string;
    const worstId = (globalThis as Record<string, unknown>).__worstId as string;
    const middleId = strategyIds.find((id) => id !== bestId && id !== worstId)!;

    const bestStrategy = data.strategies.find((s) => s.id === bestId);
    const worstStrategy = data.strategies.find((s) => s.id === worstId);
    const middleStrategy = data.strategies.find((s) => s.id === middleId);

    expect(bestStrategy).toBeDefined();
    expect(bestStrategy!.level).toBe("L1_BACKTEST");

    expect(worstStrategy).toBeDefined();
    expect(worstStrategy!.level).toBe("KILLED");

    expect(middleStrategy).toBeDefined();
    expect(middleStrategy!.level).toBe("L0_INCUBATE");
  });
});
