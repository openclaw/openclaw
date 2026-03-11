import { describe, it, expect } from "vitest";
import { estimateAlphaDecay } from "./alpha-decay-estimator.js";

describe("estimateAlphaDecay", () => {
  it("classifies flat Sharpe series as stable", () => {
    // Constant Sharpe = 1.5 over 30 points
    const flat = Array.from({ length: 30 }, () => 1.5);
    const result = estimateAlphaDecay(flat);
    expect(result.classification).toBe("stable");
    expect(result.halfLifeDays).toBe(Infinity);
  });

  it("classifies rapidly decreasing Sharpe as fast-decay", () => {
    // Sharpe decays from 2.0 to near 0 over 20 points
    const decaying = Array.from({ length: 20 }, (_, i) => 2.0 * Math.exp(-0.1 * i));
    const result = estimateAlphaDecay(decaying);
    expect(result.classification).toBe("fast-decay");
    expect(result.halfLifeDays).toBeLessThan(30);
    expect(result.decayRate).toBeGreaterThan(0);
    expect(result.r2).toBeGreaterThan(0.9);
  });

  it("classifies slow decay correctly", () => {
    // halfLife ~60 days: lambda = ln(2)/60 ≈ 0.01155
    const slowDecay = Array.from({ length: 60 }, (_, i) => 2.0 * Math.exp(-0.01155 * i));
    const result = estimateAlphaDecay(slowDecay);
    expect(result.classification).toBe("slow-decay");
    expect(result.halfLifeDays).toBeGreaterThan(30);
    expect(result.halfLifeDays).toBeLessThanOrEqual(90);
  });

  it("returns stable for too-few data points", () => {
    const result = estimateAlphaDecay([1.0, 0.9, 0.8]);
    expect(result.classification).toBe("stable");
    expect(result.halfLifeDays).toBe(Infinity);
  });

  it("handles non-positive Sharpes by filtering them out", () => {
    // Mix of positive and non-positive
    const mixed = [1.5, 0, -0.5, 1.2, 1.0, 0.8, 0.6, 0.4];
    const result = estimateAlphaDecay(mixed);
    // Should still produce a result from the 5 positive values
    expect(result).toHaveProperty("classification");
    expect(result).toHaveProperty("r2");
  });
});
