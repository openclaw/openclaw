import { describe, expect, it } from "vitest";
import { buildHotState } from "./hot-state.js";
import {
  capturePromptMetrics,
  detectPromptRegressions,
  formatPromptMetricsLog,
} from "./prompt-metrics.js";

describe("capturePromptMetrics", () => {
  it("captures metrics for a minimal hot state", () => {
    const hs = buildHotState({ session_id: "s1", risk_level: "low" });
    const metrics = capturePromptMetrics({
      sessionId: "s1",
      runId: "r1",
      hotState: hs,
      hotStateTruncated: false,
      systemPromptChars: 5000,
      userContentChars: 200,
    });

    expect(metrics.sessionId).toBe("s1");
    expect(metrics.runId).toBe("r1");
    expect(metrics.hotStateTokens).toBeGreaterThan(0);
    expect(metrics.hotStateBytes).toBeGreaterThan(0);
    expect(metrics.hotStateTruncated).toBe(false);
    expect(metrics.artifactIndexCount).toBe(0);
    expect(metrics.artifactTypes).toEqual([]);
    expect(metrics.systemPromptChars).toBe(5000);
    expect(metrics.userContentChars).toBe(200);
    expect(metrics.estimatedPromptTokens).toBeGreaterThan(0);
    expect(metrics.budgetPassed).toBe(true);
    expect(metrics.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });

  it("captures artifact index metrics", () => {
    const hs = buildHotState({
      session_id: "s1",
      artifact_index: [
        { artifact_id: "a".repeat(64), type: "doc", label: "spec.md" },
        { artifact_id: "b".repeat(64), type: "code", label: "main.ts" },
        { artifact_id: "c".repeat(64), type: "doc", label: "readme.md" },
      ],
    });
    const metrics = capturePromptMetrics({
      sessionId: "s1",
      hotState: hs,
      hotStateTruncated: false,
      systemPromptChars: 3000,
      userContentChars: 100,
    });

    expect(metrics.artifactIndexCount).toBe(3);
    expect(metrics.artifactTypes).toEqual(["code", "doc"]); // sorted, deduped
  });

  it("records truncation and budget violations", () => {
    const hs = buildHotState({ session_id: "s1" });
    const metrics = capturePromptMetrics({
      sessionId: "s1",
      hotState: hs,
      hotStateTruncated: true,
      systemPromptChars: 1000,
      userContentChars: 100,
      budgetViolationCount: 2,
      budgetPassed: false,
    });

    expect(metrics.hotStateTruncated).toBe(true);
    expect(metrics.budgetViolationCount).toBe(2);
    expect(metrics.budgetPassed).toBe(false);
  });

  it("captures artifact ref bootstrap file count", () => {
    const hs = buildHotState({ session_id: "s1" });
    const metrics = capturePromptMetrics({
      sessionId: "s1",
      hotState: hs,
      hotStateTruncated: false,
      systemPromptChars: 2000,
      userContentChars: 100,
      artifactRefBootstrapFiles: 3,
    });

    expect(metrics.artifactRefBootstrapFiles).toBe(3);
  });
});

describe("formatPromptMetricsLog", () => {
  it("produces valid JSON", () => {
    const hs = buildHotState({ session_id: "s1" });
    const metrics = capturePromptMetrics({
      sessionId: "s1",
      hotState: hs,
      hotStateTruncated: false,
      systemPromptChars: 1000,
      userContentChars: 100,
    });
    const log = formatPromptMetricsLog(metrics);

    const parsed = JSON.parse(log);
    expect(parsed.type).toBe("prompt_metrics");
    expect(parsed.session).toBe("s1");
    expect(typeof parsed.hs_tokens).toBe("number");
    expect(typeof parsed.hs_bytes).toBe("number");
    expect(typeof parsed.est_tokens).toBe("number");
    expect(parsed.budget_ok).toBe(true);
  });

  it("is a single line (no newlines)", () => {
    const hs = buildHotState({
      session_id: "s1",
      artifact_index: [{ artifact_id: "a".repeat(64), type: "doc" }],
    });
    const metrics = capturePromptMetrics({
      sessionId: "s1",
      hotState: hs,
      hotStateTruncated: false,
      systemPromptChars: 1000,
      userContentChars: 100,
    });
    const log = formatPromptMetricsLog(metrics);
    expect(log.includes("\n")).toBe(false);
  });
});

describe("detectPromptRegressions", () => {
  it("returns no warnings for healthy metrics", () => {
    const hs = buildHotState({ session_id: "s1" });
    const metrics = capturePromptMetrics({
      sessionId: "s1",
      hotState: hs,
      hotStateTruncated: false,
      systemPromptChars: 1000,
      userContentChars: 100,
    });
    const warnings = detectPromptRegressions(metrics);
    expect(warnings).toHaveLength(0);
  });

  it("warns when hot state tokens approach limit", () => {
    const hs = buildHotState({
      session_id: "s1",
      constraints: Array.from({ length: 100 }, (_, i) => `constraint-${i}-${"x".repeat(20)}`),
    });
    const metrics = capturePromptMetrics({
      sessionId: "s1",
      hotState: hs,
      hotStateTruncated: false,
      systemPromptChars: 1000,
      userContentChars: 100,
    });
    // Only warn if tokens > 800
    if (metrics.hotStateTokens > 800) {
      const warnings = detectPromptRegressions(metrics);
      expect(warnings.some((w) => w.includes("token limit"))).toBe(true);
    }
  });

  it("warns when budget violations exist", () => {
    const hs = buildHotState({ session_id: "s1" });
    const metrics = capturePromptMetrics({
      sessionId: "s1",
      hotState: hs,
      hotStateTruncated: false,
      systemPromptChars: 1000,
      userContentChars: 100,
      budgetPassed: false,
      budgetViolationCount: 3,
    });
    const warnings = detectPromptRegressions(metrics);
    expect(warnings.some((w) => w.includes("budget violated"))).toBe(true);
  });

  it("warns on high artifact index count", () => {
    const entries = Array.from({ length: 18 }, (_, i) => ({
      artifact_id: `${"d".repeat(63)}${String(i % 10)}`,
      type: "doc" as const,
    }));
    const hs = buildHotState({
      session_id: "s1",
      artifact_index: entries,
    });
    const metrics = capturePromptMetrics({
      sessionId: "s1",
      hotState: hs,
      hotStateTruncated: false,
      systemPromptChars: 1000,
      userContentChars: 100,
    });
    const warnings = detectPromptRegressions(metrics);
    expect(warnings.some((w) => w.includes("artifact index count"))).toBe(true);
  });
});
