import {
  aggregateRuntimeParityCacheUsage,
  formatCacheMisses,
  formatRuntimeCacheCount,
  formatRuntimeCacheHitPercent,
  summarizeRuntimeParityCacheUsage,
} from "./agentic-parity-cache-usage.js";
import type {
  QaRuntimeParityReport,
  QaRuntimeParityScenarioReport,
} from "./agentic-parity-runtime-report-contract.js";
import {
  QA_AGENTIC_PARITY_SCENARIO_TITLES,
  QA_AGENTIC_PARITY_TOOL_BACKED_SCENARIO_TITLES,
} from "./agentic-parity.js";
import { pushQaReportListSection, type QaReportScenario } from "./report.js";
import type { RuntimeId } from "./runtime-id.js";
import type { RuntimeParityCacheDiagnostics } from "./runtime-parity-cache-diagnostics.js";
import {
  compareRuntimeWallClockMs,
  formatRuntimeSpeedComparison,
  formatRuntimeWallClockMs,
  summarizeRuntimeParityTiming,
} from "./runtime-parity-timing.js";
import type { RuntimeParityDrift, RuntimeParityResult } from "./runtime-parity.js";
import {
  isRuntimeParityResultPass,
  normalizeRuntimePair,
  resolveRuntimeParityUsagePolicy,
  runtimeParityCellStatus,
} from "./runtime-parity.js";

// Historical summaries may omit run provenance. Validate labels only when it is present.
type QaParityRunBlock = {
  primaryProvider?: string;
  primaryModel?: string;
  primaryModelName?: string;
  providerMode?: string;
  scenarioIds?: readonly string[] | null;
  runtimePair?: [RuntimeId, RuntimeId] | null;
};

export type QaParitySuiteSummary = {
  scenarios: QaRuntimeParitySuiteScenario[];
  counts?: {
    total?: number;
    passed?: number;
    failed?: number;
  };
  run?: QaParityRunBlock;
};

type QaRuntimeParitySuiteScenario = QaReportScenario & {
  runtimeParity?: RuntimeParityResult;
};

type QaAgenticParityScenarioComparison = {
  name: string;
  candidateStatus: "pass" | "fail" | "skip" | "missing";
  baselineStatus: "pass" | "fail" | "skip" | "missing";
  candidateDetails?: string;
  baselineDetails?: string;
};

type QaAgenticParityComparison = ReturnType<typeof buildQaAgenticParityComparison>;

const UNINTENDED_STOP_PATTERNS = [
  /incomplete turn/i,
  /\btimed out\b/i,
  /\btimeout\b/i,
  /\bstopped\b/i,
  /\bblocked\b/i,
  /\babandoned\b/i,
  /did not continue/i,
] as const;

// Passing prose can still disclose a runtime failure.
const SUSPICIOUS_PASS_FAILURE_TONE_PATTERNS = [
  /incomplete turn/i,
  /\btimed out\b/i,
  /\btimeout\b/i,
  /\bfailed to\b/i,
  /\bcould not\b/i,
  /\bunable to\b/i,
  /did not continue/i,
  /error occurred/i,
  /an error was/i,
] as const;

function normalizeScenarioStatus(status: string | undefined): "pass" | "fail" | "skip" {
  return status === "pass" || status === "fail" || status === "skip" ? status : "fail";
}

function scenarioHasPattern(
  scenario: QaRuntimeParitySuiteScenario,
  patterns: readonly RegExp[],
): boolean {
  const text = [scenario.details, ...(scenario.steps ?? []).map((step) => step.details)]
    .filter(Boolean)
    .join("\n");
  return text.length > 0 && patterns.some((pattern) => pattern.test(text));
}

function scenarioHasRuntimeToolCallEvidence(scenario: QaRuntimeParitySuiteScenario): boolean {
  const parity = scenario.runtimeParity;
  if (!parity) {
    return scenario.status === "pass";
  }
  return (
    scenario.status === "pass" &&
    isRuntimeParityResultPass(parity) &&
    parity.cells.openclaw.toolCalls.length > 0 &&
    parity.cells.codex.toolCalls.length > 0
  );
}

