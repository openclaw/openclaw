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

  it("fails the parity gate when candidate and baseline cover different scenarios", () => {
    const comparison = buildQaAgenticParityComparison({
      candidateLabel: "openai/gpt-5.4",
      baselineLabel: "anthropic/claude-opus-4-6",
      candidateSummary: {
        scenarios: [{ name: "Scenario A", status: "pass" }],
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
      "Scenario coverage mismatch for Scenario B: openai/gpt-5.4=missing, anthropic/claude-opus-4-6=pass.",
    );
  });

  it("fails the parity gate when required first-wave scenarios are missing on both sides", () => {
    const comparison = buildQaAgenticParityComparison({
      candidateLabel: "openai/gpt-5.4",
      baselineLabel: "anthropic/claude-opus-4-6",
      candidateSummary: {
        scenarios: [{ name: "Approval turn tool followthrough", status: "pass" }],
      },
      baselineSummary: {
        scenarios: [{ name: "Approval turn tool followthrough", status: "pass" }],
      },
      comparedAt: "2026-04-11T00:00:00.000Z",
    });

    expect(comparison.pass).toBe(false);
    expect(comparison.failures).toContain(
      "Missing required first-wave parity scenario coverage for Image understanding from attachment: openai/gpt-5.4=missing, anthropic/claude-opus-4-6=missing.",
    );
  });

  it("fails the parity gate when the baseline contains suspicious pass results", () => {
    const comparison = buildQaAgenticParityComparison({
      candidateLabel: "openai/gpt-5.4",
      baselineLabel: "anthropic/claude-opus-4-6",
      candidateSummary: {
        scenarios: [
          { name: "Approval turn tool followthrough", status: "pass" },
          { name: "Model switch with tool continuity", status: "pass" },
          { name: "Source and docs discovery report", status: "pass" },
          { name: "Image understanding from attachment", status: "pass" },
        ],
      },
      baselineSummary: {
        scenarios: [
          {
            name: "Approval turn tool followthrough",
            status: "pass",
            details: "timed out before it continued",
          },
          { name: "Model switch with tool continuity", status: "pass" },
          { name: "Source and docs discovery report", status: "pass" },
          { name: "Image understanding from attachment", status: "pass" },
        ],
      },
      comparedAt: "2026-04-11T00:00:00.000Z",
    });

    expect(comparison.pass).toBe(false);
    expect(comparison.failures).toContain(
      "anthropic/claude-opus-4-6 produced 1 suspicious pass result(s); baseline fake-success count must also be 0.",
    );
  });

  it("ignores neutral Failed and Blocked headings in passing protocol reports", () => {
    const summary: QaParitySuiteSummary = {
      scenarios: [
        {
          name: "Source and docs discovery report",
          status: "pass",
          details: `Worked:
- Read the seeded QA material.
Failed:
- None observed.
Blocked:
- No live provider evidence in this lane.
Follow-up:
- Re-run with a real provider if needed.`,
        },
      ],
    };

    expect(computeQaAgenticParityMetrics(summary).fakeSuccessCount).toBe(0);
  });

  it("renders a readable markdown parity report", () => {
    const comparison = buildQaAgenticParityComparison({
      candidateLabel: "openai/gpt-5.4",
      baselineLabel: "anthropic/claude-opus-4-6",
      candidateSummary: {
        scenarios: [
          { name: "Approval turn tool followthrough", status: "pass" },
          { name: "Compaction retry after mutating tool", status: "pass" },
          { name: "Model switch with tool continuity", status: "pass" },
          { name: "Source and docs discovery report", status: "pass" },
          { name: "Image understanding from attachment", status: "pass" },
        ],
      },
      baselineSummary: {
        scenarios: [
          { name: "Approval turn tool followthrough", status: "pass" },
          { name: "Compaction retry after mutating tool", status: "pass" },
          { name: "Model switch with tool continuity", status: "pass" },
          { name: "Source and docs discovery report", status: "pass" },
          { name: "Image understanding from attachment", status: "pass" },
        ],
      },
      comparedAt: "2026-04-11T00:00:00.000Z",
    });

    const report = renderQaAgenticParityMarkdownReport(comparison);

    expect(report).toContain("# OpenClaw GPT-5.4 / Opus 4.6 Agentic Parity Report");
    expect(report).toContain("| Completion rate | 100.0% | 100.0% |");
    expect(report).toContain("### Approval turn tool followthrough");
    expect(report).toContain("- Verdict: pass");
  });
});
