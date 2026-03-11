import { describe, it, expect } from "vitest";
import { AlphaIndependenceChecker } from "./alpha-independence.js";

describe("AlphaIndependenceChecker", () => {
  const checker = new AlphaIndependenceChecker();

  it("passes when correlation is low and Sharpe is positive", () => {
    // Candidate: positive trending returns
    const candidate = Array.from(
      { length: 100 },
      (_, i) => 0.002 + (i % 2 === 0 ? 0.001 : -0.0005),
    );
    // Existing: uncorrelated returns
    const existing = new Map<string, number[]>();
    existing.set(
      "stratA",
      Array.from({ length: 100 }, (_, i) => (i % 3 === 0 ? 0.003 : -0.001)),
    );

    const result = checker.check(candidate, existing);
    expect(result.maxCorrelation).toBeLessThan(0.5);
    expect(result.marginalSharpe).toBeGreaterThan(0.05);
    expect(result.passed).toBe(true);
  });

  it("fails when correlation is too high", () => {
    // Candidate and existing are nearly identical
    const candidate = Array.from({ length: 100 }, (_, i) => 0.002 + (i % 2 === 0 ? 0.001 : -0.001));
    const almostSame = candidate.map((r) => r * 1.01 + 0.0001);
    const existing = new Map<string, number[]>();
    existing.set("clone", almostSame);

    const result = checker.check(candidate, existing);
    expect(result.maxCorrelation).toBeGreaterThanOrEqual(0.5);
    expect(result.mostCorrelatedWith).toBe("clone");
    expect(result.passed).toBe(false);
  });

  it("fails when marginal Sharpe is too low", () => {
    // Returns with near-zero mean → low Sharpe
    const candidate = Array.from({ length: 100 }, (_, i) => (i % 2 === 0 ? 0.001 : -0.001));
    const existing = new Map<string, number[]>();
    existing.set(
      "other",
      Array.from({ length: 100 }, (_, i) => (i % 3 === 0 ? 0.005 : -0.002)),
    );

    const result = checker.check(candidate, existing);
    expect(result.marginalSharpe).toBeLessThanOrEqual(0.05);
    expect(result.passed).toBe(false);
  });

  it("passes with empty existing curves", () => {
    const candidate = Array.from(
      { length: 100 },
      (_, i) => 0.003 + (i % 2 === 0 ? 0.001 : -0.0005),
    );
    const result = checker.check(candidate, new Map());
    expect(result.maxCorrelation).toBe(0);
    expect(result.passed).toBe(true);
  });
});
