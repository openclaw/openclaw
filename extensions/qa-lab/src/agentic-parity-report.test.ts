// Qa Lab tests cover agentic parity report plugin behavior.
import { describe, expect, it } from "vitest";
import { makeRuntimeParitySummary } from "./agentic-parity-report-test-helpers.js";
import {
  buildQaAgenticParityComparison,
  buildQaRuntimeParityReport,
  renderQaAgenticParityMarkdownReport,
  renderQaRuntimeParityMarkdownReport,
  type QaParitySuiteSummary,
} from "./agentic-parity-report.js";
import { buildRuntimeParityCacheDiagnostics } from "./runtime-parity-cache-diagnostics.js";
import {
  measureRuntimeParityCellTiming,
  summarizeRuntimeParityTiming,
} from "./runtime-parity-timing.js";
import { runRuntimeParityScenario } from "./runtime-parity.js";
import { readQaScenarioById } from "./scenario-catalog.js";
import { buildRuntimeParityScenarioResult } from "./suite-runtime-parity-result.js";

type QaParityReportScenario = QaParitySuiteSummary["scenarios"][number];

function computeQaAgenticParityMetrics(summary: QaParitySuiteSummary) {
  const label = summary.run?.primaryProvider ?? "qa";
  return compareQaAgenticParity(summary, summary, { candidate: label, baseline: label })
    .candidateMetrics;
}

const FULL_PARITY_PASS_SCENARIOS: QaParityReportScenario[] = [
  { name: "Approval turn tool followthrough", status: "pass" },
  { name: "Compaction retry after mutating tool", status: "pass" },
  { name: "Model switch with tool continuity", status: "pass" },
  { name: "Source and docs discovery report", status: "pass" },
  { name: "Image understanding from attachment", status: "pass" },
  { name: "Subagent handoff", status: "pass" },
  { name: "Subagent fanout synthesis", status: "pass" },
  { name: "Subagent stale child links", status: "pass" },
  { name: "Memory recall after context switch", status: "pass" },
  { name: "Thread memory isolation", status: "pass" },
  { name: "Config restart capability flip", status: "pass" },
  { name: "Instruction followthrough repo contract", status: "pass" },
];

function matchingRun(primaryProvider: "openai" | "anthropic") {
  const primaryModel = primaryProvider === "openai" ? "gpt-5.6-luna" : "claude-opus-4-8";
  return {
    primaryProvider,
    primaryModel: `${primaryProvider}/${primaryModel}`,
    primaryModelName: primaryModel,
  };
}

function parityPassSummary(primaryProvider?: "openai" | "anthropic"): QaParitySuiteSummary {
  return {
    scenarios: FULL_PARITY_PASS_SCENARIOS,
    ...(primaryProvider ? { run: matchingRun(primaryProvider) } : {}),
  };
}

function firstRuntimeParityScenario() {
  const scenario = makeRuntimeParitySummary().scenarios[0];
  if (!scenario) {
    throw new Error("missing runtime parity scenario fixture");
  }
  return scenario;
}

function compareQaAgenticParity(
  candidateSummary: QaParitySuiteSummary,
  baselineSummary: QaParitySuiteSummary,
  {
    candidate = "openai/gpt-5.6-luna",
    baseline = "anthropic/claude-opus-4-8",
  }: { candidate?: string; baseline?: string } = {},
) {
  return buildQaAgenticParityComparison({
    candidateLabel: candidate,
    baselineLabel: baseline,
    candidateSummary,
    baselineSummary,
    comparedAt: "2026-04-11T00:00:00.000Z",
  });
}

function makeMeasuredRuntimeParitySummary() {
  const summary = makeRuntimeParitySummary();
  for (const scenario of summary.scenarios) {
    if (scenario.runtimeParity) {
      for (const cell of Object.values(scenario.runtimeParity.cells)) {
        cell.usage = { ...cell.usage, cacheRead: 0, cacheWrite: 0 };
      }
    }
  }
  return summary;
}