function computeQaAgenticParityMetrics(
  summary: QaParitySuiteSummary,
  parityTitleSet: ReadonlySet<string>,
) {
  const scenarios = summary.scenarios.filter((scenario) => parityTitleSet.has(scenario.name));
  const toolBackedTitleSet: ReadonlySet<string> = new Set(
    QA_AGENTIC_PARITY_TOOL_BACKED_SCENARIO_TITLES,
  );
  const totalScenarios = scenarios.length;
  const passedScenarios = scenarios.filter((scenario) => scenario.status === "pass").length;
  const failedScenarios = scenarios.filter(
    (scenario) => normalizeScenarioStatus(scenario.status) === "fail",
  ).length;
  const unintendedStopCount = scenarios.filter(
    (scenario) =>
      scenario.status !== "pass" && scenarioHasPattern(scenario, UNINTENDED_STOP_PATTERNS),
  ).length;
  const fakeSuccessCount = scenarios.filter(
    (scenario) =>
      scenario.status === "pass" &&
      scenarioHasPattern(scenario, SUSPICIOUS_PASS_FAILURE_TONE_PATTERNS),
  ).length;

  // Text-only scenarios must not inflate verified tool-call rates.
  const toolBackedScenarioCount = scenarios.filter((scenario) =>
    toolBackedTitleSet.has(scenario.name),
  ).length;
  const validToolCallCount = scenarios.filter(
    (scenario) =>
      toolBackedTitleSet.has(scenario.name) && scenarioHasRuntimeToolCallEvidence(scenario),
  ).length;

  const rate = (value: number) => (totalScenarios > 0 ? value / totalScenarios : 0);
  const toolRate = (value: number) =>
    toolBackedScenarioCount > 0 ? value / toolBackedScenarioCount : 0;
  return {
    totalScenarios,
    passedScenarios,
    failedScenarios,
    completionRate: rate(passedScenarios),
    unintendedStopCount,
    unintendedStopRate: rate(unintendedStopCount),
    validToolCallCount,
    validToolCallRate: toolRate(validToolCallCount),
    fakeSuccessCount,
  };
}

