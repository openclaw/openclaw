/**
 * L2 Integration Test: Multi-market backtest via real remote service + DataHub.
 *
 * Tests 4 markets (US, CN, HK, Crypto) × 3 strategies each using:
 * - Real remote backtest engine at BACKTEST_API_URL
 * - Real DataHub (OpenBB) data via dataSource=datahub in fep.yaml
 *
 * Prerequisites:
 *   BACKTEST_API_URL=http://150.109.16.195:8000
 *   BACKTEST_API_KEY=bt-sk-6a25ef85cd8f51b26131da2ee55fe4b2
 *
 * Run: BACKTEST_API_URL=http://150.109.16.195:8000 BACKTEST_API_KEY=bt-sk-6a25ef85cd8f51b26131da2ee55fe4b2 pnpm vitest run extensions/findoo-trader-plugin/test/integration/multi-market-backtest.test.ts
 */

import { describe, expect, it, beforeAll } from "vitest";
import { BacktestClient } from "../../../findoo-backtest-plugin/src/backtest-client.js";
import { pollUntilDone } from "../../../findoo-backtest-plugin/src/poller.js";
import { toBacktestResult } from "../../../findoo-backtest-plugin/src/result-mapper.js";
import { generateStrategyZip, resolveRemoteMarket } from "../../src/strategy/strategy-codegen.js";
import type { StrategyDefinition } from "../../src/strategy/types.js";

const API_URL = process.env.BACKTEST_API_URL ?? "";
const API_KEY = process.env.BACKTEST_API_KEY ?? "";
const SKIP = !API_URL || !API_KEY;

function makeDef(opts: {
  type: string;
  symbol: string;
  market: string;
  params?: Record<string, unknown>;
}): StrategyDefinition {
  const id = `${opts.type}-${Date.now().toString(36)}`;
  return {
    id,
    name: `${opts.type} ${opts.symbol}`,
    version: "1.0.0",
    description: `${opts.type} strategy for ${opts.symbol}`,
    parameters: opts.params ?? {},
    symbols: [opts.symbol],
    timeframes: ["1d"],
    markets: [opts.market],
  } as StrategyDefinition;
}

/** Submit a strategy ZIP to the real remote service and return BacktestResult. */
async function submitAndWait(client: BacktestClient, def: StrategyDefinition) {
  const { buffer, filename } = await generateStrategyZip(def, {
    symbol: def.symbols[0],
    dataSource: "datahub",
  });

  const submitResp = await client.submit(buffer, filename, {
    engine: "script",
    symbol: def.symbols[0],
  });

  const { report } = await pollUntilDone(client, submitResp.task_id, {
    intervalMs: 3_000,
    timeoutMs: 180_000,
  });

  expect(report).toBeDefined();
  return toBacktestResult(report!, {
    strategyId: def.id,
    initialCapital: 10_000,
  });
}

