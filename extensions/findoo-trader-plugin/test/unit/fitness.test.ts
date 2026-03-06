import { describe, it, expect } from "vitest";
import { calculateFitness } from "../../src/strategy/fitness.js";
import type { FitnessInput } from "../../src/strategy/fitness.js";

const mkWindow = (sharpe: number, maxDD: number, trades = 50) => ({ sharpe, maxDD, trades });

describe("calculateFitness", () => {
  // ── Weight distribution ──

  it("with paper data: paper 50% + recent 35% + longTerm 15%", () => {
    const input: FitnessInput = {
      longTerm: mkWindow(1.0, -0.1),
      recent: mkWindow(1.0, -0.1),
      paper: mkWindow(1.0, -0.1),
    };
    // All windows identical → score = windowScore * (0.5 + 0.35 + 0.15) = windowScore
    // windowScore = 1.0 - 0.1 = 0.9
    expect(calculateFitness(input)).toBeCloseTo(0.9, 5);
  });

  it("without paper data: recent 70% + longTerm 30%", () => {
    const input: FitnessInput = {
      longTerm: mkWindow(1.0, -0.1),
      recent: mkWindow(1.0, -0.1),
    };
    expect(calculateFitness(input)).toBeCloseTo(0.9, 5);
  });

  it("paper weight dominates: high paper score lifts result", () => {
    const input: FitnessInput = {
      longTerm: mkWindow(0.5, 0),
      recent: mkWindow(0.5, 0),
      paper: mkWindow(2.0, 0),
    };
    // base = 2.0*0.5 + 0.5*0.35 + 0.5*0.15 = 1.0 + 0.175 + 0.075 = 1.25
    expect(calculateFitness(input)).toBeCloseTo(1.25, 5);
  });

  // ── Window score: sharpe - |maxDD| ──

  it("windowScore penalizes deep drawdown", () => {
    const shallow: FitnessInput = {
      longTerm: mkWindow(1.5, -0.05),
      recent: mkWindow(1.5, -0.05),
    };
    const deep: FitnessInput = {
      longTerm: mkWindow(1.5, -0.4),
      recent: mkWindow(1.5, -0.4),
    };
    expect(calculateFitness(shallow)).toBeGreaterThan(calculateFitness(deep));
  });

  // ── Decay penalty ──

  it("decay penalty when longTerm.sharpe > recent.sharpe", () => {
    const decaying: FitnessInput = {
      longTerm: mkWindow(2.0, 0),
      recent: mkWindow(1.0, 0),
    };
    const stable: FitnessInput = {
      longTerm: mkWindow(1.0, 0),
      recent: mkWindow(1.0, 0),
    };
    // decaying: base = 1.0*0.7 + 2.0*0.3 = 1.3, penalty = (2.0-1.0)*0.3 = 0.3 → 1.0
    // stable:   base = 1.0*0.7 + 1.0*0.3 = 1.0, penalty = 0 → 1.0
    expect(calculateFitness(decaying)).toBeCloseTo(1.0, 5);
    expect(calculateFitness(stable)).toBeCloseTo(1.0, 5);
  });

  it("no decay penalty when recent >= longTerm", () => {
    const improving: FitnessInput = {
      longTerm: mkWindow(0.5, 0),
      recent: mkWindow(2.0, 0),
    };
    // base = 2.0*0.7 + 0.5*0.3 = 1.55, decayPenalty = max(0, 0.5-2.0)*0.3 = 0
    expect(calculateFitness(improving)).toBeCloseTo(1.55, 5);
  });

  // ── Overfit penalty ──

  it("overfit penalty when recent.sharpe > paper.sharpe", () => {
    const overfit: FitnessInput = {
      longTerm: mkWindow(1.0, 0),
      recent: mkWindow(2.0, 0),
      paper: mkWindow(0.5, 0),
    };
    // base = 0.5*0.5 + 2.0*0.35 + 1.0*0.15 = 0.25+0.7+0.15 = 1.1
    // overfit = (2.0 - 0.5)*0.5 = 0.75
    // total = 1.1 - 0 - 0.75 = 0.35
    expect(calculateFitness(overfit)).toBeCloseTo(0.35, 5);
  });

  it("no overfit penalty without paper data", () => {
    const noPaper: FitnessInput = {
      longTerm: mkWindow(1.0, 0),
      recent: mkWindow(2.0, 0),
    };
    // paperSharpe falls back to recent.sharpe → overfit = max(0, 2.0-2.0)*0.5 = 0
    // base = 2.0*0.7 + 1.0*0.3 = 1.7
    expect(calculateFitness(noPaper)).toBeCloseTo(1.7, 5);
  });

  // ── Correlation penalty ──

  it("correlation penalty reduces score proportionally", () => {
    const correlated: FitnessInput = {
      longTerm: mkWindow(1.0, 0),
      recent: mkWindow(1.0, 0),
      correlationWithPortfolio: 0.8,
    };
    // base = 1.0, correlationPenalty = 0.8 * 0.2 = 0.16
    expect(calculateFitness(correlated)).toBeCloseTo(0.84, 5);
  });

  it("zero correlation has no penalty", () => {
    const uncorrelated: FitnessInput = {
      longTerm: mkWindow(1.0, 0),
      recent: mkWindow(1.0, 0),
      correlationWithPortfolio: 0,
    };
    expect(calculateFitness(uncorrelated)).toBeCloseTo(1.0, 5);
  });

  // ── Half-life penalty ──

  it("no half-life penalty for strategies younger than 180 days", () => {
    const young: FitnessInput = {
      longTerm: mkWindow(1.0, 0),
      recent: mkWindow(1.0, 0),
      daysSinceLaunch: 90,
    };
    expect(calculateFitness(young)).toBeCloseTo(1.0, 5);
  });

  it("half-life penalty kicks in after 180 days", () => {
    const old: FitnessInput = {
      longTerm: mkWindow(1.0, 0),
      recent: mkWindow(1.0, 0),
      daysSinceLaunch: 365,
    };
    // halfLifePenalty = 0.1 * (365 - 180) / 365 = 0.1 * 185 / 365 ≈ 0.05068
    expect(calculateFitness(old)).toBeCloseTo(1.0 - (0.1 * 185) / 365, 4);
  });

  it("half-life penalty at exactly 180 days is zero", () => {
    const boundary: FitnessInput = {
      longTerm: mkWindow(1.0, 0),
      recent: mkWindow(1.0, 0),
      daysSinceLaunch: 180,
    };
    expect(calculateFitness(boundary)).toBeCloseTo(1.0, 5);
  });

  // ── Combined penalties ──

  it("all penalties compound additively", () => {
    const worst: FitnessInput = {
      longTerm: mkWindow(2.0, -0.2),
      recent: mkWindow(1.0, -0.1),
      paper: mkWindow(0.5, -0.05),
      correlationWithPortfolio: 0.9,
      daysSinceLaunch: 400,
    };
    const score = calculateFitness(worst);
    // Should still produce a numeric result without NaN
    expect(Number.isFinite(score)).toBe(true);
    // With all penalties, score should be significantly lower than base
    expect(score).toBeLessThan(0.5);
  });

  // ── Edge cases ──

  it("negative sharpe values work correctly", () => {
    const negative: FitnessInput = {
      longTerm: mkWindow(-0.5, -0.3),
      recent: mkWindow(-1.0, -0.2),
    };
    const score = calculateFitness(negative);
    expect(Number.isFinite(score)).toBe(true);
    expect(score).toBeLessThan(0);
  });

  it("zero everything produces zero score", () => {
    const zero: FitnessInput = {
      longTerm: mkWindow(0, 0),
      recent: mkWindow(0, 0),
    };
    expect(calculateFitness(zero)).toBeCloseTo(0, 5);
  });
});
