/**
 * E2E: RemoteBacktestBridge → Real Remote Service
 *
 * Tests the FULL chain that replaced the local BacktestEngine:
 *   TS StrategyDefinition → strategy-codegen (Python ZIP) → remote submit → poll → result-mapper → BacktestResult
 *
 * Skipped unless E2E_BACKTEST=1 is set + remote service is reachable.
 *
 * Usage:
 *   E2E_BACKTEST=1 \
 *   BACKTEST_API_URL=http://150.109.16.195:8000 \
 *   BACKTEST_API_KEY=<key> \
 *   pnpm test extensions/findoo-trader-plugin/test/e2e/remote-bridge-e2e.test.ts
 */

import { describe, expect, it } from "vitest";
import type { StrategyDefinition, BacktestResult } from "../../src/shared/types.js";
import { RemoteBacktestBridge } from "../../src/strategy/remote-backtest-bridge.js";
import { generateStrategyZip } from "../../src/strategy/strategy-codegen.js";

// -- Real remote service wiring (same as findoo-backtest-plugin index.ts) ------

const BASE_URL = process.env.BACKTEST_API_URL ?? "http://150.109.16.195:8000";
const API_KEY = process.env.BACKTEST_API_KEY ?? "";

async function createRealService() {
  const { BacktestClient } =
    await import("../../../../extensions/findoo-backtest-plugin/src/backtest-client.js");
  const { pollUntilDone } =
    await import("../../../../extensions/findoo-backtest-plugin/src/poller.js");
  const { toBacktestResult } =
    await import("../../../../extensions/findoo-backtest-plugin/src/result-mapper.js");

  const client = new BacktestClient(BASE_URL, API_KEY, 30_000);

  return {
    async submit(archive: Buffer, filename: string, params?: Record<string, unknown>) {
      const resp = await client.submit(archive, filename, params);
      return pollUntilDone(client, resp.task_id, {
        intervalMs: 2_000,
        timeoutMs: 180_000,
      });
    },
    toBacktestResult,
  };
}

// -- Strategy definitions for each builtin type --------------------------------

function makeDef(type: string, params: Record<string, number> = {}): StrategyDefinition {
  return {
    id: `${type}-${Date.now().toString(36)}`,
    name: `E2E Test ${type}`,
    version: "1.0.0",
    markets: ["crypto"],
    symbols: ["BTC-USD"],
    timeframes: ["1d"],
    parameters: params,
    onBar: () => [],
  };
}

const STRATEGY_CONFIGS: Array<{
  type: string;
  params: Record<string, number>;
}> = [
  { type: "sma-crossover", params: { fastPeriod: 10, slowPeriod: 30 } },
  { type: "rsi-mean-reversion", params: { period: 14, oversold: 30, overbought: 70 } },
  { type: "bollinger-bands", params: { period: 20, stdDev: 2 } },
  { type: "macd-divergence", params: { fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 } },
];

// -- Tests ---------------------------------------------------------------------

