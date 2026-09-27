import {
  aggregateRuntimeParityCacheUsage,
  summarizeRuntimeParityCacheUsage,
} from "./agentic-parity-cache-usage.js";
import type {
  QaRuntimeParityReport,
  QaRuntimeParityScenarioReport,
} from "./agentic-parity-runtime-report-contract.js";
// Qa Lab plugin module implements agentic parity report behavior.
import {
  QA_AGENTIC_PARITY_SCENARIO_TITLES,
  QA_AGENTIC_PARITY_TOOL_BACKED_SCENARIO_TITLES,
} from "./agentic-parity.js";
import type { QaReportScenario as QaParityReportScenario } from "./report.js";
import {
  compareRuntimeWallClockMs,
  summarizeRuntimeParityTiming,
} from "./runtime-parity-timing.js";
import type { RuntimeId, RuntimeParityDrift, RuntimeParityResult } from "./runtime-parity.js";
import {
  isRuntimeParityResultPass,
  normalizeRuntimePair,
  resolveRuntimeParityUsagePolicy,
  runtimeParityCellStatus,
} from "./runtime-parity.js";

export { renderQaRuntimeParityMarkdownReport } from "./agentic-parity-runtime-markdown.js";

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
  scenarios: QaParityReportScenario[];
  counts?: {
    total?: number;
    passed?: number;
    failed?: number;
  };
  run?: QaParityRunBlock;
};

type QaRuntimeParitySuiteScenario = QaParityReportScenario & {
  runtimeParity?: RuntimeParityResult;
};

export type QaRuntimeParitySuiteSummary = Omit<QaParitySuiteSummary, "scenarios"> & {
  scenarios: QaRuntimeParitySuiteScenario[];
};

type QaAgenticParityMetrics = {
  totalScenarios: number;
  passedScenarios: number;
  failedScenarios: number;
  completionRate: number;
  unintendedStopCount: number;
  unintendedStopRate: number;
  validToolCallCount: number;
  validToolCallRate: number;
  fakeSuccessCount: number;
};

type QaAgenticParityScenarioComparison = {
  name: string;
  candidateStatus: "pass" | "fail" | "skip" | "missing";
  baselineStatus: "pass" | "fail" | "skip" | "missing";
  candidateDetails?: string;
  baselineDetails?: string;
};

type QaAgenticParityComparison = {
  candidateLabel: string;
  baselineLabel: string;
  comparedAt: string;
  candidateMetrics: QaAgenticParityMetrics;
  baselineMetrics: QaAgenticParityMetrics;
  scenarioComparisons: QaAgenticParityScenarioComparison[];
  pass: boolean;
  failures: string[];
  notes: string[];
};

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

function scenarioText(scenario: QaParityReportScenario) {
  const parts = [scenario.details ?? ""];
  for (const step of scenario.steps ?? []) {
    parts.push(step.details ?? "");
  }
  return parts.filter(Boolean).join("\n");
}

function scenarioHasPattern(
  scenario: QaParityReportScenario,
  patterns: readonly RegExp[],
): boolean {
  const text = scenarioText(scenario);
  return text.length > 0 && patterns.some((pattern) => pattern.test(text));
}

function scenarioRuntimeParity(scenario: QaParityReportScenario): RuntimeParityResult | undefined {
  return (scenario as QaRuntimeParitySuiteScenario).runtimeParity;
}