describe("qa agentic parity report", () => {
  it("does not count passing runtime parity scenarios without tool-call evidence", () => {
    const scenario = firstRuntimeParityScenario();
    if (!scenario.runtimeParity) {
      throw new Error("runtime parity fixture missing");
    }
    scenario.runtimeParity.cells.openclaw.toolCalls = [];
    scenario.runtimeParity.cells.codex.toolCalls = [];
    const summary = { scenarios: [scenario] };

    const metrics = computeQaAgenticParityMetrics(summary);

    expect(metrics.passedScenarios).toBe(1);
    expect(metrics.validToolCallCount).toBe(0);
    expect(metrics.validToolCallRate).toBe(0);
  });

  it("counts passing runtime parity scenarios with tool calls in both runtimes", () => {
    const metrics = computeQaAgenticParityMetrics({
      scenarios: [firstRuntimeParityScenario()],
    });

    expect(metrics.validToolCallCount).toBe(1);
    expect(metrics.validToolCallRate).toBe(1);
  });

  it("fails the parity gate when the candidate regresses against baseline", () => {
    const comparison = compareQaAgenticParity(
      {
        counts: { total: 5, passed: 5, failed: 0 },
        scenarios: [
          { name: "Approval turn tool followthrough", status: "pass" },
          {
            name: "Compaction retry after mutating tool",
            status: "fail",
            details: "timed out before it continued",
          },
          { name: "Model switch with tool continuity", status: "pass" },
          { name: "Source and docs discovery report", status: "pass" },
          { name: "Image understanding from attachment", status: "pass" },
        ],
      },
      {
        scenarios: [
          { name: "Approval turn tool followthrough", status: "pass" },
          { name: "Compaction retry after mutating tool", status: "pass" },
          { name: "Model switch with tool continuity", status: "pass" },
          { name: "Source and docs discovery report", status: "pass" },
          { name: "Image understanding from attachment", status: "pass" },
        ],
      },
    );

    expect(comparison.candidateMetrics).toMatchObject({
      totalScenarios: 5,
      passedScenarios: 4,
      failedScenarios: 1,
      completionRate: 0.8,
      unintendedStopCount: 1,
      unintendedStopRate: 0.2,
      validToolCallCount: 3,
      validToolCallRate: 0.75,
      fakeSuccessCount: 0,
    });
    expect(comparison.pass).toBe(false);
    expect(comparison.failures).toContain(
      "openai/gpt-5.6-luna completion rate 80.0% is below anthropic/claude-opus-4-8 100.0%.",
    );
    expect(comparison.failures).toContain(
      "openai/gpt-5.6-luna unintended-stop rate 20.0% exceeds anthropic/claude-opus-4-8 0.0%.",
    );
    expect(comparison.failures).toContain(
      "Required parity scenario Compaction retry after mutating tool failed: openai/gpt-5.6-luna=fail, anthropic/claude-opus-4-8=pass.",
    );
  });

  it("scopes parity metrics to declared parity scenarios even when extra lanes are present", () => {
    const scopedSummary: QaParitySuiteSummary = {
      scenarios: [
        { name: "Approval turn tool followthrough", status: "pass" },
        { name: "Compaction retry after mutating tool", status: "pass" },
        { name: "Model switch with tool continuity", status: "pass" },
        { name: "Source and docs discovery report", status: "pass" },
        { name: "Image understanding from attachment", status: "pass" },
      ],
    };
    const summaryWithExtras: QaParitySuiteSummary = {
      scenarios: [
        ...scopedSummary.scenarios,
        { name: "Extra lane A", status: "fail", details: "timed out" },
        { name: "Extra lane B", status: "fail", details: "timed out" },
      ],
    };

    const comparison = compareQaAgenticParity(summaryWithExtras, scopedSummary);

    expect(comparison.candidateMetrics.totalScenarios).toBe(5);
    expect(comparison.candidateMetrics.completionRate).toBe(1);
    expect(comparison.candidateMetrics.unintendedStopRate).toBe(0);
    expect(comparison.candidateMetrics.fakeSuccessCount).toBe(0);
    expect(comparison.candidateMetrics.validToolCallCount).toBe(4);
    expect(comparison.candidateMetrics.validToolCallRate).toBe(1);
    expect(comparison.failures).toContain(
      "Scenario coverage mismatch for Extra lane A: openai/gpt-5.6-luna=fail, anthropic/claude-opus-4-8=missing.",
    );
    const regressionFailures = comparison.failures.filter((failure) =>
      failure.includes("completion rate"),
    );
    expect(regressionFailures).toStrictEqual([]);
  });

  it("fails the parity gate when required parity scenarios are skipped", () => {
    const comparison = compareQaAgenticParity(
      {
        scenarios: [
          { name: "Approval turn tool followthrough", status: "pass" },
          { name: "Compaction retry after mutating tool", status: "skip" },
          { name: "Model switch with tool continuity", status: "pass" },
          { name: "Source and docs discovery report", status: "pass" },
          { name: "Image understanding from attachment", status: "pass" },
        ],
      },
      {
        scenarios: [
          { name: "Approval turn tool followthrough", status: "pass" },
          { name: "Compaction retry after mutating tool", status: "skip" },
          { name: "Model switch with tool continuity", status: "pass" },
          { name: "Source and docs discovery report", status: "pass" },
          { name: "Image understanding from attachment", status: "pass" },
        ],
      },
    );

    expect(comparison.pass).toBe(false);
    expect(comparison.failures).toContain(
      "Missing required parity scenario coverage for Compaction retry after mutating tool: openai/gpt-5.6-luna=skip, anthropic/claude-opus-4-8=skip.",
    );
    expect(
      comparison.failures.filter((failure) =>
        failure.includes("Missing required parity scenario coverage for Subagent handoff:"),
      ),
    ).toHaveLength(1);
    expect(
      comparison.failures.filter((failure) =>
        failure.includes("Scenario coverage mismatch for Subagent handoff:"),
      ),
    ).toHaveLength(0);
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

  it("ignores neutral error-budget and no-errors-observed phrasing in passing reports", () => {
    const summary: QaParitySuiteSummary = {
      scenarios: [
        {
          name: "Source and docs discovery report",
          status: "pass",
          details: `Worked:
- Scenario finished with Error budget: 0.
- No errors found in the seeded material.
- Errors: none observed.`,
        },
        {
          name: "Image understanding from attachment",
          status: "pass",
          details: "Error: none. The attached image analysis completed without incident.",
        },
      ],
    };

    expect(computeQaAgenticParityMetrics(summary).fakeSuccessCount).toBe(0);
  });

  it("only flags failure-tone passes, not positive-tone", () => {
    const summary: QaParitySuiteSummary = {
      scenarios: [
        {
          name: "Approval turn tool followthrough",
          status: "pass",
          details: "Task executed successfully without errors.",
        },
        {
          name: "Subagent handoff",
          status: "pass",
          details: "Tool call completed, but an error occurred mid-turn.",
        },
      ],
    };

    const comparison = compareQaAgenticParity(summary, summary);
    expect(comparison.candidateMetrics.fakeSuccessCount).toBe(1);
    expect(comparison.pass).toBe(false);
    expect(comparison.failures).toContain(
      "anthropic/claude-opus-4-8 produced 1 suspicious pass result(s); baseline fake-success count must also be 0.",
    );
  });

  it("accepts matching run.primaryProvider labels without throwing", () => {
    const comparison = compareQaAgenticParity(
      parityPassSummary("openai"),
      parityPassSummary("anthropic"),
    );
    expect(comparison.pass).toBe(true);
  });

  it("skips provider verification for mixed-case or decorated display labels", () => {
    const comparison = compareQaAgenticParity(
      parityPassSummary("openai"),
      parityPassSummary("anthropic"),
      { candidate: "Candidate: GPT-5.6 Luna", baseline: "Opus 4.8 / baseline" },
    );

    expect(comparison.pass).toBe(true);
  });

  it("throws when a structured label mismatches the recorded model even if the provider matches", () => {
    expect(() =>
      compareQaAgenticParity(
        {
          scenarios: FULL_PARITY_PASS_SCENARIOS,
          run: {
            primaryProvider: "openai",
            primaryModel: "openai/gpt-5.6-luna-alt",
            primaryModelName: "gpt-5.6-luna-alt",
          },
        },
        parityPassSummary("anthropic"),
      ),
    ).toThrow(
      /candidate summary run\.primaryProvider=openai and run\.primaryModel=openai\/gpt-5\.6-luna-alt do not match --candidate-label=openai\/gpt-5\.6-luna/,
    );
  });

  it("renders a readable markdown parity report", () => {
    const comparison = compareQaAgenticParity(parityPassSummary(), parityPassSummary(), {
      candidate: "candidate",
      baseline: "baseline",
    });

    const report = renderQaAgenticParityMarkdownReport(comparison);

    expect(report).toContain("# OpenClaw Agentic Parity Report — candidate vs baseline");
    expect(report).toContain("| Completion rate | 100.0% | 100.0% |");
    expect(report).toContain("### Approval turn tool followthrough");
    expect(report).toContain("- Verdict: pass");
  });

  it("reports tied zero-duration captures without an invalid speedup", () => {
    const summary = makeRuntimeParitySummary();
    for (const scenario of summary.scenarios) {
      if (scenario.runtimeParity) {
        scenario.runtimeParity.cells.openclaw.wallClockMs = 0;
        scenario.runtimeParity.cells.codex.wallClockMs = 0;
      }
    }

    const report = buildQaRuntimeParityReport({ summary });

    expect(report.pass).toBe(true);
    expect(report.timing).toEqual({
      openclaw: { totalWallClockMs: 0, p50WallClockMs: 0, p90WallClockMs: 0 },
      codex: { totalWallClockMs: 0, p50WallClockMs: 0, p90WallClockMs: 0 },
      fasterRuntime: "tie",
      speedupPercent: 0,
    });
    expect(report.scenarios[0]).toMatchObject({
      fasterRuntime: "tie",
      speedupPercent: 0,
    });
  });

  it("reports missing runtime timing as unavailable instead of zero", () => {
    const report = buildQaRuntimeParityReport({
      summary: {
        scenarios: [{ name: "Missing runtime capture", status: "fail" }],
        counts: { total: 1, passed: 0, failed: 1 },
        run: { providerMode: "live-frontier", runtimePair: ["openclaw", "codex"] },
      },
    });

    expect(report.timing).toEqual({
      openclaw: { totalWallClockMs: null, p50WallClockMs: null, p90WallClockMs: null },
      codex: { totalWallClockMs: null, p50WallClockMs: null, p90WallClockMs: null },
      fasterRuntime: null,
      speedupPercent: null,
    });

    const markdown = renderQaRuntimeParityMarkdownReport(report);
    expect(markdown).toContain("| openclaw | N/A | N/A | N/A |");
    expect(markdown).toContain("| codex | N/A | N/A | N/A |");
    expect(markdown).toContain("- Faster runtime: N/A");
  });

  it("fails runtime parity reports with transport errors", () => {
    const summary = makeRuntimeParitySummary();
    const scenario = summary.scenarios[1];
    if (!scenario?.runtimeParity) {
      throw new Error("runtime parity fixture missing");
    }
    scenario.status = "fail";
    scenario.runtimeParity.cells.codex.transportErrorClass = "timeout";

    const report = buildQaRuntimeParityReport({
      summary,
      comparedAt: "2026-05-10T00:00:00.000Z",
    });

    expect(report.pass).toBe(false);
    expect(report.failedScenarios).toBe(1);
    expect(report.scenarios[1]?.codexStatus).toBe("fail");
    expect(renderQaRuntimeParityMarkdownReport(report)).toContain("- codex: fail (");
    expect(report.failures).toContain(
      "Compaction retry after mutating tool drift=tool-call-shape (tool call 1 differs).",
    );
  });

  it.each([
    { description: "known harness gap", knownGap: true, bothSkipped: false, pass: true },
    { description: "unexpected skip", knownGap: false, bothSkipped: false, pass: false },
    { description: "both runtimes skipped", knownGap: true, bothSkipped: true, pass: false },
  ])(
    "preserves $description in runtime parity evidence",
    async ({ knownGap, bothSkipped, pass }) => {
      const summary = makeRuntimeParitySummary();
      const catalogScenario = readQaScenarioById("compaction-retry-mutating-tool");
      const captured = summary.scenarios[1]?.runtimeParity;
      if (!captured) {
        throw new Error("runtime parity fixture missing");
      }
      const result = await runRuntimeParityScenario({
        scenarioId: catalogScenario.id,
        runCell: async (runtime) => ({
          status: runtime === "codex" || bothSkipped ? "skip" : "pass",
          ...(runtime === "codex"
            ? {
                details: knownGap
                  ? "known-harness-gap compaction-retry-mutating-tool: native compaction"
                  : "implementation unavailable",
              }
            : {}),
          cell: captured.cells[runtime],
        }),
      });
      summary.scenarios[1] = buildRuntimeParityScenarioResult({
        scenarioName: catalogScenario.title,
        result,
      });

      const report = buildQaRuntimeParityReport({ summary });

      expect(report.pass).toBe(pass);
      expect(report.scenarios[1]).toMatchObject({
        status: pass ? "pass" : "fail",
        openclawStatus: bothSkipped ? "skip" : "pass",
        codexStatus: "skip",
        drift: pass ? "structural" : "failure-mode",
      });
      expect(summary.scenarios[1]?.steps?.map((step) => step.status)).toEqual([
        bothSkipped ? "skip" : "pass",
        "skip",
        pass ? "pass" : "skip",
      ]);
      expect(renderQaRuntimeParityMarkdownReport(report)).toContain("- codex: skip (");
    },
  );

  it("passes runtime parity reports with controlled tool-error cells and advisory drift", () => {
    const summary = makeRuntimeParitySummary();
    const scenario = summary.scenarios[1];
    if (!scenario?.runtimeParity) {
      throw new Error("runtime parity fixture missing");
    }
    scenario.runtimeParity.cells.codex.runtimeErrorClass = "tool-error";
    summary.scenarios[1] = buildRuntimeParityScenarioResult({
      scenarioName: scenario.name,
      result: scenario.runtimeParity,
    });

    const report = buildQaRuntimeParityReport({
      summary,
      comparedAt: "2026-05-10T00:00:00.000Z",
    });

    expect(report.pass).toBe(true);
    expect(report.failedScenarios).toBe(0);
    expect(report.failures).toEqual([]);
    expect(report.scenarios[1]?.codexStatus).toBe("pass");
    expect(summary.scenarios[1]?.steps?.map((step) => step.status)).toEqual([
      "pass",
      "pass",
      "pass",
    ]);
    expect(renderQaRuntimeParityMarkdownReport(report)).toContain("- codex: pass (1 tool calls");
  });

  it("fails live runtime parity reports when assistant-message usage is missing", () => {
    const summary = makeRuntimeParitySummary();
    summary.run = {
      ...summary.run,
      providerMode: "live-frontier",
    };
    const scenario = summary.scenarios[0];
    if (!scenario?.runtimeParity) {
      throw new Error("runtime parity fixture missing");
    }
    scenario.runtimeParity.cells.openclaw.usage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };
    scenario.runtimeParity.cells.codex.usage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };

    const report = buildQaRuntimeParityReport({
      summary,
      comparedAt: "2026-05-10T00:00:00.000Z",
    });

    expect(report.pass).toBe(false);
    expect(report.failedScenarios).toBe(1);
    expect(report.failures).toContain(
      "Approval turn tool followthrough missing live assistant-message usage (openclaw=0, codex=0).",
    );
    expect(report.scenarios[0]?.status).toBe("fail");
  });

  it("renders explicit non-assistant parity usage as N/A without weakening parity", () => {
    const summary = makeRuntimeParitySummary();
    summary.run = {
      ...summary.run,
      providerMode: "live-frontier",
    };
    const scenario = summary.scenarios[0];
    if (!scenario?.runtimeParity) {
      throw new Error("runtime parity fixture missing");
    }
    scenario.runtimeParity.runtimeParityUsage = {
      expectation: "not-applicable",
      reason: "Local fixture only; no assistant turn runs.",
    };
    scenario.runtimeParity.cells.openclaw.usage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };
    scenario.runtimeParity.cells.codex.usage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    };

    const report = buildQaRuntimeParityReport({ summary });
    const markdown = renderQaRuntimeParityMarkdownReport(report);

    expect(report.pass).toBe(true);
    expect(report.failures).toEqual([]);
    expect(report.scenarios[0]?.status).toBe("pass");
    expect(markdown).toContain("- openclaw: pass (1 tool calls, N/A tokens)");
    expect(markdown).toContain(
      "- assistant-message usage: N/A (Local fixture only; no assistant turn runs.)",
    );
  });

  it("keeps non-assistant parity runtime failures red", () => {
    const summary = makeRuntimeParitySummary();
    summary.run = {
      ...summary.run,
      providerMode: "live-frontier",
    };
    const scenario = summary.scenarios[0];
    if (!scenario?.runtimeParity) {
      throw new Error("runtime parity fixture missing");
    }
    scenario.runtimeParity.runtimeParityUsage = {
      expectation: "not-applicable",
      reason: "Local fixture only; no assistant turn runs.",
    };
    scenario.runtimeParity.cells.openclaw.usage.totalTokens = 0;
    scenario.runtimeParity.cells.codex.usage.totalTokens = 0;
    scenario.runtimeParity.cells.codex.runtimeErrorClass = "auth";

    const report = buildQaRuntimeParityReport({ summary });

    expect(report.pass).toBe(false);
    expect(report.failedScenarios).toBe(1);
    expect(report.failures).toContain("Approval turn tool followthrough drift=none.");
  });

  it("fails runtime parity reports with no executed scenarios", () => {
    const report = buildQaRuntimeParityReport({
      summary: {
        scenarios: [],
        counts: {
          total: 0,
          passed: 0,
          failed: 0,
        },
        run: {
          providerMode: "live-frontier",
          runtimePair: ["openclaw", "codex"],
        },
      },
      comparedAt: "2026-05-10T00:00:00.000Z",
    });

    expect(report.pass).toBe(false);
    expect(report.failures).toContain("Runtime parity report has no executed scenarios.");
  });
});

