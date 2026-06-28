import { describe, expect, it } from "vitest";
import { IterationBudget, resolveIterationBudgetConfig } from "./iteration-budget.js";

describe("IterationBudget", () => {
  describe("constructor", () => {
    it("creates a budget with the specified maxTotal", () => {
      const budget = new IterationBudget(10);
      expect(budget.maxTotal).toBe(10);
      expect(budget.used).toBe(0);
      expect(budget.remaining).toBe(10);
    });

    it("creates a budget with maxTotal of 0", () => {
      const budget = new IterationBudget(0);
      expect(budget.maxTotal).toBe(0);
      expect(budget.remaining).toBe(0);
    });

    it("throws RangeError for negative maxTotal", () => {
      expect(() => new IterationBudget(-1)).toThrow(RangeError);
    });
  });

  describe("consume", () => {
    it("returns true and increments used when budget available", () => {
      const budget = new IterationBudget(3);
      expect(budget.consume()).toBe(true);
      expect(budget.used).toBe(1);
      expect(budget.remaining).toBe(2);
    });

    it("returns false when budget is exhausted", () => {
      const budget = new IterationBudget(2);
      expect(budget.consume()).toBe(true);
      expect(budget.consume()).toBe(true);
      expect(budget.consume()).toBe(false);
      expect(budget.used).toBe(2);
      expect(budget.remaining).toBe(0);
    });

    it("returns false for a zero-budget", () => {
      const budget = new IterationBudget(0);
      expect(budget.consume()).toBe(false);
    });

    it("consumes exactly maxTotal iterations", () => {
      const budget = new IterationBudget(5);
      for (let i = 0; i < 5; i++) {
        expect(budget.consume()).toBe(true);
      }
      expect(budget.consume()).toBe(false);
      expect(budget.used).toBe(5);
      expect(budget.remaining).toBe(0);
    });
  });

  describe("refund", () => {
    it("decrements used when used > 0", () => {
      const budget = new IterationBudget(5);
      budget.consume();
      budget.consume();
      expect(budget.used).toBe(2);
      budget.refund();
      expect(budget.used).toBe(1);
      expect(budget.remaining).toBe(4);
    });

    it("is a no-op when used is 0", () => {
      const budget = new IterationBudget(5);
      budget.refund();
      expect(budget.used).toBe(0);
      expect(budget.remaining).toBe(5);
    });

    it("allows consuming again after refund", () => {
      const budget = new IterationBudget(1);
      expect(budget.consume()).toBe(true);
      expect(budget.consume()).toBe(false);
      budget.refund();
      expect(budget.consume()).toBe(true);
      expect(budget.consume()).toBe(false);
    });
  });

  describe("used property", () => {
    it("tracks cumulative consumption", () => {
      const budget = new IterationBudget(10);
      expect(budget.used).toBe(0);
      budget.consume();
      expect(budget.used).toBe(1);
      budget.consume();
      budget.consume();
      expect(budget.used).toBe(3);
    });
  });

  describe("remaining property", () => {
    it("is maxTotal - used", () => {
      const budget = new IterationBudget(10);
      expect(budget.remaining).toBe(10);
      budget.consume();
      expect(budget.remaining).toBe(9);
    });

    it("never goes below zero", () => {
      const budget = new IterationBudget(1);
      budget.consume();
      budget.consume(); // fails, used stays at 1
      expect(budget.remaining).toBe(0);
    });
  });

  describe("interleaved sequences", () => {
    it("handles consume-refund-consume sequences", () => {
      const budget = new IterationBudget(3);
      expect(budget.consume()).toBe(true); // used=1
      expect(budget.consume()).toBe(true); // used=2
      budget.refund(); // used=1
      expect(budget.consume()).toBe(true); // used=2
      expect(budget.consume()).toBe(true); // used=3
      expect(budget.consume()).toBe(false); // exhausted
      expect(budget.used).toBe(3);
    });

    it("multiple refunds do not underflow", () => {
      const budget = new IterationBudget(5);
      budget.consume();
      budget.refund();
      budget.refund(); // should be a no-op
      budget.refund(); // should be a no-op
      expect(budget.used).toBe(0);
      expect(budget.remaining).toBe(5);
    });
  });
});

describe("resolveIterationBudgetConfig", () => {
  it("returns undefined for undefined input", () => {
    expect(resolveIterationBudgetConfig(undefined)).toBeUndefined();
  });

  it("returns undefined for null input", () => {
    expect(resolveIterationBudgetConfig(null)).toBeUndefined();
  });

  it("applies default maxIterations of 90 when not specified", () => {
    const resolved = resolveIterationBudgetConfig({ enabled: true });
    expect(resolved?.maxIterations).toBe(90);
  });

  it("applies default subagentMaxIterations of 50 when not specified", () => {
    const resolved = resolveIterationBudgetConfig({ enabled: true });
    expect(resolved?.subagentMaxIterations).toBe(50);
  });

  it("defaults forceSummaryOnExhaustion to true when not specified", () => {
    const resolved = resolveIterationBudgetConfig({ enabled: true });
    expect(resolved?.forceSummaryOnExhaustion).toBe(true);
  });

  it("defaults enabled to false when called with empty object", () => {
    const resolved = resolveIterationBudgetConfig({});
    expect(resolved?.enabled).toBe(false);
  });

  it("preserves explicitly set values", () => {
    const resolved = resolveIterationBudgetConfig({
      enabled: true,
      maxIterations: 120,
      subagentMaxIterations: 30,
      forceSummaryOnExhaustion: false,
    });
    expect(resolved).toEqual({
      enabled: true,
      maxIterations: 120,
      subagentMaxIterations: 30,
      forceSummaryOnExhaustion: false,
    });
  });
});
