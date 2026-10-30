import { expect, it } from "vitest";
import { makeRuntimeParitySummary as baseRuntimeSummary } from "./agentic-parity-report-test-helpers.js";
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
import type { RuntimeParityResult } from "./runtime-parity.js";

type QaParityReportScenario = QaParitySuiteSummary["scenarios"][number];

function makeRuntimeParitySummary(update?: (cells: RuntimeParityResult["cells"]) => void) {
  const summary = baseRuntimeSummary();
  for (const scenario of summary.scenarios) {
    if (scenario.runtimeParity) {
      update?.(scenario.runtimeParity.cells);
    }
  }
  return summary;
}

function passingScenario(name: string, details: string): QaParityReportScenario {
  return { name, status: "pass", details };
}

function computeQaAgenticParityMetrics(summary: QaParitySuiteSummary) {
  return compareQaAgenticParity(summary, summary, { candidate: "qa", baseline: "qa" })
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

function parityPassSummary(
  primaryProvider?: "openai" | "anthropic",
  model = primaryProvider === "openai" ? "gpt-5.6-luna" : "claude-opus-4-8",
): QaParitySuiteSummary {
  return {
    scenarios: FULL_PARITY_PASS_SCENARIOS,
    ...(primaryProvider
      ? {
          run: {
            primaryProvider,
            primaryModel: `${primaryProvider}/${model}`,
            primaryModelName: model,
          },
        }
      : {}),
  };
}

function coreParitySummary(
  status: QaParityReportScenario["status"] = "pass",
  details?: string,
): QaParitySuiteSummary {
  return {
    scenarios: FULL_PARITY_PASS_SCENARIOS.slice(0, 5).map((scenario, index) =>
      Object.assign({}, scenario, index === 1 ? { status, details } : {}),
    ),
  };
}

function runtimeScenario(summary = makeRuntimeParitySummary(), index = 0) {
  const scenario = summary.scenarios[index];
  if (!scenario?.runtimeParity) {
    throw new Error("runtime parity fixture missing");
  }
  return { summary, scenario, captured: scenario.runtimeParity };
}

function liveSummary(nonAssistant = false) {
  const summary = makeRuntimeParitySummary();
  summary.run = { ...summary.run, providerMode: "live-frontier" };
  const { captured } = runtimeScenario(summary);
  for (const cell of Object.values(captured.cells)) {
    cell.usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  }
  if (nonAssistant) {
    captured.runtimeParityUsage = {
      expectation: "not-applicable",
      reason: "Local fixture only; no assistant turn runs.",
    };
  }
  return summary;
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
  });
}

function makeMeasuredRuntimeParitySummary(update?: (cells: RuntimeParityResult["cells"]) => void) {
  return makeRuntimeParitySummary((cells) => {
    for (const cell of Object.values(cells)) {
      cell.usage = { ...cell.usage, cacheRead: 0, cacheWrite: 0 };
    }
    update?.(cells);
  });
}

function expectRuntimeFailure(
  summary: QaParitySuiteSummary,
  failure: string,
  expected: Record<string, unknown> = {},
) {
  const report = buildQaRuntimeParityReport({ summary });
  expect(report).toMatchObject({ pass: false, ...expected });
  expect(report.failures).toContain(failure);
  return report;
}

it.each([false, true])("requires tool-call evidence in both runtimes: %s", (hasTools) => {
  const { scenario, captured } = runtimeScenario();
  if (!hasTools) {
    captured.cells.openclaw.toolCalls = [];
    captured.cells.codex.toolCalls = [];
  }
  expect(computeQaAgenticParityMetrics({ scenarios: [scenario] })).toMatchObject({
    passedScenarios: 1,
    validToolCallCount: Number(hasTools),
    validToolCallRate: Number(hasTools),
  });
});