describe.skipIf(SKIP)("Multi-market remote backtest (L2 integration)", () => {
  let client: BacktestClient;

  beforeAll(async () => {
    client = new BacktestClient(API_URL, API_KEY, 60_000);
    const health = await client.health();
    expect(["healthy", "ok"]).toContain(health.status);
  });

  // ─── US Market ─────────────────────────────────────────

  describe("US Market (AAPL)", () => {
    it("SMA Crossover — AAPL", async () => {
      const def = makeDef({
        type: "sma-crossover",
        symbol: "AAPL",
        market: "equity",
        params: { fastPeriod: 10, slowPeriod: 30 },
      });

      const result = await submitAndWait(client, def);

      expect(result.strategyId).toBe(def.id);
      expect(result.equityCurve.length).toBeGreaterThan(0);
      expect(typeof result.sharpe).toBe("number");
      expect(typeof result.totalReturn).toBe("number");
      expect(typeof result.maxDrawdown).toBe("number");
      console.log(
        `[US/AAPL] SMA Crossover: return=${(result.totalReturn * 100).toFixed(2)}%, sharpe=${result.sharpe.toFixed(3)}, trades=${result.totalTrades}`,
      );
    }, 180_000);

    it("RSI Mean Reversion — TSLA", async () => {
      const def = makeDef({
        type: "rsi-mean-reversion",
        symbol: "TSLA",
        market: "equity",
        params: { period: 14, oversold: 30, overbought: 70 },
      });

      const result = await submitAndWait(client, def);

      expect(result.equityCurve.length).toBeGreaterThan(0);
      expect(typeof result.sharpe).toBe("number");
      console.log(
        `[US/TSLA] RSI MR: return=${(result.totalReturn * 100).toFixed(2)}%, sharpe=${result.sharpe.toFixed(3)}, trades=${result.totalTrades}`,
      );
    }, 180_000);
  });

  // ─── CN Market (A-shares) ──────────────────────────────

  describe("CN Market (A-shares)", () => {
    it("Bollinger Bands — 600519.SH (Moutai)", async () => {
      const def = makeDef({
        type: "bollinger-bands",
        symbol: "600519.SH",
        market: "equity",
        params: { period: 20, stdDev: 2 },
      });

      const result = await submitAndWait(client, def);

      expect(result.equityCurve.length).toBeGreaterThan(0);
      expect(typeof result.sharpe).toBe("number");
      console.log(
        `[CN/600519.SH] BB: return=${(result.totalReturn * 100).toFixed(2)}%, sharpe=${result.sharpe.toFixed(3)}, trades=${result.totalTrades}`,
      );
    }, 180_000);

    it("MACD Divergence — 000001.SZ (Ping An)", async () => {
      const def = makeDef({
        type: "macd-divergence",
        symbol: "000001.SZ",
        market: "equity",
        params: { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 },
      });

      const result = await submitAndWait(client, def);

      expect(result.equityCurve.length).toBeGreaterThan(0);
      console.log(
        `[CN/000001.SZ] MACD: return=${(result.totalReturn * 100).toFixed(2)}%, sharpe=${result.sharpe.toFixed(3)}, trades=${result.totalTrades}`,
      );
    }, 180_000);
  });

  // ─── HK Market ─────────────────────────────────────────

  describe("HK Market", () => {
    it("Trend Following — 00700.HK (Tencent)", async () => {
      const def = makeDef({
        type: "trend-following-momentum",
        symbol: "00700.HK",
        market: "equity",
        params: { fastEma: 12, slowEma: 26, rsiPeriod: 14, rsiOverbought: 75 },
      });

      const result = await submitAndWait(client, def);

      expect(result.equityCurve.length).toBeGreaterThan(0);
      expect(typeof result.sharpe).toBe("number");
      console.log(
        `[HK/00700.HK] Trend: return=${(result.totalReturn * 100).toFixed(2)}%, sharpe=${result.sharpe.toFixed(3)}, trades=${result.totalTrades}`,
      );
    }, 180_000);

    it("Regime Adaptive — 09988.HK (Alibaba)", async () => {
      const def = makeDef({
        type: "regime-adaptive",
        symbol: "09988.HK",
        market: "equity",
        params: {
          fastEma: 12,
          slowEma: 26,
          bbPeriod: 20,
          bbStdDev: 2.0,
          rsiPeriod: 14,
          rsiOversoldMR: 30,
          rsiOverboughtMR: 70,
          bandWidthThreshold: 0.04,
        },
      });

      const result = await submitAndWait(client, def);

      expect(result.equityCurve.length).toBeGreaterThan(0);
      console.log(
        `[HK/09988.HK] Regime: return=${(result.totalReturn * 100).toFixed(2)}%, sharpe=${result.sharpe.toFixed(3)}, trades=${result.totalTrades}`,
      );
    }, 180_000);
  });

  // ─── Crypto Market ─────────────────────────────────────

  describe("Crypto Market", () => {
    it("SMA Crossover — BTC-USD", async () => {
      const def = makeDef({
        type: "sma-crossover",
        symbol: "BTC-USD",
        market: "crypto",
        params: { fastPeriod: 10, slowPeriod: 30 },
      });

      const result = await submitAndWait(client, def);

      expect(result.equityCurve.length).toBeGreaterThan(0);
      expect(typeof result.sharpe).toBe("number");
      console.log(
        `[Crypto/BTC-USD] SMA: return=${(result.totalReturn * 100).toFixed(2)}%, sharpe=${result.sharpe.toFixed(3)}, trades=${result.totalTrades}`,
      );
    }, 180_000);

    it("Volatility Mean Reversion — ETH-USD", async () => {
      const def = makeDef({
        type: "volatility-mean-reversion",
        symbol: "ETH-USD",
        market: "crypto",
        params: { bbPeriod: 20, bbStdDev: 2.0, rsiPeriod: 7, rsiOversold: 25, rsiOverbought: 75 },
      });

      const result = await submitAndWait(client, def);

      expect(result.equityCurve.length).toBeGreaterThan(0);
      console.log(
        `[Crypto/ETH-USD] VolMR: return=${(result.totalReturn * 100).toFixed(2)}%, sharpe=${result.sharpe.toFixed(3)}, trades=${result.totalTrades}`,
      );
    }, 180_000);
  });

  // ─── Cross-market comparison ───────────────────────────

  it("resolveRemoteMarket produces correct market for all test symbols", () => {
    const cases = [
      { market: "equity", symbol: "AAPL", expected: "US" },
      { market: "equity", symbol: "TSLA", expected: "US" },
      { market: "equity", symbol: "600519.SH", expected: "CN" },
      { market: "equity", symbol: "000001.SZ", expected: "CN" },
      { market: "equity", symbol: "00700.HK", expected: "HK" },
      { market: "equity", symbol: "09988.HK", expected: "HK" },
      { market: "crypto", symbol: "BTC-USD", expected: "Crypto" },
      { market: "crypto", symbol: "ETH-USD", expected: "Crypto" },
    ];

    for (const c of cases) {
      expect(resolveRemoteMarket(c.market, c.symbol)).toBe(c.expected);
    }
  });
});
