import { describe, expect, it, vi } from "vitest";
import { CorrelationMonitor, pearsonCorrelation } from "../../src/fund/correlation-monitor.js";

vi.mock("ccxt", () => ({}));

describe("pearsonCorrelation", () => {
  it("returns 1 for perfectly correlated arrays", () => {
    const x = [1, 2, 3, 4, 5];
    const y = [2, 4, 6, 8, 10];
    expect(pearsonCorrelation(x, y)).toBeCloseTo(1.0, 5);
  });

  it("returns -1 for perfectly anti-correlated arrays", () => {
    const x = [1, 2, 3, 4, 5];
    const y = [10, 8, 6, 4, 2];
    expect(pearsonCorrelation(x, y)).toBeCloseTo(-1.0, 5);
  });

  it("returns ~0 for uncorrelated arrays", () => {
    const x = [1, -1, 1, -1, 1, -1, 1, -1];
    const y = [1, 1, -1, -1, 1, 1, -1, -1];
    expect(Math.abs(pearsonCorrelation(x, y))).toBeLessThan(0.3);
  });

  it("returns 0 for arrays shorter than 3", () => {
    expect(pearsonCorrelation([1, 2], [3, 4])).toBe(0);
    expect(pearsonCorrelation([], [])).toBe(0);
  });

  it("returns 0 if either array has zero variance", () => {
    expect(pearsonCorrelation([5, 5, 5], [1, 2, 3])).toBe(0);
    expect(pearsonCorrelation([1, 2, 3], [7, 7, 7])).toBe(0);
  });

  it("handles arrays of different lengths (uses shorter)", () => {
    const x = [1, 2, 3, 4, 5, 6, 7];
    const y = [2, 4, 6];
    expect(pearsonCorrelation(x, y)).toBeCloseTo(1.0, 5);
  });
});

describe("CorrelationMonitor", () => {
  const monitor = new CorrelationMonitor();

  it("computes pairwise correlations", () => {
    const curves = new Map<string, number[]>();
    curves.set("s1", [0.01, 0.02, -0.01, 0.03, 0.01]);
    curves.set("s2", [0.01, 0.02, -0.01, 0.03, 0.01]);
    curves.set("s3", [-0.01, -0.02, 0.01, -0.03, -0.01]);

    const { matrix, highCorrelation } = monitor.compute(curves);

    expect(matrix.get("s1")!.get("s2")).toBeCloseTo(1.0, 3);
    expect(matrix.get("s1")!.get("s3")).toBeCloseTo(-1.0, 3);
    expect(matrix.get("s1")!.get("s1")).toBe(1);

    expect(highCorrelation.length).toBeGreaterThanOrEqual(1);
    const s1s2 = highCorrelation.find(
      (p) =>
        (p.strategyA === "s1" && p.strategyB === "s2") ||
        (p.strategyA === "s2" && p.strategyB === "s1"),
    );
    expect(s1s2).toBeDefined();
  });

  it("returns empty for single strategy", () => {
    const curves = new Map<string, number[]>();
    curves.set("only", [0.01, 0.02, 0.03]);

    const { matrix, highCorrelation } = monitor.compute(curves);
    expect(matrix.get("only")!.get("only")).toBe(1);
    expect(highCorrelation).toHaveLength(0);
  });

  it("returns empty for no strategies", () => {
    const { matrix, highCorrelation } = monitor.compute(new Map());
    expect(matrix.size).toBe(0);
    expect(highCorrelation).toHaveLength(0);
  });

  it("does not flag low-correlation pairs", () => {
    const curves = new Map<string, number[]>();
    curves.set("a", [0.01, -0.02, 0.01, -0.02, 0.01, -0.02, 0.01, -0.02]);
    curves.set("b", [0.01, 0.01, -0.02, -0.02, 0.01, 0.01, -0.02, -0.02]);

    const { highCorrelation } = monitor.compute(curves);
    expect(highCorrelation).toHaveLength(0);
  });
});
