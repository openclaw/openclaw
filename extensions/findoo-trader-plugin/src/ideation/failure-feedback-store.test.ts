import { describe, it, expect } from "vitest";
import type { FailurePattern } from "../alpha-factory/types.js";
import { FailureFeedbackStore } from "./failure-feedback-store.js";

function makePattern(overrides: Partial<FailurePattern> = {}): FailurePattern {
  return {
    templateId: "SMA Crossover",
    symbol: "BTC/USDT",
    failStage: "screening",
    failReason: "Sharpe < 0.5 in quick backtest",
    parameters: { fast: 10, slow: 20 },
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("FailureFeedbackStore", () => {
  it("records and retrieves patterns", () => {
    const store = new FailureFeedbackStore();
    store.record(makePattern());
    store.record(makePattern({ symbol: "ETH/USDT" }));
    expect(store.getRecentPatterns()).toHaveLength(2);
  });

  it("respects limit in getRecentPatterns", () => {
    const store = new FailureFeedbackStore();
    for (let i = 0; i < 10; i++) {
      store.record(makePattern({ timestamp: i }));
    }
    expect(store.getRecentPatterns(3)).toHaveLength(3);
  });

  it("returns empty string for getSummary with no patterns", () => {
    const store = new FailureFeedbackStore();
    expect(store.getSummary()).toBe("");
  });

  it("generates grouped markdown summary", () => {
    const store = new FailureFeedbackStore();
    store.record(makePattern());
    store.record(makePattern());
    store.record(makePattern());
    store.record(
      makePattern({ templateId: "RSI", failStage: "validation", failReason: "Monte Carlo p=0.12" }),
    );
    store.record(
      makePattern({ templateId: "RSI", failStage: "validation", failReason: "Monte Carlo p=0.12" }),
    );

    const summary = store.getSummary();
    expect(summary).toContain("## Lessons from Recent Failures");
    expect(summary).toContain("screening: SMA Crossover on BTC/USDT failed");
    expect(summary).toContain("x3");
    expect(summary).toContain("validation: RSI on BTC/USDT failed");
    expect(summary).toContain("x2");
  });
});