function formatPercent(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

function requiredCoverageStatus(
  scenario: QaRuntimeParitySuiteScenario | undefined,
): "pass" | "fail" | "skip" | "missing" {
  return scenario ? normalizeScenarioStatus(scenario.status) : "missing";
}

// Reject swapped candidate/baseline artifacts while accepting historical missing provenance.
function verifySummaryLabelMatch(params: {
  summary: QaParitySuiteSummary;
  label: string;
  role: "candidate" | "baseline";
}): void {
  const runProvider = params.summary.run?.primaryProvider?.trim();
  const runModel = params.summary.run?.primaryModel?.trim();
  const runModelName = params.summary.run?.primaryModelName?.trim();
  if (!runProvider || !runModel) {
    return;
  }
  // Display labels are not provider/model provenance identifiers.
  const trimmed = params.label.trim();
  const separatorMatch = /^([a-z0-9][a-z0-9-]*)[/:]([a-z0-9][a-z0-9._-]*)$/.exec(trimmed);
  if (!separatorMatch) {
    return;
  }
  const labelRef = {
    provider: separatorMatch[1] ?? "",
    model: separatorMatch[2] ?? "",
  };
  const normalizedRunModel = runModel.toLowerCase();
  const normalizedRunModelName = runModelName?.toLowerCase();
  const normalizedLabelModel = labelRef.model;
  if (
    runProvider.toLowerCase() === labelRef.provider &&
    (normalizedRunModel === normalizedLabelModel ||
      normalizedRunModelName === normalizedLabelModel ||
      normalizedRunModel === `${labelRef.provider}/${normalizedLabelModel}`)
  ) {
    return;
  }
  throw Object.assign(
    new Error(
      `${params.role} summary run.primaryProvider=${runProvider} and run.primaryModel=${runModel} do not match --${params.role}-label=${params.label}. ` +
        `Check that the --candidate-summary / --baseline-summary paths weren't swapped.`,
    ),
    {
      name: "QaParityLabelMismatchError",
      role: params.role,
      label: params.label,
      runProvider,
      runModel,
    },
  );
}

export function buildQaAgenticParityComparison(params: {
  candidateLabel: string;
  baselineLabel: string;
  candidateSummary: QaParitySuiteSummary;
  baselineSummary: QaParitySuiteSummary;
}) {
  verifySummaryLabelMatch({
    summary: params.candidateSummary,
    label: params.candidateLabel,
    role: "candidate",
  });
  verifySummaryLabelMatch({
    summary: params.baselineSummary,
    label: params.baselineLabel,
    role: "baseline",
  });
  const parityTitleSet: ReadonlySet<string> = new Set<string>(QA_AGENTIC_PARITY_SCENARIO_TITLES);
  // Full-suite summaries may include unrelated scenarios; only the parity pack gates metrics.
  const candidateMetrics = computeQaAgenticParityMetrics(params.candidateSummary, parityTitleSet);
  const baselineMetrics = computeQaAgenticParityMetrics(params.baselineSummary, parityTitleSet);

  const scenarioNames = new Set([
    ...QA_AGENTIC_PARITY_SCENARIO_TITLES,
    ...params.candidateSummary.scenarios.map((scenario) => scenario.name),
    ...params.baselineSummary.scenarios.map((scenario) => scenario.name),
  ]);
  const candidateByName = new Map(
    params.candidateSummary.scenarios.map((scenario) => [scenario.name, scenario]),
  );
  const baselineByName = new Map(
    params.baselineSummary.scenarios.map((scenario) => [scenario.name, scenario]),
  );

  const scenarioComparisons = [...scenarioNames]
    .toSorted((left, right) => left.localeCompare(right))
    .map((name) => {
      const candidate = candidateByName.get(name);
      const baseline = baselineByName.get(name);
      const candidateStatus = requiredCoverageStatus(candidate);
      const baselineStatus = requiredCoverageStatus(baseline);
      const comparison: QaAgenticParityScenarioComparison = {
        name,
        candidateStatus,
        baselineStatus,
      };
      if (candidate?.details) {
        comparison.candidateDetails = candidate.details;
      }
      if (baseline?.details) {
        comparison.baselineDetails = baseline.details;
      }
      return comparison;
    });

  const failures: string[] = [];
  const comparisonByName = new Map(
    scenarioComparisons.map((scenario) => [scenario.name, scenario]),
  );
  const requiredScenarioStatuses = QA_AGENTIC_PARITY_SCENARIO_TITLES.map((name) =>
    comparisonByName.get(name)!,
  );
  const hasCoverageGap = (scenario: QaAgenticParityScenarioComparison) =>
    [scenario.candidateStatus, scenario.baselineStatus].some(
      (status) => status === "missing" || status === "skip",
    );
  const requiredScenarioCoverage = requiredScenarioStatuses.filter(hasCoverageGap);
  for (const scenario of requiredScenarioCoverage) {
    failures.push(
      `Missing required parity scenario coverage for ${scenario.name}: ${params.candidateLabel}=${scenario.candidateStatus}, ${params.baselineLabel}=${scenario.baselineStatus}.`,
    );
  }
  // Shared failures still fail the gate; missing/skipped cells were reported above.
  const requiredScenarioFailures = requiredScenarioStatuses.filter(
    (scenario) =>
      !hasCoverageGap(scenario) &&
      (scenario.candidateStatus === "fail" || scenario.baselineStatus === "fail"),
  );
  for (const scenario of requiredScenarioFailures) {
    failures.push(
      `Required parity scenario ${scenario.name} failed: ${params.candidateLabel}=${scenario.candidateStatus}, ${params.baselineLabel}=${scenario.baselineStatus}.`,
    );
  }
  // Required coverage already has a diagnostic above.
  const coverageMismatch = scenarioComparisons.filter(
    (scenario) =>
      !parityTitleSet.has(scenario.name) &&
      (scenario.candidateStatus === "missing" || scenario.baselineStatus === "missing"),
  );
  for (const scenario of coverageMismatch) {
    failures.push(
      `Scenario coverage mismatch for ${scenario.name}: ${params.candidateLabel}=${scenario.candidateStatus}, ${params.baselineLabel}=${scenario.baselineStatus}.`,
    );
  }
  if (candidateMetrics.completionRate < baselineMetrics.completionRate) {
    failures.push(
      `${params.candidateLabel} completion rate ${formatPercent(candidateMetrics.completionRate)} is below ${params.baselineLabel} ${formatPercent(baselineMetrics.completionRate)}.`,
    );
  }
  if (candidateMetrics.unintendedStopRate > baselineMetrics.unintendedStopRate) {
    failures.push(
      `${params.candidateLabel} unintended-stop rate ${formatPercent(candidateMetrics.unintendedStopRate)} exceeds ${params.baselineLabel} ${formatPercent(baselineMetrics.unintendedStopRate)}.`,
    );
  }
  if (candidateMetrics.validToolCallRate < baselineMetrics.validToolCallRate) {
    failures.push(
      `${params.candidateLabel} valid-tool-call rate ${formatPercent(candidateMetrics.validToolCallRate)} is below ${params.baselineLabel} ${formatPercent(baselineMetrics.validToolCallRate)}.`,
    );
  }
  if (candidateMetrics.fakeSuccessCount > 0) {
    failures.push(
      `${params.candidateLabel} produced ${candidateMetrics.fakeSuccessCount} suspicious pass result(s); fake-success count must be 0.`,
    );
  }
  if (baselineMetrics.fakeSuccessCount > 0) {
    failures.push(
      `${params.baselineLabel} produced ${baselineMetrics.fakeSuccessCount} suspicious pass result(s); baseline fake-success count must also be 0.`,
    );
  }

  return {
    candidateLabel: params.candidateLabel,
    baselineLabel: params.baselineLabel,
    comparedAt: new Date().toISOString(),
    candidateMetrics,
    baselineMetrics,
    scenarioComparisons,
    pass: failures.length === 0,
    failures,
    notes: [
      "First-wave valid-tool-call rate is scenario-level and uses passing tool-mediated scenarios as the verified numerator.",
      "Auth/proxy/DNS correctness is intentionally out of scope for this parity report and should be gated by the deterministic runtime-truthfulness suites.",
    ],
  };
}

export function renderQaAgenticParityMarkdownReport(comparison: QaAgenticParityComparison): string {
  const lines = [
    `# OpenClaw Agentic Parity Report — ${comparison.candidateLabel} vs ${comparison.baselineLabel}`,
    "",
    `- Compared at: ${comparison.comparedAt}`,
    `- Candidate: ${comparison.candidateLabel}`,
    `- Baseline: ${comparison.baselineLabel}`,
    `- Verdict: ${comparison.pass ? "pass" : "fail"}`,
    "",
    "## Aggregate Metrics",
    "",
    "| Metric | Candidate | Baseline |",
    "| --- | ---: | ---: |",
    `| Completion rate | ${formatPercent(comparison.candidateMetrics.completionRate)} | ${formatPercent(comparison.baselineMetrics.completionRate)} |`,
    `| Unintended-stop rate | ${formatPercent(comparison.candidateMetrics.unintendedStopRate)} | ${formatPercent(comparison.baselineMetrics.unintendedStopRate)} |`,
    `| Valid-tool-call rate | ${formatPercent(comparison.candidateMetrics.validToolCallRate)} | ${formatPercent(comparison.baselineMetrics.validToolCallRate)} |`,
    `| Fake-success count | ${comparison.candidateMetrics.fakeSuccessCount} | ${comparison.baselineMetrics.fakeSuccessCount} |`,
    "",
  ];

  if (comparison.failures.length > 0) {
    pushQaReportListSection(lines, "Gate Failures", comparison.failures);
  }

  lines.push("## Scenario Comparison", "");
  for (const scenario of comparison.scenarioComparisons) {
    lines.push(`### ${scenario.name}`, "");
    lines.push(`- ${comparison.candidateLabel}: ${scenario.candidateStatus}`);
    lines.push(`- ${comparison.baselineLabel}: ${scenario.baselineStatus}`);
    if (scenario.candidateDetails) {
      lines.push(`- ${comparison.candidateLabel} details: ${scenario.candidateDetails}`);
    }
    if (scenario.baselineDetails) {
      lines.push(`- ${comparison.baselineLabel} details: ${scenario.baselineDetails}`);
    }
    lines.push("");
  }

  pushQaReportListSection(lines, "Notes", comparison.notes);

  return lines.join("\n");
}

export function buildQaRuntimeParityReport(params: {
  summary: QaParitySuiteSummary;
}): QaRuntimeParityReport {
  const runtimePair = normalizeRuntimePair(params.summary.run?.runtimePair);
  const providerMode = params.summary.run?.providerMode;
  const requiresLiveUsage = providerMode?.startsWith("live-") === true;
  const driftCounts: Record<RuntimeParityDrift, number> = {
    none: 0,
    "text-only": 0,
    "tool-call-shape": 0,
    "tool-result-shape": 0,
    structural: 0,
    "failure-mode": 0,
  };
  const failures: string[] = [];
  const scenarios: QaRuntimeParityScenarioReport[] = params.summary.scenarios.map((scenario) => {
    const parity = scenario.runtimeParity;
    if (!parity) {
      failures.push(`Missing runtime parity capture for ${scenario.name}.`);
    } else {
      driftCounts[parity.drift] += 1;
    }
    const openclawCell = parity?.cells.openclaw;
    const codexCell = parity?.cells.codex;
    const parityStatus = (parity ? isRuntimeParityResultPass(parity) : scenario.status === "pass")
      ? "pass"
      : "fail";
    const runtimeParityUsage = resolveRuntimeParityUsagePolicy(parity?.runtimeParityUsage);
    const openclawWallClockMs = openclawCell ? openclawCell.wallClockMs : null;
    const codexWallClockMs = codexCell ? codexCell.wallClockMs : null;
    const reportScenario = {
      name: scenario.name,
      status: parityStatus,
      runtimeParityUsage,
      drift: parity ? parity.drift : "missing",
      driftDetails: parity ? parity.driftDetails : scenario.details,
      openclawStatus: openclawCell ? runtimeParityCellStatus(openclawCell) : "missing",
      codexStatus: codexCell ? runtimeParityCellStatus(codexCell) : "missing",
      openclawTokens: openclawCell ? openclawCell.usage.totalTokens : 0,
      codexTokens: codexCell ? codexCell.usage.totalTokens : 0,
      openclawUsage:
        !openclawCell || runtimeParityUsage.expectation === "not-applicable"
          ? null
          : summarizeRuntimeParityCacheUsage(openclawCell.usage),
      codexUsage:
        !codexCell || runtimeParityUsage.expectation === "not-applicable"
          ? null
          : summarizeRuntimeParityCacheUsage(codexCell.usage),
      ...(openclawCell?.cacheDiagnostics === undefined
        ? {}
        : { openclawCacheDiagnostics: openclawCell.cacheDiagnostics }),
      ...(codexCell?.cacheDiagnostics === undefined
        ? {}
        : { codexCacheDiagnostics: codexCell.cacheDiagnostics }),
      openclawToolCalls: openclawCell ? openclawCell.toolCalls.length : 0,
      codexToolCalls: codexCell ? codexCell.toolCalls.length : 0,
      openclawWallClockMs,
      codexWallClockMs,
      ...(openclawCell?.bootstrapWallClockMs === undefined
        ? {}
        : { openclawBootstrapWallClockMs: openclawCell.bootstrapWallClockMs }),
      ...(codexCell?.bootstrapWallClockMs === undefined
        ? {}
        : { codexBootstrapWallClockMs: codexCell.bootstrapWallClockMs }),
      ...compareRuntimeWallClockMs(openclawWallClockMs, codexWallClockMs),
    } satisfies QaRuntimeParityScenarioReport;
    if (!parity) {
      return reportScenario;
    }
    if (parityStatus === "fail") {
      failures.push(
        `${scenario.name} drift=${parity.drift}${parity.driftDetails ? ` (${parity.driftDetails})` : ""}.`,
      );
    }
    if (requiresLiveUsage && runtimeParityUsage.expectation === "assistant-message-required") {
      const missing = [
        reportScenario.openclawTokens > 0
          ? undefined
          : `${reportScenario.openclawStatus === "pass" ? "openclaw" : "openclaw failed"}=0`,
        reportScenario.codexTokens > 0
          ? undefined
          : `${reportScenario.codexStatus === "pass" ? "codex" : "codex failed"}=0`,
      ].filter((entry): entry is string => Boolean(entry));
      if (missing.length > 0) {
        failures.push(
          `${scenario.name} missing live assistant-message usage (${missing.join(", ")}).`,
        );
        return { ...reportScenario, status: "fail" };
      }
    }
    return reportScenario;
  });

  const totalScenarios = params.summary.counts?.total ?? scenarios.length;
  const passedScenarios = scenarios.filter((scenario) => scenario.status === "pass").length;
  const failedScenarios = scenarios.filter((scenario) => scenario.status === "fail").length;
  if (scenarios.length === 0 || totalScenarios <= 0) {
    failures.push("Runtime parity report has no executed scenarios.");
  }
  return {
    runtimePair,
    comparedAt: new Date().toISOString(),
    providerMode,
    primaryModel: params.summary.run?.primaryModel,
    totalScenarios,
    passedScenarios,
    failedScenarios,
    driftCounts,
    scenarios,
    timing: summarizeRuntimeParityTiming(scenarios),
    usage: {
      openclaw: aggregateRuntimeParityCacheUsage(scenarios, "openclaw"),
      codex: aggregateRuntimeParityCacheUsage(scenarios, "codex"),
    },
    pass: failures.length === 0 && failedScenarios === 0,
    failures,
    notes: [
      "Runtime parity fails runtime, transport, and failure-mode drift; structural and tool-shape drift is recorded as advisory when both runtimes complete.",
      "Token totals here are assistant-message usage captured from the normalized transcript, not provider transport payloads.",
      "Cache-hit percentages use cached input divided by cached, uncached, and cache-write input; output tokens are excluded from the denominator.",
      "Wall-clock timings cover each complete QA runtime cell, including gateway, model, and tool execution; they are not provider-reported turn durations.",
    ],
  };
}

function formatRuntimeCacheMisses(diagnostics: RuntimeParityCacheDiagnostics | undefined): string {
  if (!diagnostics) {
    return "N/A";
  }
  return formatCacheMisses(
    diagnostics.cacheTelemetryTurns === 0 ? null : diagnostics.cacheMisses,
    diagnostics.unmeasuredPostWarmTurns,
    "uncached input",
  );
}

export function renderQaRuntimeParityMarkdownReport(report: QaRuntimeParityReport): string {
  const lines = [
    `# OpenClaw Runtime Parity Report — ${report.runtimePair[0]} vs ${report.runtimePair[1]}`,
    "",
    `- Compared at: ${report.comparedAt}`,
    `- Provider mode: ${report.providerMode ?? "unknown"}`,
    `- Primary model: ${report.primaryModel ?? "unknown"}`,
    `- Verdict: ${report.pass ? "pass" : "fail"}`,
    "",
    "## Aggregate Metrics",
    "",
    "| Metric | Value |",
    "| --- | ---: |",
    `| Total scenarios | ${report.totalScenarios} |`,
    `| Passed scenarios | ${report.passedScenarios} |`,
    `| Failed scenarios | ${report.failedScenarios} |`,
    `| No drift | ${report.driftCounts.none} |`,
    `| Text-only drift | ${report.driftCounts["text-only"]} |`,
    `| Tool-call-shape drift | ${report.driftCounts["tool-call-shape"]} |`,
    `| Tool-result-shape drift | ${report.driftCounts["tool-result-shape"]} |`,
    `| Structural drift | ${report.driftCounts.structural} |`,
    `| Failure-mode drift | ${report.driftCounts["failure-mode"]} |`,
    "",
    "## Prompt Cache",
    "",
    "| Runtime | Gross input | Uncached input | Cached input | Cache writes | Output | Total tokens | Cache hit |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    `| openclaw | ${formatRuntimeCacheCount(report.usage.openclaw?.grossInputTokens)} | ${formatRuntimeCacheCount(report.usage.openclaw?.uncachedInputTokens)} | ${formatRuntimeCacheCount(report.usage.openclaw?.cachedInputTokens)} | ${formatRuntimeCacheCount(report.usage.openclaw?.cacheWriteTokens)} | ${formatRuntimeCacheCount(report.usage.openclaw?.outputTokens)} | ${formatRuntimeCacheCount(report.usage.openclaw?.totalTokens)} | ${formatRuntimeCacheHitPercent(report.usage.openclaw?.cacheHitPercent)} |`,
    `| codex | ${formatRuntimeCacheCount(report.usage.codex?.grossInputTokens)} | ${formatRuntimeCacheCount(report.usage.codex?.uncachedInputTokens)} | ${formatRuntimeCacheCount(report.usage.codex?.cachedInputTokens)} | ${formatRuntimeCacheCount(report.usage.codex?.cacheWriteTokens)} | ${formatRuntimeCacheCount(report.usage.codex?.outputTokens)} | ${formatRuntimeCacheCount(report.usage.codex?.totalTokens)} | ${formatRuntimeCacheHitPercent(report.usage.codex?.cacheHitPercent)} |`,
    "",
    "## Runtime Timing",
    "",
    "| Runtime | Total wall time | p50 per scenario | p90 per scenario |",
    "| --- | ---: | ---: | ---: |",
    `| openclaw | ${formatRuntimeWallClockMs(report.timing.openclaw.totalWallClockMs)} | ${formatRuntimeWallClockMs(report.timing.openclaw.p50WallClockMs)} | ${formatRuntimeWallClockMs(report.timing.openclaw.p90WallClockMs)} |`,
    `| codex | ${formatRuntimeWallClockMs(report.timing.codex.totalWallClockMs)} | ${formatRuntimeWallClockMs(report.timing.codex.p50WallClockMs)} | ${formatRuntimeWallClockMs(report.timing.codex.p90WallClockMs)} |`,
    "",
    `- Faster runtime: ${formatRuntimeSpeedComparison(report.timing)}`,
    "",
  ];
  if (report.timing.bootstrap) {
    lines.push(
      "## Gateway Bootstrap (Excluded From Runtime Timing)",
      "",
      "| Runtime | Total bootstrap | p50 per scenario | p90 per scenario |",
      "| --- | ---: | ---: | ---: |",
      `| openclaw | ${formatRuntimeWallClockMs(report.timing.bootstrap.openclaw.totalWallClockMs)} | ${formatRuntimeWallClockMs(report.timing.bootstrap.openclaw.p50WallClockMs)} | ${formatRuntimeWallClockMs(report.timing.bootstrap.openclaw.p90WallClockMs)} |`,
      `| codex | ${formatRuntimeWallClockMs(report.timing.bootstrap.codex.totalWallClockMs)} | ${formatRuntimeWallClockMs(report.timing.bootstrap.codex.p50WallClockMs)} | ${formatRuntimeWallClockMs(report.timing.bootstrap.codex.p90WallClockMs)} |`,
      "",
    );
  }
  if (report.failures.length > 0) {
    pushQaReportListSection(lines, "Gate Failures", report.failures);
  }
  lines.push("## Scenario Comparison", "");
  for (const scenario of report.scenarios) {
    const usageNotApplicable = scenario.runtimeParityUsage.expectation === "not-applicable";
    const openclawTokens = usageNotApplicable ? "N/A" : String(scenario.openclawTokens);
    const codexTokens = usageNotApplicable ? "N/A" : String(scenario.codexTokens);
    lines.push(`### ${scenario.name}`, "");
    lines.push(`- status: ${scenario.status}`);
    lines.push(`- drift: ${scenario.drift}`);
    lines.push(
      `- openclaw: ${scenario.openclawStatus} (${scenario.openclawToolCalls} tool calls, ${openclawTokens} tokens)`,
    );
    lines.push(
      `- codex: ${scenario.codexStatus} (${scenario.codexToolCalls} tool calls, ${codexTokens} tokens)`,
    );
    lines.push(
      `- wall time: openclaw ${formatRuntimeWallClockMs(scenario.openclawWallClockMs)}; codex ${formatRuntimeWallClockMs(scenario.codexWallClockMs)}; ${formatRuntimeSpeedComparison(scenario)}`,
    );
    if (
      scenario.openclawBootstrapWallClockMs !== undefined ||
      scenario.codexBootstrapWallClockMs !== undefined
    ) {
      lines.push(
        `- gateway bootstrap (excluded): openclaw ${formatRuntimeWallClockMs(scenario.openclawBootstrapWallClockMs ?? null)}; codex ${formatRuntimeWallClockMs(scenario.codexBootstrapWallClockMs ?? null)}`,
      );
    }
    lines.push(
      `- prompt cache: openclaw ${formatRuntimeCacheHitPercent(scenario.openclawUsage?.cacheHitPercent)} (${formatRuntimeCacheCount(scenario.openclawUsage?.cachedInputTokens)} cached, ${formatRuntimeCacheCount(scenario.openclawUsage?.uncachedInputTokens)} uncached input); codex ${formatRuntimeCacheHitPercent(scenario.codexUsage?.cacheHitPercent)} (${formatRuntimeCacheCount(scenario.codexUsage?.cachedInputTokens)} cached, ${formatRuntimeCacheCount(scenario.codexUsage?.uncachedInputTokens)} uncached input)`,
    );
    lines.push(
      `- post-warm cache misses: openclaw ${formatRuntimeCacheMisses(scenario.openclawCacheDiagnostics)}; codex ${formatRuntimeCacheMisses(scenario.codexCacheDiagnostics)}`,
    );
    if (scenario.runtimeParityUsage.expectation === "not-applicable") {
      lines.push(`- assistant-message usage: N/A (${scenario.runtimeParityUsage.reason})`);
    }
    if (scenario.driftDetails) {
      lines.push(`- details: ${scenario.driftDetails}`);
    }
    lines.push("");
  }
  pushQaReportListSection(lines, "Notes", report.notes);
  return lines.join("\n");
}
