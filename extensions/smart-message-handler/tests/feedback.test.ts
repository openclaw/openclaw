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

  it("setLastPrediction updates the prediction per session", () => {
    setLastPrediction("debug", "s1");
    expect(getLastPrediction("s1")).toBe("debug");
    expect(getLastPrediction("s2")).toBe("unknown");
  });

  it("recordToolUsage creates a matched entry when prediction aligns", () => {
    setLastPrediction("search", "s1");
    recordToolUsage("grep", "s1");
    const log = getFeedbackLog();
    expect(log.length).toBe(1);
    expect(log[0].matched).toBe(true);
    expect(log[0].predictedKind).toBe("search");
    expect(log[0].actualToolName).toBe("grep");
  });

  it("recordToolUsage creates a mismatched entry when prediction differs", () => {
    setLastPrediction("write", "s1");
    recordToolUsage("grep", "s1");
    const log = getFeedbackLog();
    expect(log.length).toBe(1);
    expect(log[0].matched).toBe(false);
  });

  it("recordToolUsage skips unknown tool names", () => {
    setLastPrediction("debug", "s1");
    recordToolUsage("unknown_tool_xyz", "s1");
    const log = getFeedbackLog();
    expect(log.length).toBe(0);
  });

  it("recordToolUsage normalizes tool name to lowercase", () => {
    setLastPrediction("read", "s1");
    recordToolUsage("READ", "s1");
    const log = getFeedbackLog();
    expect(log.length).toBe(1);
    expect(log[0].actualToolName).toBe("read");
    expect(log[0].matched).toBe(true);
  });

  it("recordToolUsage isolates predictions across sessions", () => {
    setLastPrediction("search", "s1");
    setLastPrediction("write", "s2");
    recordToolUsage("grep", "s1"); // match for s1 (search)
    recordToolUsage("grep", "s2"); // mismatch for s2 (write)
    const log = getFeedbackLog();
    expect(log.length).toBe(2);
    expect(log[0].matched).toBe(true);
    expect(log[1].matched).toBe(false);
  });

  it("getFeedbackStats returns correct match rate", () => {
    setLastPrediction("search", "s1");
    recordToolUsage("grep", "s1"); // match
    recordToolUsage("find", "s1"); // match
    setLastPrediction("write", "s1");
    recordToolUsage("grep", "s1"); // mismatch
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
    setLastPrediction("run", "s1");
    // Record 510 tool usages to exceed the 500 limit
    for (let i = 0; i < 510; i++) {
      recordToolUsage("bash", "s1");
    }
    const log = getFeedbackLog();
    expect(log.length).toBe(500);
  });

  it("resetFeedback clears log and resets all session predictions", () => {
    setLastPrediction("debug", "s1");
    setLastPrediction("search", "s2");
    recordToolUsage("bash", "s1");
    resetFeedback();
    expect(getLastPrediction("s1")).toBe("unknown");
    expect(getLastPrediction("s2")).toBe("unknown");
    expect(getFeedbackLog().length).toBe(0);
  });

  it("formatFeedbackReport produces a readable report", () => {
    setLastPrediction("search", "s1");
    recordToolUsage("grep", "s1");
    setLastPrediction("write", "s1");
    recordToolUsage("grep", "s1");
    const report = formatFeedbackReport();
    expect(report.includes("Feedback Report")).toBe(true);
    expect(report.includes("Total observations: 2")).toBe(true);
    expect(report.includes("50.0%")).toBe(true);
    expect(report.includes("Top mismatches:")).toBe(true);
  });
});