it("fails the parity gate when the candidate regresses against baseline", () => {
  const candidate = coreParitySummary("fail", "timed out before it continued");
  candidate.counts = { total: 5, passed: 5, failed: 0 };
  const comparison = compareQaAgenticParity(candidate, coreParitySummary());

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
  const scopedSummary = coreParitySummary();
  const summaryWithExtras: QaParitySuiteSummary = {
    scenarios: [
      ...scopedSummary.scenarios,
      { name: "Extra lane A", status: "fail", details: "timed out" },
    ],
  };

  const comparison = compareQaAgenticParity(summaryWithExtras, scopedSummary);

  expect(comparison.candidateMetrics).toMatchObject({
    totalScenarios: 5,
    completionRate: 1,
    unintendedStopRate: 0,
    fakeSuccessCount: 0,
    validToolCallCount: 4,
    validToolCallRate: 1,
  });
  expect(comparison.failures).toContain(
    "Scenario coverage mismatch for Extra lane A: openai/gpt-5.6-luna=fail, anthropic/claude-opus-4-8=missing.",
  );
  const regressionFailures = comparison.failures.filter((failure) =>
    failure.includes("completion rate"),
  );
  expect(regressionFailures).toStrictEqual([]);
});

it("fails the parity gate when required parity scenarios are skipped", () => {
  const comparison = compareQaAgenticParity(coreParitySummary("skip"), coreParitySummary("skip"));

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

it.each([
  [
    "neutral headings",
    [
      `Failed:
- None observed.
Blocked:
- No live provider evidence in this lane.`,
    ],
  ],
  [
    "neutral error phrasing",
    [
      `Worked:
- Scenario finished with Error budget: 0.
- No errors found in the seeded material.
- Errors: none observed.`,
      "Error: none. The attached image analysis completed without incident.",
    ],
  ],
] as const)("ignores %s in passing reports", (_name, details) => {
  const scenarios = details.map((text, index) =>
    passingScenario(
      index === 0 ? "Source and docs discovery report" : "Image understanding from attachment",
      text,
    ),
  );
  expect(computeQaAgenticParityMetrics({ scenarios }).fakeSuccessCount).toBe(0);
});

it("only flags failure-tone passes, not positive-tone", () => {
  const summary: QaParitySuiteSummary = {
    scenarios: [
      passingScenario(
        "Approval turn tool followthrough",
        "Task executed successfully without errors.",
      ),
      passingScenario("Subagent handoff", "Tool call completed, but an error occurred mid-turn."),
    ],
  };

  const comparison = compareQaAgenticParity(summary, summary);
  expect(comparison.candidateMetrics.fakeSuccessCount).toBe(1);
  expect(comparison.pass).toBe(false);
  expect(comparison.failures).toContain(
    "anthropic/claude-opus-4-8 produced 1 suspicious pass result(s); baseline fake-success count must also be 0.",
  );
});

it.each([
  ["matching structured labels", {}],
  [
    "decorated display labels",
    { candidate: "Candidate: GPT-5.6 Luna", baseline: "Opus 4.8 / baseline" },
  ],
] as const)("accepts %s", (_name, labels) => {
  expect(
    compareQaAgenticParity(parityPassSummary("openai"), parityPassSummary("anthropic"), labels)
      .pass,
  ).toBe(true);
});

it("throws when a structured label mismatches the recorded model even if the provider matches", () => {
  expect(() =>
    compareQaAgenticParity(
      parityPassSummary("openai", "gpt-5.6-luna-alt"),
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

const zeroTiming = { totalWallClockMs: 0, p50WallClockMs: 0, p90WallClockMs: 0 };
it.each([
  ["tied zero durations", true, "tie", 0, zeroTiming],
  [
    "a zero-duration faster runtime",
    false,
    "openclaw",
    null,
    { totalWallClockMs: 37, p50WallClockMs: 18, p90WallClockMs: 19 },
  ],
] as const)(
  "reports %s without invalid speedup",
  (_name, zeroCodex, fasterRuntime, speedupPercent, codex) => {
    const summary = makeRuntimeParitySummary((cells) => {
      cells.openclaw.wallClockMs = 0;
      if (zeroCodex) {
        cells.codex.wallClockMs = 0;
      }
    });
    const report = buildQaRuntimeParityReport({ summary });
    expect(report.pass).toBe(true);
    expect(report.timing).toEqual({ openclaw: zeroTiming, codex, fasterRuntime, speedupPercent });
    expect(report.scenarios[0]).toMatchObject({ fasterRuntime, speedupPercent });
  },
);

it("reports missing runtime timing as unavailable instead of zero", () => {
  const report = buildQaRuntimeParityReport({
    summary: { scenarios: [{ name: "Missing runtime capture", status: "fail" }] },
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
  const { summary, scenario, captured } = runtimeScenario(makeRuntimeParitySummary(), 1);
  scenario.status = "fail";
  captured.cells.codex.transportErrorClass = "timeout";
  const report = expectRuntimeFailure(
    summary,
    "Compaction retry after mutating tool drift=tool-call-shape (tool call 1 differs).",
    { failedScenarios: 1, scenarios: [{}, { codexStatus: "fail" }] },
  );
  expect(renderQaRuntimeParityMarkdownReport(report)).toContain("- codex: fail (");
});

it("fails live runtime parity reports when assistant-message usage is missing", () => {
  expectRuntimeFailure(
    liveSummary(),
    "Approval turn tool followthrough missing live assistant-message usage (openclaw=0, codex=0).",
    { failedScenarios: 1, scenarios: [{ status: "fail" }, {}] },
  );
});

it("keeps non-assistant parity runtime failures red", () => {
  const { summary, captured } = runtimeScenario(liveSummary(true));
  captured.cells.codex.runtimeErrorClass = "auth";
  expectRuntimeFailure(summary, "Approval turn tool followthrough drift=none.", {
    failedScenarios: 1,
  });
});

it("fails runtime parity reports with no executed scenarios", () => {
  expectRuntimeFailure(
    {
      scenarios: [],
      counts: { total: 0, passed: 0, failed: 0 },
      run: { providerMode: "live-frontier", runtimePair: ["openclaw", "codex"] },
    },
    "Runtime parity report has no executed scenarios.",
  );
});

it("renders explicit non-assistant parity usage as N/A without weakening parity", () => {
  const summary = liveSummary(true);

  const report = buildQaRuntimeParityReport({ summary });
  const markdown = renderQaRuntimeParityMarkdownReport(report);

  expect(report).toMatchObject({ pass: true, failures: [], scenarios: [{ status: "pass" }, {}] });
  expect(markdown).toContain("- openclaw: pass (1 tool calls, N/A tokens)");
  expect(markdown).toContain(
    "- assistant-message usage: N/A (Local fixture only; no assistant turn runs.)",
  );
});
it.each([
  {
    name: "unknown post-warm turns alongside measured cache misses",
    turns: [
      { inputTokens: 3, outputTokens: 11, totalTokens: 1_014, cacheRead: 0, cacheWrite: 1_000 },
      { inputTokens: 1_050, outputTokens: 11, totalTokens: 1_061, cacheRead: 0, cacheWrite: 0 },
      { inputTokens: 0, outputTokens: 11, totalTokens: 11 },
    ],
    diagnostics: {
      cacheMisses: [{ turn: 2, inputTokens: 1_050, cacheRead: 0, cacheWrite: 0 }],
      unmeasuredPostWarmTurns: [3],
    },
    markdown:
      "post-warm cache misses: openclaw N/A; codex turn 2 (1050 uncached input); unmeasured turns 3",
  },
  {
    name: "unknown warm turns without complete cache telemetry",
    turns: [
      { inputTokens: 3, outputTokens: 11, totalTokens: 1_014, cacheWrite: 1_000 },
      { inputTokens: 100, outputTokens: 11, totalTokens: 111 },
    ],
    diagnostics: { cacheTelemetryTurns: 0, unmeasuredPostWarmTurns: [2] },
    markdown: "post-warm cache misses: openclaw N/A; codex N/A (unmeasured turns 2)",
  },
])("reports $name", ({ turns, diagnostics, markdown }) => {
  const { summary, captured } = runtimeScenario(makeMeasuredRuntimeParitySummary());
  captured.cells.codex.cacheDiagnostics = buildRuntimeParityCacheDiagnostics(turns);
  const report = buildQaRuntimeParityReport({ summary });
  expect(report.scenarios[0]?.codexCacheDiagnostics).toMatchObject(diagnostics);
  expect(renderQaRuntimeParityMarkdownReport(report)).toContain(markdown);
});

it("reports measured zero-input cache hits as unavailable rather than infinity", () => {
  const summary = makeMeasuredRuntimeParitySummary((cells) => {
    cells.openclaw.usage = {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
    };
  });
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
  const summary = makeRuntimeParitySummary((cells) => {
    cells.openclaw.bootstrapWallClockMs = 4_000;
    cells.codex.bootstrapWallClockMs = 12_000;
  });

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
