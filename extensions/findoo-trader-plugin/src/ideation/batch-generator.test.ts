import { describe, it, expect } from "vitest";
import { BatchHypothesisGenerator } from "./batch-generator.js";
import type { MarketSnapshot } from "./types.js";

const MOCK_TEMPLATES = [
  {
    id: "sma-crossover",
    category: "trend",
    parameters: [
      { name: "fastPeriod", type: "number" as const, min: 2, max: 200, default: 10 },
      { name: "slowPeriod", type: "number" as const, min: 5, max: 500, default: 30 },
    ],
    supportedMarkets: ["crypto"],
  },
  {
    id: "rsi-mean-reversion",
    category: "mean-reversion",
    parameters: [
      { name: "rsiPeriod", type: "number" as const, min: 2, max: 100, default: 14 },
      { name: "oversold", type: "number" as const, min: 5, max: 50, default: 30 },
    ],
    supportedMarkets: ["crypto"],
  },
  {
    id: "custom",
    category: "multi-factor",
    parameters: [
      { name: "positionSizePct", type: "number" as const, min: 1, max: 100, default: 10 },
    ],
    supportedMarkets: ["crypto"],
  },
];

function makeSnapshot(symbols: Array<{ symbol: string; regime: string }>): MarketSnapshot {
  return {
    timestamp: Date.now(),
    symbols: symbols.map((s) => ({
      symbol: s.symbol,
      market: "crypto" as const,
      regime: s.regime as "bull" | "bear" | "sideways",
      price: 100,
      change24hPct: 1,
      indicators: {
        rsi14: 50,
        sma50: 100,
        sma200: 100,
        macdHistogram: 0,
        bbPosition: 0.5,
        atr14Pct: 2,
      },
    })),
    regimeSummary: {},
    crossMarket: { cryptoBullishPct: 50, equityBullishPct: 50, highVolatilitySymbols: [] },
  };
}

describe("BatchHypothesisGenerator", () => {
  it("generates hypotheses matching regime to template category", () => {
    const gen = new BatchHypothesisGenerator(2);
    const snapshot = makeSnapshot([
      { symbol: "BTC/USDT", regime: "bull" },
      { symbol: "ETH/USDT", regime: "sideways" },
      { symbol: "SOL/USDT", regime: "bear" },
    ]);

    const results = gen.generate(snapshot, MOCK_TEMPLATES);

    // Bull/bear symbols match trend templates; sideways matches mean-reversion
    const trendHypotheses = results.filter((h) => h.templateId === "sma-crossover");
    const mrHypotheses = results.filter((h) => h.templateId === "rsi-mean-reversion");

    // BTC (bull) and SOL (bear) should match trend
    expect(trendHypotheses.some((h) => h.symbol === "BTC/USDT")).toBe(true);
    expect(trendHypotheses.some((h) => h.symbol === "SOL/USDT")).toBe(true);

    // ETH (sideways) should match mean-reversion
    expect(mrHypotheses.some((h) => h.symbol === "ETH/USDT")).toBe(true);

    expect(results.length).toBeGreaterThan(0);
  });

  it("respects samplesPerTemplate count", () => {
    const gen = new BatchHypothesisGenerator(3);
    const snapshot = makeSnapshot([{ symbol: "BTC/USDT", regime: "bull" }]);

    const results = gen.generate(snapshot, MOCK_TEMPLATES);
    const btcTrend = results.filter(
      (h) => h.symbol === "BTC/USDT" && h.templateId === "sma-crossover",
    );
    expect(btcTrend.length).toBe(3);
  });

  it("generates parameters within min/max range", () => {
    const gen = new BatchHypothesisGenerator(5);
    const snapshot = makeSnapshot([{ symbol: "BTC/USDT", regime: "bull" }]);

    const results = gen.generate(snapshot, MOCK_TEMPLATES);

    for (const h of results.filter((r) => r.templateId === "sma-crossover")) {
      expect(h.parameters.fastPeriod).toBeGreaterThanOrEqual(2);
      expect(h.parameters.fastPeriod).toBeLessThanOrEqual(200);
      expect(h.parameters.slowPeriod).toBeGreaterThanOrEqual(5);
      expect(h.parameters.slowPeriod).toBeLessThanOrEqual(500);
    }
  });

  it("skips custom template", () => {
    const gen = new BatchHypothesisGenerator(2);
    const snapshot = makeSnapshot([{ symbol: "BTC/USDT", regime: "bull" }]);

    const results = gen.generate(snapshot, MOCK_TEMPLATES);
    expect(results.every((h) => h.templateId !== "custom")).toBe(true);
  });

  it("caps output at 50 hypotheses", () => {
    const gen = new BatchHypothesisGenerator(10);
    const manySymbols = Array.from({ length: 20 }, (_, i) => ({
      symbol: `SYM${i}/USDT`,
      regime: "bull",
    }));
    const snapshot = makeSnapshot(manySymbols);

    const results = gen.generate(snapshot, MOCK_TEMPLATES);
    expect(results.length).toBeLessThanOrEqual(50);
  });

  it("sets confidence to 0.5 for all hypotheses", () => {
    const gen = new BatchHypothesisGenerator(2);
    const snapshot = makeSnapshot([{ symbol: "BTC/USDT", regime: "sideways" }]);

    const results = gen.generate(snapshot, MOCK_TEMPLATES);
    for (const h of results) {
      expect(h.confidence).toBe(0.5);
    }
  });
});
