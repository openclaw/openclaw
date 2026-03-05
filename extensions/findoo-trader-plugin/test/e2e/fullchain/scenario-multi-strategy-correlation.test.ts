/**
 * Phase F+ — Scenario S6: Multi-Strategy Correlation Conflict.
 *
 * Tests correlation detection between strategies and its effect on capital
 * allocation constraints: correlated groups capped at 40%, uncorrelated
 * strategies get higher individual weights, and total exposure stays ≤ 70%.
 *
 * Run:
 *   npx vitest run extensions/findoo-trader-plugin/test/e2e/fullchain/scenario-multi-strategy-correlation.test.ts
 */

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

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createFullChainServer,
  fetchJson,
  type FullChainContext,
  DEFAULT_FUND_CONFIG,
} from "./harness.js";

// ── Curve generators ──

/** Deterministic pseudo-random using a simple LCG. */
function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

/**
 * Generate a trending equity curve: cumulative sum of base drift + noise.
 * Curves with the same `baseSeed` share the trend; `noiseSeed` adds jitter.
 */
function makeCurve(
  length: number,
  baseSeed: number,
  noiseSeed: number,
  noiseScale: number,
): number[] {
  const baseRng = seededRandom(baseSeed);
  const noiseRng = seededRandom(noiseSeed);
  const out: number[] = [];
  let cum = 0;
  for (let i = 0; i < length; i++) {
    const base = (baseRng() - 0.48) * 2; // slight upward drift
    const noise = (noiseRng() - 0.5) * noiseScale;
    cum += base + noise;
    out.push(cum);
  }
  return out;
}