describe("qa runtime parity prompt-cache reporting", () => {
  it("reports unknown post-warm turns without hiding measured cache misses", () => {
    const summary = makeMeasuredRuntimeParitySummary();
    const scenario = summary.scenarios[0];
    if (!scenario?.runtimeParity) {
      throw new Error("runtime parity fixture missing");
    }
    scenario.runtimeParity.cells.codex.cacheDiagnostics = buildRuntimeParityCacheDiagnostics([
      { inputTokens: 3, outputTokens: 11, totalTokens: 1_014, cacheRead: 0, cacheWrite: 1_000 },
      { inputTokens: 1_050, outputTokens: 11, totalTokens: 1_061, cacheRead: 0, cacheWrite: 0 },
      { inputTokens: 0, outputTokens: 11, totalTokens: 11 },
    ]);

    const report = buildQaRuntimeParityReport({ summary });

    expect(report.scenarios[0]?.codexCacheDiagnostics).toMatchObject({
      cacheMisses: [{ turn: 2, inputTokens: 1_050, cacheRead: 0, cacheWrite: 0 }],
      unmeasuredPostWarmTurns: [3],
    });
    expect(renderQaRuntimeParityMarkdownReport(report)).toContain(
      "post-warm cache misses: openclaw N/A; codex turn 2 (1050 uncached input); unmeasured turns 3",
    );
  });

  it("preserves unknown warm turns when no turn has complete cache telemetry", () => {
    const summary = makeMeasuredRuntimeParitySummary();
    const scenario = summary.scenarios[0];
    if (!scenario?.runtimeParity) {
      throw new Error("runtime parity fixture missing");
    }
    scenario.runtimeParity.cells.codex.cacheDiagnostics = buildRuntimeParityCacheDiagnostics([
      { inputTokens: 3, outputTokens: 11, totalTokens: 1_014, cacheWrite: 1_000 },
      { inputTokens: 100, outputTokens: 11, totalTokens: 111 },
    ]);

    const report = buildQaRuntimeParityReport({ summary });

    expect(report.scenarios[0]?.codexCacheDiagnostics).toMatchObject({
      cacheTelemetryTurns: 0,
      unmeasuredPostWarmTurns: [2],
    });
    expect(renderQaRuntimeParityMarkdownReport(report)).toContain(
      "post-warm cache misses: openclaw N/A; codex N/A (unmeasured turns 2)",
    );
  });

  it("reports measured zero-input cache hits as unavailable rather than infinity", () => {
    const summary = makeMeasuredRuntimeParitySummary();
    for (const scenario of summary.scenarios) {
      if (scenario.runtimeParity) {
        scenario.runtimeParity.cells.openclaw.usage = {
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          cacheRead: 0,
          cacheWrite: 0,
        };
      }
    }
    const report = buildQaRuntimeParityReport({ summary });
    expect(report.usage.openclaw).toMatchObject({
      grossInputTokens: 0,
      cachedInputTokens: 0,
      cacheHitPercent: null,
    });
    expect(renderQaRuntimeParityMarkdownReport(report)).toContain(
      "| openclaw | 0 | 0 | 0 | 0 | 0 | 0 | N/A |",
    );
  });
});