function scenarioHasRuntimeToolCallEvidence(scenario: QaParityReportScenario): boolean {
  const parity = scenarioRuntimeParity(scenario);
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
): QaAgenticParityMetrics {
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

function buildRuntimeParityDriftCounts(): Record<RuntimeParityDrift, number> {
  return {
    none: 0,
    "text-only": 0,
    "tool-call-shape": 0,
    "tool-result-shape": 0,
    structural: 0,
    "failure-mode": 0,
  };
}

function isLiveProviderMode(providerMode: string | undefined) {
  return providerMode?.startsWith("live-") === true;
}

function describeLiveUsageFailure(scenarioName: string, scenario: QaRuntimeParityScenarioReport) {
  const missing = [
    scenario.openclawTokens > 0
      ? undefined
      : `${scenario.openclawStatus === "pass" ? "openclaw" : "openclaw failed"}=0`,
    scenario.codexTokens > 0
      ? undefined
      : `${scenario.codexStatus === "pass" ? "codex" : "codex failed"}=0`,
  ].filter((entry): entry is string => Boolean(entry));
  if (missing.length === 0) {
    return undefined;
  }
  return `${scenarioName} missing live assistant-message usage (${missing.join(", ")}).`;
}

function requiredCoverageStatus(
  scenario: QaParityReportScenario | undefined,
): "pass" | "fail" | "skip" | "missing" {
  return scenario ? normalizeScenarioStatus(scenario.status) : "missing";
}

type StructuredQaParityLabel = {
  provider: string;
  model: string;
};

// Display labels are not provider/model provenance identifiers.
function parseStructuredLabelRef(label: string): StructuredQaParityLabel | null {
  const trimmed = label.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed !== trimmed.toLowerCase()) {
    return null;
  }
  const separatorMatch = /^([a-z0-9][a-z0-9-]*)[/:]([a-z0-9][a-z0-9._-]*)$/.exec(trimmed);
  if (!separatorMatch) {
    return null;
  }
  return {
    provider: separatorMatch[1] ?? "",
    model: separatorMatch[2] ?? "",
  };
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
  const labelRef = parseStructuredLabelRef(params.label);
  if (!labelRef) {
    return;
  }
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
  throw new QaParityLabelMismatchError({
    role: params.role,
    label: params.label,
    runProvider,
    runModel,
  });
}

class QaParityLabelMismatchError extends Error {
  readonly role: "candidate" | "baseline";
  readonly label: string;
  readonly runProvider: string;
  readonly runModel: string;

  constructor(params: {
    role: "candidate" | "baseline";
    label: string;
    runProvider: string;
    runModel: string;
  }) {
    super(
      `${params.role} summary run.primaryProvider=${params.runProvider} and run.primaryModel=${params.runModel} do not match --${params.role}-label=${params.label}. ` +
        `Check that the --candidate-summary / --baseline-summary paths weren't swapped.`,
    );
    this.name = "QaParityLabelMismatchError";
    this.role = params.role;
    this.label = params.label;
    this.runProvider = params.runProvider;
    this.runModel = params.runModel;
  }
}

