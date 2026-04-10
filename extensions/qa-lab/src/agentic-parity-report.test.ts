import { describe, expect, it } from "vitest";
import {
  buildQaAgenticParityComparison,
  computeQaAgenticParityMetrics,
  renderQaAgenticParityMarkdownReport,
  type QaParitySuiteSummary,
} from "./agentic-parity-report.js";

describe("qa agentic parity report", () => {
  it("computes first-wave parity metrics from suite summaries", () => {
    const summary: QaParitySuiteSummary = {
      scenarios: [
        { name: "Scenario A", status: "pass" },
        { name: "Scenario B", status: "fail", details: "incomplete turn detected" },
      ],
    };

    expect(computeQaAgenticParityMetrics(summary)).toEqual({
      totalScenarios: 2,
      passedScenarios: 1,
      failedScenarios: 1,
      completionRate: 0.5,
      unintendedStopCount: 1,
      unintendedStopRate: 0.5,
      validToolCallCount: 1,
      validToolCallRate: 0.5,
      fakeSuccessCount: 0,
    });
  });

  it("fails the parity gate when the candidate regresses against baseline", () => {
    const comparison = buildQaAgenticParityComparison({
      candidateLabel: "openai/gpt-5.4",
      baselineLabel: "anthropic/claude-opus-4-6",
      candidateSummary: {
        scenarios: [
          { name: "Scenario A", status: "pass" },
          { name: "Scenario B", status: "fail", details: "timed out before it continued" },
        ],
      },
      baselineSummary: {
        scenarios: [
          { name: "Scenario A", status: "pass" },
          { name: "Scenario B", status: "pass" },
        ],
      },
      comparedAt: "2026-04-11T00:00:00.000Z",
    });

    expect(comparison.pass).toBe(false);
    expect(comparison.failures).toContain(
      "openai/gpt-5.4 completion rate 50.0% is below anthropic/claude-opus-4-6 100.0%.",
    );
    expect(comparison.failures).toContain(
      "openai/gpt-5.4 unintended-stop rate 50.0% exceeds anthropic/claude-opus-4-6 0.0%.",
    );
  });

  it("renders a readable markdown parity report", () => {
    const comparison = buildQaAgenticParityComparison({
      candidateLabel: "openai/gpt-5.4",
      baselineLabel: "anthropic/claude-opus-4-6",
      candidateSummary: {
        scenarios: [{ name: "Scenario A", status: "pass" }],
      },
      baselineSummary: {
        scenarios: [{ name: "Scenario A", status: "pass" }],
      },
      comparedAt: "2026-04-11T00:00:00.000Z",
    });

    const report = renderQaAgenticParityMarkdownReport(comparison);

    expect(report).toContain("# OpenClaw GPT-5.4 / Opus 4.6 Agentic Parity Report");
    expect(report).toContain("| Completion rate | 100.0% | 100.0% |");
    expect(report).toContain("### Scenario A");
    expect(report).toContain("- Verdict: pass");
  });
});