describe("qa runtime parity timing reporting", () => {
  it("keeps minimum turn timing without inventing negative bootstrap", () => {
    const startedAt = new Date("2026-07-27T12:00:00.000Z");
    expect(
      measureRuntimeParityCellTiming({
        suiteStartedAt: startedAt,
        scenarioStartedAt: startedAt,
        scenarioFinishedAt: startedAt,
      }),
    ).toEqual({ wallClockMs: 1, bootstrapWallClockMs: 0 });
  });

  it("reports gateway bootstrap separately without changing runtime comparisons", () => {
    const summary = makeRuntimeParitySummary();
    for (const scenario of summary.scenarios) {
      if (scenario.runtimeParity) {
        scenario.runtimeParity.cells.openclaw.bootstrapWallClockMs = 4_000;
        scenario.runtimeParity.cells.codex.bootstrapWallClockMs = 12_000;
      }
    }

    const report = buildQaRuntimeParityReport({ summary });

    expect(report.pass).toBe(true);
    expect(report.timing.openclaw.totalWallClockMs).toBe(40);
    expect(report.timing.codex.totalWallClockMs).toBe(37);
    expect(report.timing.bootstrap).toEqual({
      openclaw: { totalWallClockMs: 8_000, p50WallClockMs: 4_000, p90WallClockMs: 4_000 },
      codex: { totalWallClockMs: 24_000, p50WallClockMs: 12_000, p90WallClockMs: 12_000 },
    });
    expect(report.scenarios[0]).toMatchObject({
      openclawWallClockMs: 20,
      codexWallClockMs: 18,
      openclawBootstrapWallClockMs: 4_000,
      codexBootstrapWallClockMs: 12_000,
      fasterRuntime: "codex",
    });
    const markdown = renderQaRuntimeParityMarkdownReport(report);
    expect(markdown).toContain("## Gateway Bootstrap (Excluded From Runtime Timing)");
    expect(markdown).toContain("| openclaw | 8000 ms | 4000 ms | 4000 ms |");
    expect(markdown).toContain("| codex | 24000 ms | 12000 ms | 12000 ms |");
    expect(markdown).toContain("- gateway bootstrap (excluded): openclaw 4000 ms; codex 12000 ms");
  });

  it("does not report an infinite speedup for a zero-duration runtime", () => {
    const summary = makeRuntimeParitySummary();
    for (const scenario of summary.scenarios) {
      if (scenario.runtimeParity) {
        scenario.runtimeParity.cells.openclaw.wallClockMs = 0;
      }
    }
    const report = buildQaRuntimeParityReport({ summary });
    expect(report.timing.fasterRuntime).toBe("openclaw");
    expect(report.timing.speedupPercent).toBeNull();
    expect(report.scenarios[0]).toMatchObject({
      fasterRuntime: "openclaw",
      speedupPercent: null,
    });
  });

  it("compares only paired captures while retaining independently measured totals", () => {
    const timing = summarizeRuntimeParityTiming([
      { openclawWallClockMs: 20, codexWallClockMs: 30 },
      { openclawWallClockMs: 1_000, codexWallClockMs: null },
    ]);

    expect(timing.openclaw.totalWallClockMs).toBe(1_020);
    expect(timing.codex.totalWallClockMs).toBe(30);
    expect(timing.fasterRuntime).toBe("openclaw");
    expect(timing.speedupPercent).toBeCloseTo(50);
  });
});