describe("Scenario S6 — Multi-Strategy Correlation Conflict", () => {
  let ctx: FullChainContext;

  // Strategy IDs filled during test 1
  const ids: string[] = [];

  // Equity curves: 3 BTC (highly correlated) + 2 ETH/SOL (uncorrelated)
  const CURVE_LEN = 90;
  const btcCurve1 = makeCurve(CURVE_LEN, 42, 100, 0.05);
  const btcCurve2 = makeCurve(CURVE_LEN, 42, 200, 0.05);
  const btcCurve3 = makeCurve(CURVE_LEN, 42, 300, 0.05);
  // ETH: pure sine wave — orthogonal to BTC's random walk
  const ethCurve = Array.from({ length: CURVE_LEN }, (_, i) => Math.sin(i * 0.3) * 10);
  // SOL: pure cosine wave — orthogonal to both sine and random walk
  const solCurve = Array.from({ length: CURVE_LEN }, (_, i) => Math.cos(i * 0.7) * 10);

  // Correlation result cached across tests
  let corrResult: {
    matrix: Map<string, Map<string, number>>;
    highCorrelation: Array<{ strategyA: string; strategyB: string; correlation: number }>;
  };

  beforeAll(async () => {
    ctx = await createFullChainServer();
  }, 15_000);

  afterAll(() => {
    ctx?.cleanup();
  });

  // ── 1. Create 5 L2 strategies with different equity curves ──

  it("creates 5 strategies, injects backtests, and promotes all to L2", async () => {
    const tplRes = await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategy-templates`);
    const templates = (tplRes.body as { templates: Array<{ id: string }> }).templates;
    expect(templates.length).toBeGreaterThan(0);

    const defs = [
      { name: "BTC-Trend-A", symbol: "BTC/USDT", sharpe: 1.8, ret: 20 },
      { name: "BTC-Trend-B", symbol: "BTC/USDT", sharpe: 1.7, ret: 18 },
      { name: "BTC-Trend-C", symbol: "BTC/USDT", sharpe: 1.6, ret: 16 },
      { name: "ETH-Mean-Rev", symbol: "ETH/USDT", sharpe: 2.0, ret: 22 },
      { name: "SOL-Breakout", symbol: "SOL/USDT", sharpe: 1.9, ret: 19 },
    ];

    for (const d of defs) {
      const res = await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategies/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          templateId: templates[0]!.id,
          name: d.name,
          symbol: d.symbol,
          timeframe: "1h",
          exchangeId: "binance",
          parameters: { fastPeriod: 10, slowPeriod: 30 },
        }),
      });
      expect(res.status).toBe(201);
      const sid = (res.body as { strategy: { id: string } }).strategy.id;
      ids.push(sid);

      // Inject backtest
      ctx.services.strategyRegistry.updateBacktest(sid, {
        strategyId: sid,
        totalReturn: d.ret,
        sharpe: d.sharpe,
        sortino: d.sharpe + 0.5,
        maxDrawdown: -10,
        calmar: 2.0,
        winRate: 0.6,
        profitFactor: 1.8,
        totalTrades: 100,
        finalEquity: 10_000 + d.ret * 100,
        initialCapital: 10_000,
        startDate: Date.now() - 90 * 86_400_000,
        endDate: Date.now(),
        trades: [],
        equityCurve: [],
        dailyReturns: [],
      });

      // Promote L0 → L1 → L2
      const p1 = await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategies/promote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: sid }),
      });
      expect(p1.status).toBe(200);

      const p2 = await fetchJson(`${ctx.baseUrl}/api/v1/finance/strategies/promote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: sid }),
      });
      expect(p2.status).toBe(200);
    }

    expect(ids.length).toBe(5);

    // Verify all at L2
    for (const id of ids) {
      const record = ctx.services.strategyRegistry.get(id);
      expect(record?.level).toBe("L2_PAPER");
    }
  });

  // ── 2. 3 BTC curves highly correlated (r > 0.7) ──

  it("detects high correlation (r > 0.7) among 3 BTC strategy curves", () => {
    const curves = new Map<string, number[]>();
    curves.set(ids[0]!, btcCurve1);
    curves.set(ids[1]!, btcCurve2);
    curves.set(ids[2]!, btcCurve3);
    curves.set(ids[3]!, ethCurve);
    curves.set(ids[4]!, solCurve);

    corrResult = ctx.services.fundManager.computeCorrelations(curves);

    // All 3 BTC pairs should be highly correlated
    const btcPairs = [
      [ids[0]!, ids[1]!],
      [ids[0]!, ids[2]!],
      [ids[1]!, ids[2]!],
    ];

    for (const [a, b] of btcPairs) {
      const corr = corrResult.matrix.get(a)!.get(b)!;
      expect(corr).toBeGreaterThan(0.7);
    }
  });

  // ── 3. ETH/SOL pair low correlation (r < 0.3) ──

  it("ETH/SOL pair has low correlation (r < 0.3) and is NOT in highCorrelation", () => {
    const ethSolCorr = corrResult.matrix.get(ids[3]!)!.get(ids[4]!)!;
    expect(Math.abs(ethSolCorr)).toBeLessThan(0.3);

    // Should not appear in high-correlation pairs
    const inHigh = corrResult.highCorrelation.some(
      (p) =>
        (p.strategyA === ids[3]! && p.strategyB === ids[4]!) ||
        (p.strategyA === ids[4]! && p.strategyB === ids[3]!),
    );
    expect(inHigh).toBe(false);
  });

  // ── 4. Correlation matrix is 5×5 ──

  it("correlation matrix contains all 5×5 entries", () => {
    expect(corrResult.matrix.size).toBe(5);

    for (const id of ids) {
      const row = corrResult.matrix.get(id);
      expect(row).toBeDefined();
      expect(row!.size).toBe(5);

      // Diagonal = 1
      expect(row!.get(id)).toBe(1);
    }
  });

  // ── 5. highCorrelation lists exactly 3 BTC pairs (C(3,2)=3) ──

  it("highCorrelation contains exactly 3 BTC pairs", () => {
    const btcIds = new Set([ids[0]!, ids[1]!, ids[2]!]);

    const btcHighPairs = corrResult.highCorrelation.filter(
      (p) => btcIds.has(p.strategyA) && btcIds.has(p.strategyB),
    );

    // C(3,2) = 3 unique pairs
    expect(btcHighPairs.length).toBe(3);

    // Each pair should have correlation > 0.7
    for (const pair of btcHighPairs) {
      expect(Math.abs(pair.correlation)).toBeGreaterThanOrEqual(0.7);
    }
  });

  // ── 6. CapitalAllocator caps correlated group at ≤ 40% ──

  it("allocator constrains highly-correlated BTC group total weight ≤ 40%", () => {
    const records = ctx.services.strategyRegistry.list();
    const profiles = ctx.services.fundManager.buildProfiles(records as never);
    const allocations = ctx.services.fundManager.allocate(profiles, corrResult.matrix);

    const btcIds = new Set([ids[0]!, ids[1]!, ids[2]!]);
    const btcTotalWeight = allocations
      .filter((a) => btcIds.has(a.strategyId))
      .reduce((sum, a) => sum + a.weightPct, 0);

    // Group cap: 40%
    expect(btcTotalWeight).toBeLessThanOrEqual(40 + 0.01); // tiny float tolerance
    expect(btcTotalWeight).toBeGreaterThan(0);
  });

  // ── 7. Uncorrelated strategies get higher individual weight ──

  it("uncorrelated ETH/SOL strategies each get higher weight than any single BTC strategy", () => {
    const records = ctx.services.strategyRegistry.list();
    const profiles = ctx.services.fundManager.buildProfiles(records as never);
    const allocations = ctx.services.fundManager.allocate(profiles, corrResult.matrix);

    const btcIds = new Set([ids[0]!, ids[1]!, ids[2]!]);
    const btcWeights = allocations.filter((a) => btcIds.has(a.strategyId)).map((a) => a.weightPct);
    const maxBtcWeight = Math.max(...btcWeights);

    const ethWeight = allocations.find((a) => a.strategyId === ids[3]!)?.weightPct ?? 0;
    const solWeight = allocations.find((a) => a.strategyId === ids[4]!)?.weightPct ?? 0;

    // ETH and SOL have higher fitness (sharpe 2.0 and 1.9) and no correlation penalty
    expect(ethWeight).toBeGreaterThan(maxBtcWeight);
    expect(solWeight).toBeGreaterThan(maxBtcWeight);
  });

  // ── 8. Total allocation ≤ 70% maxExposure ──

  it("total allocation weight does not exceed 70% maxExposure", () => {
    const records = ctx.services.strategyRegistry.list();
    const profiles = ctx.services.fundManager.buildProfiles(records as never);
    const allocations = ctx.services.fundManager.allocate(profiles, corrResult.matrix);

    const totalWeight = allocations.reduce((sum, a) => sum + a.weightPct, 0);
    expect(totalWeight).toBeLessThanOrEqual(DEFAULT_FUND_CONFIG.maxTotalExposurePct + 0.01);
    expect(totalWeight).toBeGreaterThan(0);
  });

  // ── 9. New L3 strategy (<30d) capped at 10% ──

  it("new L3 strategy with <30 days active is capped at ≤ 10%", () => {
    // Build profiles with one L3 newcomer manually
    const profiles = ctx.services.fundManager.buildProfiles(
      ctx.services.strategyRegistry.list() as never,
    );

    // Inject a synthetic L3 profile with high fitness but short tenure
    const l3Profile = {
      id: "synthetic-l3-new",
      name: "L3 Newcomer",
      level: "L3_LIVE" as const,
      fitness: 0.9, // high fitness
      paperDaysActive: 10, // < 30 days
    };

    const allProfiles = [...profiles, l3Profile];

    // Allocate directly via the allocator to test the constraint
    const allocations = ctx.services.fundManager.allocator.allocate(
      allProfiles as never,
      DEFAULT_FUND_CONFIG.totalCapital,
      DEFAULT_FUND_CONFIG as never,
    );

    const l3Alloc = allocations.find((a) => a.strategyId === "synthetic-l3-new");
    expect(l3Alloc).toBeDefined();
    expect(l3Alloc!.weightPct).toBeLessThanOrEqual(10 + 0.01);
  });

  // ── 10. GET /fund/allocations reflects constrained results ──

  it("GET /fund/allocations returns data consistent with constraints", async () => {
    // Trigger allocation via rebalance so the fund state is persisted
    const records = ctx.services.strategyRegistry.list();
    const curves = new Map<string, number[]>();
    curves.set(ids[0]!, btcCurve1);
    curves.set(ids[1]!, btcCurve2);
    curves.set(ids[2]!, btcCurve3);
    curves.set(ids[3]!, ethCurve);
    curves.set(ids[4]!, solCurve);
    ctx.services.fundManager.rebalance(records as never, undefined, curves);

    const { status, body } = await fetchJson(`${ctx.baseUrl}/api/v1/fund/allocations`);
    expect(status).toBe(200);

    const data = body as {
      allocations: Array<{ strategyId: string; capitalUsd: number; weightPct: number }>;
      totalAllocated: number;
      cashReserve: number;
      totalCapital: number;
    };

    expect(data.allocations.length).toBe(5);
    expect(data.totalCapital).toBe(DEFAULT_FUND_CONFIG.totalCapital);

    // Total allocated should respect maxExposure
    const totalWeightPct = data.allocations.reduce((s, a) => s + a.weightPct, 0);
    expect(totalWeightPct).toBeLessThanOrEqual(DEFAULT_FUND_CONFIG.maxTotalExposurePct + 0.01);

    // BTC group constraint
    const btcIds = new Set([ids[0]!, ids[1]!, ids[2]!]);
    const btcGroupWeight = data.allocations
      .filter((a) => btcIds.has(a.strategyId))
      .reduce((s, a) => s + a.weightPct, 0);
    expect(btcGroupWeight).toBeLessThanOrEqual(40 + 0.01);

    // Every allocation has positive capital
    for (const alloc of data.allocations) {
      expect(alloc.capitalUsd).toBeGreaterThan(0);
    }
  });
});
