import { describe, it, expect } from "vitest";
import { DeduplicationFilter } from "../../src/ideation/dedup-filter.js";
import type { StrategyHypothesis } from "../../src/ideation/types.js";

function makeRegistry(
  strategies: Array<{
    id: string;
    templateId: string;
    symbol: string;
    params: Record<string, number>;
  }>,
) {
  return {
    list: () =>
      strategies.map((s) => ({
        id: s.id,
        name: s.id,
        definition: {
          id: s.templateId,
          symbols: [s.symbol],
          parameters: s.params,
        },
      })),
  };
}

function makeHypothesis(overrides: Partial<StrategyHypothesis> = {}): StrategyHypothesis {
  return {
    templateId: "sma-crossover",
    symbol: "BTC/USDT",
    timeframe: "1h",
    parameters: { fastPeriod: 10, slowPeriod: 30 },
    rationale: "test",
    confidence: 0.8,
    ...overrides,
  };
}

describe("DeduplicationFilter", () => {
  it("accepts hypotheses when registry is empty", () => {
    const filter = new DeduplicationFilter(makeRegistry([]));
    const hypotheses = [makeHypothesis()];

    const { accepted, rejected } = filter.filter(hypotheses, 3);

    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(0);
  });

  it("rejects exact duplicate (same templateId + symbol)", () => {
    const filter = new DeduplicationFilter(
      makeRegistry([
        {
          id: "s1",
          templateId: "sma-crossover",
          symbol: "BTC/USDT",
          params: { fastPeriod: 10, slowPeriod: 30 },
        },
      ]),
    );

    const hypotheses = [makeHypothesis({ templateId: "sma-crossover", symbol: "BTC/USDT" })];

    const { accepted, rejected } = filter.filter(hypotheses, 3);

    expect(accepted).toHaveLength(0);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toContain("exact_match");
  });

  it("accepts different symbol with different params even with same template", () => {
    const filter = new DeduplicationFilter(
      makeRegistry([
        {
          id: "s1",
          templateId: "sma-crossover",
          symbol: "BTC/USDT",
          params: { fastPeriod: 10, slowPeriod: 30 },
        },
      ]),
    );

    const hypotheses = [
      makeHypothesis({
        templateId: "sma-crossover",
        symbol: "ETH/USDT",
        parameters: { fastPeriod: 50, slowPeriod: 200 },
      }),
    ];

    const { accepted, rejected } = filter.filter(hypotheses, 3);

    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(0);
  });

  it("rejects similar parameters (distance < 0.15)", () => {
    const filter = new DeduplicationFilter(
      makeRegistry([
        {
          id: "s1",
          templateId: "sma-crossover",
          symbol: "ETH/USDT",
          params: { fastPeriod: 10, slowPeriod: 30 },
        },
      ]),
    );

    // Very similar params (11, 31 vs 10, 30) — should be within threshold
    const hypotheses = [
      makeHypothesis({
        templateId: "sma-crossover",
        symbol: "SOL/USDT",
        parameters: { fastPeriod: 11, slowPeriod: 31 },
      }),
    ];

    const { accepted, rejected } = filter.filter(hypotheses, 3);

    expect(accepted).toHaveLength(0);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toContain("similar_params");
  });

  it("accepts different parameters (distance >= 0.15)", () => {
    const filter = new DeduplicationFilter(
      makeRegistry([
        {
          id: "s1",
          templateId: "sma-crossover",
          symbol: "ETH/USDT",
          params: { fastPeriod: 10, slowPeriod: 30 },
        },
      ]),
    );

    // Very different params (50, 200 vs 10, 30) — should exceed threshold
    const hypotheses = [
      makeHypothesis({
        templateId: "sma-crossover",
        symbol: "SOL/USDT",
        parameters: { fastPeriod: 50, slowPeriod: 200 },
      }),
    ];

    const { accepted, rejected } = filter.filter(hypotheses, 3);

    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(0);
  });

  it("enforces rate limit (maxPerCycle)", () => {
    const filter = new DeduplicationFilter(makeRegistry([]));

    const hypotheses = [
      makeHypothesis({ symbol: "BTC/USDT" }),
      makeHypothesis({ symbol: "ETH/USDT" }),
      makeHypothesis({ symbol: "SOL/USDT" }),
      makeHypothesis({ symbol: "DOGE/USDT" }),
    ];

    const { accepted, rejected } = filter.filter(hypotheses, 2);

    expect(accepted).toHaveLength(2);
    expect(rejected).toHaveLength(2);
    expect(rejected[0]!.reason).toBe("rate_limit");
    expect(rejected[1]!.reason).toBe("rate_limit");
  });

  it("accepts different template even for same symbol", () => {
    const filter = new DeduplicationFilter(
      makeRegistry([
        {
          id: "s1",
          templateId: "sma-crossover",
          symbol: "BTC/USDT",
          params: { fastPeriod: 10, slowPeriod: 30 },
        },
      ]),
    );

    const hypotheses = [
      makeHypothesis({
        templateId: "rsi-mean-reversion",
        symbol: "BTC/USDT",
        parameters: { rsiPeriod: 14 },
      }),
    ];

    const { accepted, rejected } = filter.filter(hypotheses, 3);

    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(0);
  });
});
