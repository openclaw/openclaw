import { QA_AGENTIC_PARITY_SCENARIO_TITLES } from "./agentic-parity.js";

export type QaParityReportStep = {
  name: string;
  status: "pass" | "fail" | "skip";
  details?: string;
};

export type QaParityReportScenario = {
  name: string;
  status: "pass" | "fail" | "skip";
  details?: string;
  steps?: QaParityReportStep[];
};

/**
 * Optional self-describing run metadata written by PR L (#64789). Before
 * that PR merges, older summaries only have `scenarios` + `counts`; the
 * parity report treats a missing `run` block as "unknown provenance" and
 * skips the label-match verification rather than failing open.
 */
export type QaParityRunBlock = {
  primaryProvider?: string;
  primaryModel?: string;
  providerMode?: string;
  scenarioIds?: readonly string[] | null;
};

export type QaParitySuiteSummary = {
  scenarios: QaParityReportScenario[];
  counts?: {
    total?: number;
    passed?: number;
    failed?: number;
  };
  /** Self-describing run metadata — see PR L #64789 for the writer side. */
  run?: QaParityRunBlock;
};

export type QaAgenticParityMetrics = {
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

export type QaAgenticParityScenarioComparison = {
  name: string;
  candidateStatus: "pass" | "fail" | "skip" | "missing";
  baselineStatus: "pass" | "fail" | "skip" | "missing";
  candidateDetails?: string;
  baselineDetails?: string;
};

export type QaAgenticParityComparison = {
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

// Failure-tone patterns: a passing scenario whose details text matches any
// of these is treated as a "fake success" — the scenario is marked pass but
// the supporting text reveals something went wrong. Adding new patterns here
// widens the net for bad prose that correlates with runtime failure modes.
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

// Positive-tone patterns: a passing scenario whose details read as plausible
// self-congratulatory prose ("Successfully completed", "Done.", "Task
// executed successfully") is ALSO suspicious — it's the shape of a fake
// success that evades the failure-tone net above. Criterion 2 of the
// GPT-5.4 parity completion gate (#64227) specifically targets this: a
// model that says "I did the thing" without actually doing it should not
// count as a pass. A positive-tone pattern only fires as a suspicious pass
// when the scenario is ALSO missing a recorded tool-call assertion in its
// prose — see `scenarioLacksToolCallEvidence` below. That keeps the check
// from false-positiving on legitimate tool-mediated scenarios that happen
// to include "successfully" in their details.
const SUSPICIOUS_PASS_POSITIVE_TONE_PATTERNS = [
  /successfully (?:completed|executed|finished|handled|delegated|ran)/i,
  /\bdone\.?\s*$/im,
  /task (?:done|executed|completed|handled|finished) successfully/i,
  /everything (?:worked|ran) (?:as expected|successfully)/i,
  /finished the operation/i,
  /all (?:steps|tasks) (?:completed|finished) successfully/i,
] as const;

// Evidence a scenario actually did its tool-mediated work. A scenario
// whose details contain any of these is considered tool-backed and is
// exempt from the positive-tone fake-success check. The patterns match
// the `plannedToolName=...` / `tool call succeeded` / `executed tool`
// phrases scenarios emit when their `/debug/requests` assertions fire
// (PR J #64681), so a scenario with real tool evidence is never flagged
// even if its prose also includes "successfully".
const TOOL_CALL_EVIDENCE_PATTERNS = [
  /plannedToolName/i,
  /tool call (?:succeeded|completed|returned)/i,
  /executed tool/i,
  /function_call_output/i,
  /tool_use/i,
] as const;

function scenarioLacksToolCallEvidence(scenario: QaParityReportScenario): boolean {
  const text = scenarioText(scenario);
  if (text.length === 0) {
    return true;
  }
  return !TOOL_CALL_EVIDENCE_PATTERNS.some((pattern) => pattern.test(text));
}

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

export function computeQaAgenticParityMetrics(
  summary: QaParitySuiteSummary,
): QaAgenticParityMetrics {
  const scenarios = summary.scenarios.map((scenario) => ({
    ...scenario,
    status: normalizeScenarioStatus(scenario.status),
  }));
  const totalScenarios = summary.counts?.total ?? scenarios.length;
  const passedScenarios =
    summary.counts?.passed ?? scenarios.filter((scenario) => scenario.status === "pass").length;
  const failedScenarios =
    summary.counts?.failed ?? scenarios.filter((scenario) => scenario.status === "fail").length;
  const unintendedStopCount = scenarios.filter(
    (scenario) =>
      scenario.status !== "pass" && scenarioHasPattern(scenario, UNINTENDED_STOP_PATTERNS),
  ).length;
  const fakeSuccessCount = scenarios.filter((scenario) => {
    if (scenario.status !== "pass") {
      return false;
    }
    // Failure-tone patterns catch obviously-broken passes regardless of
    // whether the scenario shows tool-call evidence — "timed out" under a
    // pass is always fake.
    if (scenarioHasPattern(scenario, SUSPICIOUS_PASS_FAILURE_TONE_PATTERNS)) {
      return true;
    }
    // Positive-tone patterns only fire when the scenario doesn't also show
    // real tool-call evidence. A legitimate tool-mediated pass with
    // self-congratulatory prose stays clean; a prose-only pass with
    // "Successfully completed the delegation" gets flagged.
    if (
      scenarioHasPattern(scenario, SUSPICIOUS_PASS_POSITIVE_TONE_PATTERNS) &&
      scenarioLacksToolCallEvidence(scenario)
    ) {
      return true;
    }
    return false;
  }).length;

  // First-wave parity scenarios are all tool-mediated tasks, so a passing scenario is our
  // verified unit of valid tool-backed execution in this harness.
  const validToolCallCount = passedScenarios;

  const rate = (value: number) => (totalScenarios > 0 ? value / totalScenarios : 0);
  return {
    totalScenarios,
    passedScenarios,
    failedScenarios,
    completionRate: rate(passedScenarios),
    unintendedStopCount,
    unintendedStopRate: rate(unintendedStopCount),
    validToolCallCount,
    validToolCallRate: rate(validToolCallCount),
    fakeSuccessCount,
  };
}

function formatPercent(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

function requiredCoverageStatus(
  scenario: QaParityReportScenario | undefined,
): "pass" | "fail" | "skip" | "missing" {
  return scenario ? normalizeScenarioStatus(scenario.status) : "missing";
}

function scopeSummaryToParityPack(
  summary: QaParitySuiteSummary,
  parityTitleSet: ReadonlySet<string>,
): QaParitySuiteSummary {
  // The parity verdict must only consider the declared parity scenarios
  // (the full first-wave + second-wave pack from QA_AGENTIC_PARITY_SCENARIOS).
  // Drop `counts` so the metric helper recomputes totals from the filtered
  // scenario list instead of inheriting the caller's full-suite counters.
  return {
    scenarios: summary.scenarios.filter((scenario) => parityTitleSet.has(scenario.name)),
    ...(summary.run ? { run: summary.run } : {}),
  };
}

/**
 * Normalize a provider label into the `provider` half of a `provider/model`
 * string. Accepts bare provider names (`"openai"`), provider/model tuples
 * (`"openai/gpt-5.4"`), and colon-separated forms (`"openai:gpt-5.4"`).
 * Returns the provider portion lowercased so comparisons against the
 * `run.primaryProvider` field don't get confused by case drift.
 */
function extractProviderFromLabel(label: string): string | null {
  const trimmed = label.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const separatorMatch = /^([^/:]+)[/:]/.exec(trimmed);
  if (separatorMatch) {
    return separatorMatch[1]?.toLowerCase() ?? null;
  }
  return trimmed.toLowerCase();
}

/**
 * Verify the `run.primaryProvider` field on a summary matches the caller-
 * supplied label. PR L #64789 ships the `run` block; before it lands, older
 * summaries don't have the field and this check is a no-op.
 *
 * Throws `QaParityLabelMismatchError` when the summary reports a different
 * provider than the caller claimed — this catches the "swapped candidate
 * and baseline summary paths" footgun the earlier adversarial review
 * flagged. Returns silently when the field is absent (legacy summaries) or
 * when the fields match.
 */
function verifySummaryLabelMatch(params: {
  summary: QaParitySuiteSummary;
  label: string;
  role: "candidate" | "baseline";
}): void {
  const runProvider = params.summary.run?.primaryProvider?.trim();
  if (!runProvider) {
    return;
  }
  const labelProvider = extractProviderFromLabel(params.label);
  if (!labelProvider) {
    return;
  }
  if (runProvider.toLowerCase() === labelProvider) {
    return;
  }
  throw new QaParityLabelMismatchError({
    role: params.role,
    label: params.label,
    runProvider,
  });
}

export class QaParityLabelMismatchError extends Error {
  readonly role: "candidate" | "baseline";
  readonly label: string;
  readonly runProvider: string;

  constructor(params: { role: "candidate" | "baseline"; label: string; runProvider: string }) {
    super(
      `${params.role} summary run.primaryProvider=${params.runProvider} does not match --${params.role}-label=${params.label}. ` +
        `Check that the --candidate-summary / --baseline-summary paths weren't swapped.`,
    );
    this.name = "QaParityLabelMismatchError";
    this.role = params.role;
    this.label = params.label;
    this.runProvider = params.runProvider;
  }
}

export function buildQaAgenticParityComparison(params: {
  candidateLabel: string;
  baselineLabel: string;
  candidateSummary: QaParitySuiteSummary;
  baselineSummary: QaParitySuiteSummary;
  comparedAt?: string;
}): QaAgenticParityComparison {
  // Precondition: verify the `run.primaryProvider` field on each summary
  // matches the caller-supplied label (when the `run` block is present).
  // Throws `QaParityLabelMismatchError` on mismatch so the release gate
  // fails loudly instead of silently producing a reversed verdict when an
  // operator swaps the --candidate-summary and --baseline-summary paths.
  // Legacy summaries without a `run` block are accepted as-is.
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
  // Rates and fake-success counts are computed from the parity-scoped summaries only,
  // so extra non-parity scenarios in the input (for example when a caller feeds a full
  // qa-suite-summary.json rather than a --parity-pack agentic run) cannot influence
  // the gate verdict.
  const candidateMetrics = computeQaAgenticParityMetrics(
    scopeSummaryToParityPack(params.candidateSummary, parityTitleSet),
  );
  const baselineMetrics = computeQaAgenticParityMetrics(
    scopeSummaryToParityPack(params.baselineSummary, parityTitleSet),
  );

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
      return {
        name,
        candidateStatus: candidate ? normalizeScenarioStatus(candidate.status) : "missing",
        baselineStatus: baseline ? normalizeScenarioStatus(baseline.status) : "missing",
        ...(candidate?.details ? { candidateDetails: candidate.details } : {}),
        ...(baseline?.details ? { baselineDetails: baseline.details } : {}),
      } satisfies QaAgenticParityScenarioComparison;
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
  // Required parity scenarios that ran on both sides but FAILED also fail
  // the gate. Without this check, a run where both models fail the same
  // required scenarios still produced pass=true, because the downstream
  // metric comparisons are purely relative (candidate vs baseline) and
  // the suspicious-pass fake-success check only catches passes that carry
  // failure-sounding details. Excluding missing/skip here keeps operator
  // output from double-counting the same scenario with two lines.
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
  // Required parity scenarios are already reported via `requiredScenarioCoverage`
  // above; excluding them here keeps the operator-facing failure list from
  // double-counting the same missing scenario (one "Missing required parity scenario
  // coverage for X" line plus a "Scenario coverage mismatch for X" line on the same
  // scenario).
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
  // Title is parametrized from the candidate / baseline labels so reports
  // for any candidate/baseline pair (not only gpt-5.4 vs opus 4.6) render
  // with an accurate header. The default CLI labels are still
  // openai/gpt-5.4 vs anthropic/claude-opus-4-6, but the helper works for
  // any parity comparison a caller configures.
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