export function buildQaAgenticParityComparison(params: {
  candidateLabel: string;
  baselineLabel: string;
  candidateSummary: QaParitySuiteSummary;
  baselineSummary: QaParitySuiteSummary;
  comparedAt?: string;
}): QaAgenticParityComparison {
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
  const requiredScenarioStatuses = QA_AGENTIC_PARITY_SCENARIO_TITLES.map((name) => {
    const candidate = candidateByName.get(name);
    const baseline = baselineByName.get(name);
    return {
      name,
      candidateStatus: requiredCoverageStatus(candidate),
      baselineStatus: requiredCoverageStatus(baseline),
    };
  });
  const requiredScenarioCoverage = requiredScenarioStatuses.filter(
    (scenario) =>
      scenario.candidateStatus === "missing" ||
      scenario.baselineStatus === "missing" ||
      scenario.candidateStatus === "skip" ||
      scenario.baselineStatus === "skip",
  );
  for (const scenario of requiredScenarioCoverage) {
    failures.push(
      `Missing required parity scenario coverage for ${scenario.name}: ${params.candidateLabel}=${scenario.candidateStatus}, ${params.baselineLabel}=${scenario.baselineStatus}.`,
    );
  }
  // Shared failures still fail the gate; missing/skipped cells were reported above.
  const requiredScenarioFailures = requiredScenarioStatuses.filter(
    (scenario) =>
      scenario.candidateStatus !== "missing" &&
      scenario.baselineStatus !== "missing" &&
      scenario.candidateStatus !== "skip" &&
      scenario.baselineStatus !== "skip" &&
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
    comparedAt: params.comparedAt ?? new Date().toISOString(),
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
    lines.push("## Gate Failures", "");
    for (const failure of comparison.failures) {
      lines.push(`- ${failure}`);
    }
    lines.push("");
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

  lines.push("## Notes", "");
  for (const note of comparison.notes) {
    lines.push(`- ${note}`);
  }
  lines.push("");

  return lines.join("\n");
}

export function buildQaRuntimeParityReport(params: {
  summary: QaRuntimeParitySuiteSummary;
  comparedAt?: string;
}): QaRuntimeParityReport {
  const runtimePair = normalizeRuntimePair(params.summary.run?.runtimePair);
  const providerMode = params.summary.run?.providerMode;
  const requiresLiveUsage = isLiveProviderMode(providerMode);
  const driftCounts = buildRuntimeParityDriftCounts();
  const failures: string[] = [];
  const scenarios: QaRuntimeParityScenarioReport[] = params.summary.scenarios.map((scenario) => {
    const parity = scenario.runtimeParity;
    if (!parity) {
      failures.push(`Missing runtime parity capture for ${scenario.name}.`);
      return {
        name: scenario.name,
        status: scenario.status === "pass" ? "pass" : "fail",
        runtimeParityUsage: resolveRuntimeParityUsagePolicy(undefined),
        drift: "missing",
        driftDetails: scenario.details,
        openclawStatus: "missing",
        codexStatus: "missing",
        openclawTokens: 0,
        codexTokens: 0,
        openclawUsage: null,
        codexUsage: null,
        openclawToolCalls: 0,
        codexToolCalls: 0,
        openclawWallClockMs: null,
        codexWallClockMs: null,
        fasterRuntime: null,
        speedupPercent: null,
      } satisfies QaRuntimeParityScenarioReport;
    }
    driftCounts[parity.drift] += 1;
    const openclawCell = parity.cells.openclaw;
    const codexCell = parity.cells.codex;
    const openclawStatus = runtimeParityCellStatus(openclawCell);
    const codexStatus = runtimeParityCellStatus(codexCell);
    const parityStatus = isRuntimeParityResultPass(parity) ? "pass" : "fail";
    const runtimeParityUsage = resolveRuntimeParityUsagePolicy(parity.runtimeParityUsage);
    const reportScenario = {
      name: scenario.name,
      status: parityStatus,
      runtimeParityUsage,
      drift: parity.drift,
      driftDetails: parity.driftDetails,
      openclawStatus,
      codexStatus,
      openclawTokens: openclawCell.usage.totalTokens,
      codexTokens: codexCell.usage.totalTokens,
      openclawUsage:
        runtimeParityUsage.expectation === "not-applicable"
          ? null
          : summarizeRuntimeParityCacheUsage(openclawCell.usage),
      codexUsage:
        runtimeParityUsage.expectation === "not-applicable"
          ? null
          : summarizeRuntimeParityCacheUsage(codexCell.usage),
      ...(openclawCell.cacheDiagnostics === undefined
        ? {}
        : { openclawCacheDiagnostics: openclawCell.cacheDiagnostics }),
      ...(codexCell.cacheDiagnostics === undefined
        ? {}
        : { codexCacheDiagnostics: codexCell.cacheDiagnostics }),
      openclawToolCalls: openclawCell.toolCalls.length,
      codexToolCalls: codexCell.toolCalls.length,
      openclawWallClockMs: openclawCell.wallClockMs,
      codexWallClockMs: codexCell.wallClockMs,
      ...(openclawCell.bootstrapWallClockMs === undefined
        ? {}
        : { openclawBootstrapWallClockMs: openclawCell.bootstrapWallClockMs }),
      ...(codexCell.bootstrapWallClockMs === undefined
        ? {}
        : { codexBootstrapWallClockMs: codexCell.bootstrapWallClockMs }),
      ...compareRuntimeWallClockMs(openclawCell.wallClockMs, codexCell.wallClockMs),
    } satisfies QaRuntimeParityScenarioReport;
    if (parityStatus === "fail") {
      failures.push(
        `${scenario.name} drift=${parity.drift}${parity.driftDetails ? ` (${parity.driftDetails})` : ""}.`,
      );
    }
    const usageFailure =
      requiresLiveUsage && runtimeParityUsage.expectation === "assistant-message-required"
        ? describeLiveUsageFailure(scenario.name, reportScenario)
        : undefined;
    if (usageFailure) {
      failures.push(usageFailure);
      return { ...reportScenario, status: "fail" };
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
    comparedAt: params.comparedAt ?? new Date().toISOString(),
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
