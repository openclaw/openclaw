import { describe, it, expect, beforeEach } from "vitest";
import {
  setLastPrediction,
  getLastPrediction,
  recordToolUsage,
  getFeedbackStats,
  formatFeedbackReport,
  resetFeedback,
  getFeedbackLog,
} from "../src/feedback.ts";

// ---------------------------------------------------------------------------
// feedback module
// ---------------------------------------------------------------------------
describe("feedback", () => {
  beforeEach(() => {
    resetFeedback();
  });

  it("setLastPrediction updates the prediction", () => {
    setLastPrediction("debug");
    expect(getLastPrediction()).toBe("debug");
  });

  it("recordToolUsage creates a matched entry when prediction aligns", () => {
    setLastPrediction("search");
    recordToolUsage("grep");
    const log = getFeedbackLog();
    expect(log.length).toBe(1);
    expect(log[0].matched).toBe(true);
    expect(log[0].predictedKind).toBe("search");
    expect(log[0].actualToolName).toBe("grep");
  });

  it("recordToolUsage creates a mismatched entry when prediction differs", () => {
    setLastPrediction("write");
    recordToolUsage("grep");
    const log = getFeedbackLog();
    expect(log.length).toBe(1);
    expect(log[0].matched).toBe(false);
  });

  it("recordToolUsage skips unknown tool names", () => {
    setLastPrediction("debug");
    recordToolUsage("unknown_tool_xyz");
    const log = getFeedbackLog();
    expect(log.length).toBe(0);
  });

  it("recordToolUsage normalizes tool name to lowercase", () => {
    setLastPrediction("read");
    recordToolUsage("READ");
    const log = getFeedbackLog();
    expect(log.length).toBe(1);
    expect(log[0].actualToolName).toBe("read");
    expect(log[0].matched).toBe(true);
  });

  it("getFeedbackStats returns correct match rate", () => {
    setLastPrediction("search");
    recordToolUsage("grep"); // match
    recordToolUsage("find"); // match
    setLastPrediction("write");
    recordToolUsage("grep"); // mismatch
    const stats = getFeedbackStats();
    expect(stats.total).toBe(3);
    expect(stats.matchRate).toBe("66.7%");
    expect(stats.mismatches.length).toBe(1);
    expect(stats.mismatches[0].count).toBe(1);
  });

  it("getFeedbackStats returns N/A when no observations", () => {
    const stats = getFeedbackStats();
    expect(stats.total).toBe(0);
    expect(stats.matchRate).toBe("N/A");
  });

  it("enforces MAX_FEEDBACK limit by dropping oldest entries", () => {
    setLastPrediction("run");
    // Record 510 tool usages to exceed the 500 limit
    for (let i = 0; i < 510; i++) {
      recordToolUsage("bash");
    }
    const log = getFeedbackLog();
    expect(log.length).toBe(500);
  });

  it("resetFeedback clears log and resets prediction", () => {
    setLastPrediction("debug");
    recordToolUsage("bash");
    resetFeedback();
    expect(getLastPrediction()).toBe("unknown");
    expect(getFeedbackLog().length).toBe(0);
  });

  it("formatFeedbackReport produces a readable report", () => {
    setLastPrediction("search");
    recordToolUsage("grep");
    setLastPrediction("write");
    recordToolUsage("grep");
    const report = formatFeedbackReport();
    expect(report.includes("Feedback Report")).toBe(true);
    expect(report.includes("Total observations: 2")).toBe(true);
    expect(report.includes("50.0%")).toBe(true);
    expect(report.includes("Top mismatches:")).toBe(true);
  });
});