describe.skipIf(!process.env.E2E_BACKTEST)(
  "RemoteBacktestBridge E2E — Full Chain (codegen → remote → result)",
  () => {
    // ---- 1. codegen produces valid ZIP structure ----
    it("generateStrategyZip produces valid ZIP for each builtin type", async () => {
      const JSZip = (await import("jszip")).default;

      for (const cfg of STRATEGY_CONFIGS) {
        const def = makeDef(cfg.type, cfg.params);
        const { buffer, filename } = await generateStrategyZip(def);

        expect(buffer.length).toBeGreaterThan(0);
        expect(filename).toContain(cfg.type);

        // Verify ZIP contents
        const zip = await JSZip.loadAsync(buffer);
        const files = Object.keys(zip.files);
        const hasFep = files.some((f) => f.endsWith("fep.yaml"));
        const hasStrategy = files.some((f) => f.endsWith("strategy.py"));
        const hasReqs = files.some((f) => f.endsWith("requirements.txt"));

        expect(hasFep).toBe(true);
        expect(hasStrategy).toBe(true);
        expect(hasReqs).toBe(true);

        // Verify Python code is non-empty and contains compute()
        const pyFile = files.find((f) => f.endsWith("strategy.py"))!;
        const pyContent = await zip.files[pyFile].async("string");
        expect(pyContent).toContain("def compute(data)");
        expect(pyContent).toContain("import pandas");
      }
    });

    // ---- 2. SMA Crossover: full chain ----
    it("SMA Crossover: codegen → remote submit → BacktestResult with numeric fields", async () => {
      const service = await createRealService();
      const bridge = new RemoteBacktestBridge(() => service as never);
      const def = makeDef("sma-crossover", { fastPeriod: 10, slowPeriod: 30 });

      const progressUpdates: number[] = [];
      const result: BacktestResult = await bridge.runBacktest(
        def,
        { capital: 10000, commissionRate: 0.001, slippageBps: 5, market: "crypto" },
        (p) => progressUpdates.push(p.percentComplete),
      );

      // Progress callbacks fired
      expect(progressUpdates.length).toBeGreaterThanOrEqual(2);
      expect(progressUpdates).toContain(0);
      expect(progressUpdates).toContain(100);

      // BacktestResult has correct types
      expect(result.strategyId).toBe(def.id);
      expect(typeof result.totalReturn).toBe("number");
      expect(typeof result.sharpe).toBe("number");
      expect(typeof result.sortino).toBe("number");
      expect(typeof result.maxDrawdown).toBe("number");
      expect(typeof result.winRate).toBe("number");
      expect(typeof result.profitFactor).toBe("number");
      expect(typeof result.totalTrades).toBe("number");
      expect(typeof result.finalEquity).toBe("number");
      expect(result.initialCapital).toBe(10000);

      // Values are in decimal ratio (not percentage)
      expect(Math.abs(result.totalReturn)).toBeLessThan(100);
      expect(Math.abs(result.maxDrawdown)).toBeLessThan(1);

      console.log(
        `  SMA Crossover: return=${(result.totalReturn * 100).toFixed(2)}%, ` +
          `sharpe=${result.sharpe.toFixed(2)}, trades=${result.totalTrades}`,
      );
    }, 180_000);

    // ---- 3. RSI Mean Reversion: full chain ----
    it("RSI Mean Reversion: codegen → remote submit → BacktestResult", async () => {
      const service = await createRealService();
      const bridge = new RemoteBacktestBridge(() => service as never);
      const def = makeDef("rsi-mean-reversion", {
        period: 14,
        oversold: 30,
        overbought: 70,
      });

      const result = await bridge.runBacktest(def, {
        capital: 10000,
        commissionRate: 0.001,
        slippageBps: 5,
        market: "crypto",
      });

      expect(result.strategyId).toBe(def.id);
      expect(typeof result.sharpe).toBe("number");
      expect(typeof result.totalReturn).toBe("number");
      expect(result.initialCapital).toBe(10000);

      console.log(
        `  RSI MR: return=${(result.totalReturn * 100).toFixed(2)}%, ` +
          `sharpe=${result.sharpe.toFixed(2)}, trades=${result.totalTrades}`,
      );
    }, 180_000);

    // ---- 4. Bollinger Bands: full chain ----
    it("Bollinger Bands: codegen → remote submit → BacktestResult", async () => {
      const service = await createRealService();
      const bridge = new RemoteBacktestBridge(() => service as never);
      const def = makeDef("bollinger-bands", { period: 20, stdDev: 2 });

      const result = await bridge.runBacktest(def, {
        capital: 10000,
        commissionRate: 0.001,
        slippageBps: 5,
        market: "crypto",
      });

      expect(result.strategyId).toBe(def.id);
      expect(typeof result.sharpe).toBe("number");
      expect(result.initialCapital).toBe(10000);

      console.log(
        `  Bollinger: return=${(result.totalReturn * 100).toFixed(2)}%, ` +
          `sharpe=${result.sharpe.toFixed(2)}, trades=${result.totalTrades}`,
      );
    }, 180_000);

    // ---- 5. MACD Divergence: full chain ----
    it("MACD Divergence: codegen → remote submit → BacktestResult", async () => {
      const service = await createRealService();
      const bridge = new RemoteBacktestBridge(() => service as never);
      const def = makeDef("macd-divergence", {
        fastPeriod: 12,
        slowPeriod: 26,
        signalPeriod: 9,
      });

      const result = await bridge.runBacktest(def, {
        capital: 10000,
        commissionRate: 0.001,
        slippageBps: 5,
        market: "crypto",
      });

      expect(result.strategyId).toBe(def.id);
      expect(typeof result.sharpe).toBe("number");
      expect(result.initialCapital).toBe(10000);

      console.log(
        `  MACD: return=${(result.totalReturn * 100).toFixed(2)}%, ` +
          `sharpe=${result.sharpe.toFixed(2)}, trades=${result.totalTrades}`,
      );
    }, 180_000);

    // ---- 6. Fallback (unknown type): still produces valid result ----
    it("Unknown strategy type uses fallback template and still works", async () => {
      const service = await createRealService();
      const bridge = new RemoteBacktestBridge(() => service as never);
      const def = makeDef("unknown-exotic-strategy", {});

      const result = await bridge.runBacktest(def, {
        capital: 10000,
        commissionRate: 0.001,
        slippageBps: 5,
        market: "crypto",
      });

      expect(result.strategyId).toBe(def.id);
      expect(typeof result.totalReturn).toBe("number");
      expect(result.initialCapital).toBe(10000);

      console.log(
        `  Fallback: return=${(result.totalReturn * 100).toFixed(2)}%, ` +
          `sharpe=${result.sharpe.toFixed(2)}, trades=${result.totalTrades}`,
      );
    }, 180_000);

    // ---- 7. Result values are consistent across codegen → result-mapper ----
    it("result-mapper converts percentage fields to decimal ratios correctly", async () => {
      const service = await createRealService();
      const bridge = new RemoteBacktestBridge(() => service as never);
      const def = makeDef("sma-crossover", { fastPeriod: 5, slowPeriod: 20 });

      const result = await bridge.runBacktest(def, {
        capital: 10000,
        commissionRate: 0.001,
        slippageBps: 5,
        market: "crypto",
      });

      // totalReturn should be decimal (e.g., 0.125 = 12.5%)
      // maxDrawdown should be decimal (e.g., -0.08 = -8%)
      // winRate should be decimal (e.g., 0.55 = 55%)
      if (result.totalTrades > 0) {
        expect(result.winRate).toBeGreaterThanOrEqual(0);
        expect(result.winRate).toBeLessThanOrEqual(1);
      }
      expect(result.maxDrawdown).toBeLessThanOrEqual(0);
      expect(result.maxDrawdown).toBeGreaterThanOrEqual(-1);

      // finalEquity should be consistent with totalReturn
      const expectedEquity = 10000 * (1 + result.totalReturn);
      expect(result.finalEquity).toBeCloseTo(expectedEquity, 0);
    }, 180_000);
  },
);
