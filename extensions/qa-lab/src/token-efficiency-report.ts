import type { RuntimeId, RuntimeParityCell, RuntimeParityResult } from "./runtime-parity.js";

export type TokenEfficiencyRuntimeUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  toolCallCount: number;
  promptChars: number;
  projectContextChars: number;
  skillPromptChars: number;
  toolSummaryChars: number;
  toolSchemaChars: number;
  transcriptChars: number;
  costUsd?: number;
};

export type TokenEfficiencyRow = {
  scenarioId: string;
  usageSource: "live-usage" | "mock-estimate";
  pi: TokenEfficiencyRuntimeUsage;
  codex: TokenEfficiencyRuntimeUsage;
  deltaPercent: number;
  costDeltaPercent?: number;
  flagged: boolean;
  costFlagged: boolean;
  toolsUsed: string[];
};

export type TokenEfficiencyReport = {
  status: "evaluated" | "estimated" | "skipped";
  runtimePair: [RuntimeId, RuntimeId];
  generatedAt: string;
  providerMode?: string;
  thresholdPercent: number;
  rows: TokenEfficiencyRow[];
  aggregate: {
    pi: { totalTokens: number; p50PerTurn: number; p90PerTurn: number; costUsd?: number };
    codex: { totalTokens: number; p50PerTurn: number; p90PerTurn: number; costUsd?: number };
    deltaPercent: number;
    costDeltaPercent?: number;
    flaggedScenarios: string[];
    costFlaggedScenarios: string[];
  };
  pass: boolean;
  failures: string[];
  skipReason?: string;
  notes: string[];
};

export type TokenEfficiencySuiteSummary = {
  scenarios: Array<{
    name: string;
    status: "pass" | "fail" | "skip";
    runtimeParity?: RuntimeParityResult;
  }>;
  run?: {
    providerMode?: string;
    runtimePair?: [RuntimeId, RuntimeId] | null;
  };
};

export type BuildTokenEfficiencyReportParams = {
  summary: TokenEfficiencySuiteSummary;
  generatedAt?: string;
  thresholdPercent?: number;
};

type TokenEfficiencyFailure = {
  scenarioId: string;
  message: string;
};

const LIVE_PROVIDER_MODE = "live-frontier";
const MOCK_ESTIMATE_PROVIDER_RE = /\bmock\b/i;
const DEFAULT_THRESHOLD_PERCENT = 15;
const ZERO_AGGREGATE: TokenEfficiencyReport["aggregate"] = {
  pi: { totalTokens: 0, p50PerTurn: 0, p90PerTurn: 0 },
  codex: { totalTokens: 0, p50PerTurn: 0, p90PerTurn: 0 },
  deltaPercent: 0,
  flaggedScenarios: [],
  costFlaggedScenarios: [],
};

function normalizeRuntimePair(
  pair: [RuntimeId, RuntimeId] | null | undefined,
): [RuntimeId, RuntimeId] {
  if (pair?.[0] && pair?.[1]) {
    return pair;
  }
  return ["pi", "codex"];
}

function normalizeTokenCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function normalizeOptionalCost(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) ? Math.max(0, value) : undefined;
}

function readPromptReportNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function cellPromptStats(cell: RuntimeParityCell) {
  const report = cell.systemPromptReport;
  const toolEntries = Array.isArray(report?.tools?.entries) ? report.tools.entries : [];
  return {
    promptChars: readPromptReportNumber(report?.systemPrompt?.chars),
    projectContextChars: readPromptReportNumber(report?.systemPrompt?.projectContextChars),
    skillPromptChars: readPromptReportNumber(report?.skills?.promptChars),
    toolSummaryChars: toolEntries.reduce(
      (sum, entry) => sum + readPromptReportNumber(entry.summaryChars),
      0,
    ),
    toolSchemaChars: readPromptReportNumber(report?.tools?.schemaChars),
    transcriptChars: cell.transcriptBytes.length,
  };
}

function estimateTokensFromChars(chars: number): number {
  return Math.ceil(Math.max(0, chars) / 4);
}

function cellUsage(
  cell: RuntimeParityCell,
  usageSource: TokenEfficiencyRow["usageSource"],
): TokenEfficiencyRuntimeUsage {
  const stats = cellPromptStats(cell);
  if (usageSource === "mock-estimate") {
    const inputChars =
      stats.promptChars +
      stats.projectContextChars +
      stats.skillPromptChars +
      stats.toolSummaryChars +
      stats.toolSchemaChars +
      stats.transcriptChars;
    const outputChars = cell.finalText.length + cell.toolCalls.length * 80;
    const inputTokens = estimateTokensFromChars(inputChars);
    const outputTokens = estimateTokensFromChars(outputChars);
    return {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      toolCallCount: cell.toolCalls.length,
      ...stats,
    };
  }
  return {
    inputTokens: normalizeTokenCount(cell.usage.inputTokens),
    outputTokens: normalizeTokenCount(cell.usage.outputTokens),
    totalTokens: normalizeTokenCount(cell.usage.totalTokens),
    toolCallCount: cell.toolCalls.length,
    ...(normalizeOptionalCost(cell.usage.costUsd) !== undefined
      ? { costUsd: normalizeOptionalCost(cell.usage.costUsd) }
      : {}),
    ...stats,
  };
}

function deltaPercent(piTotalTokens: number, codexTotalTokens: number): number {
  if (piTotalTokens === 0) {
    return codexTotalTokens === 0 ? 0 : 100;
  }
  return ((codexTotalTokens - piTotalTokens) / piTotalTokens) * 100;
}

function optionalDeltaPercent(
  piTotalCost: number | undefined,
  codexTotalCost: number | undefined,
): number | undefined {
  if (piTotalCost === undefined || codexTotalCost === undefined) {
    return undefined;
  }
  return deltaPercent(piTotalCost, codexTotalCost);
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].toSorted((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? 0;
}

function toolNamesForCells(pi: RuntimeParityCell, codex: RuntimeParityCell): string[] {
  return [...new Set([...pi.toolCalls, ...codex.toolCalls].map((call) => call.tool))].toSorted(
    (left, right) => left.localeCompare(right),
  );
}

function buildRow(
  result: RuntimeParityResult,
  thresholdPercent: number,
  usageSource: TokenEfficiencyRow["usageSource"],
): TokenEfficiencyRow {
  const pi = cellUsage(result.cells.pi, usageSource);
  const codex = cellUsage(result.cells.codex, usageSource);
  const delta = deltaPercent(pi.totalTokens, codex.totalTokens);
  const costDelta = optionalDeltaPercent(pi.costUsd, codex.costUsd);
  return {
    scenarioId: result.scenarioId,
    usageSource,
    pi,
    codex,
    deltaPercent: delta,
    ...(costDelta !== undefined ? { costDeltaPercent: costDelta } : {}),
    flagged: delta > thresholdPercent,
    costFlagged: costDelta !== undefined && costDelta > thresholdPercent,
    toolsUsed: toolNamesForCells(result.cells.pi, result.cells.codex),
  };
}

function buildAggregate(rows: readonly TokenEfficiencyRow[]): TokenEfficiencyReport["aggregate"] {
  const piTotals = rows.map((row) => row.pi.totalTokens);
  const codexTotals = rows.map((row) => row.codex.totalTokens);
  const piTotalTokens = piTotals.reduce((sum, value) => sum + value, 0);
  const codexTotalTokens = codexTotals.reduce((sum, value) => sum + value, 0);
  const piCostValues = rows
    .map((row) => row.pi.costUsd)
    .filter((value): value is number => value !== undefined);
  const codexCostValues = rows
    .map((row) => row.codex.costUsd)
    .filter((value): value is number => value !== undefined);
  const piCostUsd =
    piCostValues.length > 0 ? piCostValues.reduce((sum, value) => sum + value, 0) : undefined;
  const codexCostUsd =
    codexCostValues.length > 0 ? codexCostValues.reduce((sum, value) => sum + value, 0) : undefined;
  const costDelta = optionalDeltaPercent(piCostUsd, codexCostUsd);
  return {
    pi: {
      totalTokens: piTotalTokens,
      p50PerTurn: percentile(piTotals, 50),
      p90PerTurn: percentile(piTotals, 90),
      ...(piCostUsd !== undefined ? { costUsd: piCostUsd } : {}),
    },
    codex: {
      totalTokens: codexTotalTokens,
      p50PerTurn: percentile(codexTotals, 50),
      p90PerTurn: percentile(codexTotals, 90),
      ...(codexCostUsd !== undefined ? { costUsd: codexCostUsd } : {}),
    },
    deltaPercent: deltaPercent(piTotalTokens, codexTotalTokens),
    ...(costDelta !== undefined ? { costDeltaPercent: costDelta } : {}),
    flaggedScenarios: rows
      .filter((row) => row.flagged || row.costFlagged)
      .map((row) => row.scenarioId),
    costFlaggedScenarios: rows.filter((row) => row.costFlagged).map((row) => row.scenarioId),
  };
}

function liveCellFailures(
  scenarioId: string,
  runtime: RuntimeId,
  cell: RuntimeParityCell,
): TokenEfficiencyFailure[] {
  const failures: TokenEfficiencyFailure[] = [];
  if (cell.runtimeErrorClass) {
    failures.push({
      scenarioId,
      message: `${scenarioId} ${runtime} runtimeErrorClass=${cell.runtimeErrorClass}`,
    });
  }
  if (cell.transportErrorClass) {
    failures.push({
      scenarioId,
      message: `${scenarioId} ${runtime} transportErrorClass=${cell.transportErrorClass}`,
    });
  }
  if (!Number.isFinite(cell.usage.totalTokens) || cell.usage.totalTokens <= 0) {
    failures.push({
      scenarioId,
      message: `${scenarioId} ${runtime} live usage totalTokens=${String(cell.usage.totalTokens)}`,
    });
  }
  return failures;
}

function liveEvidenceFailures(summary: TokenEfficiencySuiteSummary): TokenEfficiencyFailure[] {
  const failures: TokenEfficiencyFailure[] = [];
  for (const scenario of summary.scenarios) {
    const scenarioId = scenario.runtimeParity?.scenarioId ?? scenario.name;
    if (!scenario.runtimeParity) {
      failures.push({
        scenarioId,
        message: `${scenarioId} missing runtime parity result`,
      });
      continue;
    }
    if (scenario.status !== "pass") {
      failures.push({
        scenarioId,
        message: `${scenarioId} scenario status=${scenario.status}`,
      });
    }
    if (scenario.runtimeParity.drift === "failure-mode") {
      failures.push({
        scenarioId,
        message: `${scenarioId} drift=failure-mode`,
      });
    }
    failures.push(...liveCellFailures(scenarioId, "pi", scenario.runtimeParity.cells.pi));
    failures.push(...liveCellFailures(scenarioId, "codex", scenario.runtimeParity.cells.codex));
  }
  return failures;
}

function skipReasonForProviderMode(providerMode: string | undefined): string {
  return `skipped - token efficiency is live-only; providerMode=${providerMode ?? "unknown"} is not live-frontier`;
}

function buildSkippedReport(params: {
  summary: TokenEfficiencySuiteSummary;
  generatedAt: string;
  thresholdPercent: number;
  skipReason: string;
}): TokenEfficiencyReport {
  return {
    status: "skipped",
    runtimePair: normalizeRuntimePair(params.summary.run?.runtimePair),
    generatedAt: params.generatedAt,
    ...(params.summary.run?.providerMode ? { providerMode: params.summary.run.providerMode } : {}),
    thresholdPercent: params.thresholdPercent,
    rows: [],
    aggregate: ZERO_AGGREGATE,
    pass: true,
    failures: [],
    skipReason: params.skipReason,
    notes: [
      "Token efficiency is evaluated only for live-frontier runtime summaries.",
      "Mock provider usage totals are estimated only when providerMode includes mock.",
    ],
  };
}

export function buildTokenEfficiencyReport(
  params: BuildTokenEfficiencyReportParams,
): TokenEfficiencyReport {
  const generatedAt = params.generatedAt ?? new Date().toISOString();
  const thresholdPercent = params.thresholdPercent ?? DEFAULT_THRESHOLD_PERCENT;
  const providerMode = params.summary.run?.providerMode;

  const isLiveUsage = providerMode === LIVE_PROVIDER_MODE;
  const isMockEstimate = providerMode ? MOCK_ESTIMATE_PROVIDER_RE.test(providerMode) : false;
  if (!isLiveUsage && !isMockEstimate) {
    return buildSkippedReport({
      summary: params.summary,
      generatedAt,
      thresholdPercent,
      skipReason: skipReasonForProviderMode(providerMode),
    });
  }

  const rows = params.summary.scenarios
    .map((scenario) => scenario.runtimeParity)
    .filter((result): result is RuntimeParityResult => Boolean(result))
    .map((result) =>
      buildRow(result, thresholdPercent, isLiveUsage ? "live-usage" : "mock-estimate"),
    );

  const liveEvidenceFailureEntries = isLiveUsage ? liveEvidenceFailures(params.summary) : [];
  if (rows.length === 0 && liveEvidenceFailureEntries.length === 0) {
    return buildSkippedReport({
      summary: params.summary,
      generatedAt,
      thresholdPercent,
      skipReason: "skipped - no runtime parity cells were present in the summary",
    });
  }

  const aggregate = buildAggregate(rows);
  const liveEvidenceFailureScenarioIds = new Set(
    liveEvidenceFailureEntries.map((failure) => failure.scenarioId),
  );
  const liveFailures = [
    ...liveEvidenceFailureEntries.map((failure) => failure.message),
    ...aggregate.flaggedScenarios
      .filter((scenarioId) => !liveEvidenceFailureScenarioIds.has(scenarioId))
      .map((scenarioId) => {
        const row = rows.find((entry) => entry.scenarioId === scenarioId);
        const reasons = [
          row?.flagged === true ? `token delta=${formatPercent(row.deltaPercent)}` : undefined,
          row?.costFlagged === true
            ? `cost delta=${formatPercent(row.costDeltaPercent ?? 0)}`
            : undefined,
        ].filter((reason): reason is string => Boolean(reason));
        return `${scenarioId} ${reasons.join(", ")} exceeds ${thresholdPercent.toFixed(
          1,
        )}% Codex increase threshold`;
      }),
  ];
  const failures = isLiveUsage ? liveFailures : [];

  return {
    status: isLiveUsage ? "evaluated" : "estimated",
    runtimePair: normalizeRuntimePair(params.summary.run?.runtimePair),
    generatedAt,
    providerMode,
    thresholdPercent,
    rows,
    aggregate,
    pass: failures.length === 0,
    failures,
    notes: [
      isLiveUsage
        ? "Token totals are read from RuntimeParityCell.usage, which is captured from normalized AssistantMessage.usage."
        : "Mock token totals are algorithmic estimates from prompt/tool/schema/transcript byte counts, not live provider usage.",
      isLiveUsage
        ? "Cost totals are read from AssistantMessage.usage.cost when present; rows without provider cost remain token-only."
        : "Mock estimates do not invent dollar cost; cost fields stay unavailable outside live usage.",
      ...(isLiveUsage ? [] : ["Mock estimate deltas are informational and do not fail the gate."]),
      "The report does not inspect provider transport payload token counters.",
    ],
  };
}

function formatPercent(value: number): string {
  const normalized = Math.abs(value) < 0.05 ? 0 : value;
  const prefix = normalized > 0 ? "+" : "";
  return `${prefix}${normalized.toFixed(1)}%`;
}

function formatOptionalPercent(value: number | undefined): string {
  return value === undefined ? "n/a" : formatPercent(value);
}

function formatUsd(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) {
    return "n/a";
  }
  if (value >= 1) {
    return `$${value.toFixed(2)}`;
  }
  if (value >= 0.01) {
    return `$${value.toFixed(2)}`;
  }
  return `$${value.toFixed(4)}`;
}

function formatRuntimeUsage(usage: TokenEfficiencyRuntimeUsage): string {
  return `${usage.inputTokens}/${usage.outputTokens}/${usage.totalTokens}/${usage.toolCallCount}`;
}

function formatCharStats(usage: TokenEfficiencyRuntimeUsage): string {
  return `${usage.promptChars}/${usage.projectContextChars}/${usage.skillPromptChars}/${usage.toolSummaryChars}/${usage.toolSchemaChars}/${usage.transcriptChars}`;
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/gu, "\\|").replace(/\s+/gu, " ").trim();
}

export function renderTokenEfficiencyMarkdownReport(report: TokenEfficiencyReport): string {
  const lines = [
    `# OpenClaw Runtime Token Efficiency - ${report.runtimePair[0]} vs ${report.runtimePair[1]}`,
    "",
    `- Generated at: ${report.generatedAt}`,
    `- Provider mode: ${report.providerMode ?? "unknown"}`,
    `- Verdict: ${report.status === "skipped" ? "skipped" : report.pass ? "pass" : "fail"}`,
    `- Usage source: ${
      report.status === "estimated"
        ? "mock-estimate"
        : report.status === "evaluated"
          ? "live-usage"
          : "not-applicable"
    }`,
  ];

  if (report.status === "skipped") {
    lines.push("", "## Not Applicable", "", report.skipReason ?? "skipped");
    return `${lines.join("\n").trimEnd()}\n`;
  }

  lines.push(
    `- Threshold: Codex token/cost increase > ${report.thresholdPercent.toFixed(1)}%`,
    "",
    "## Aggregate Metrics",
    "",
    "| Runtime | Total tokens | p50 per turn | p90 per turn | Cost |",
    "| --- | ---: | ---: | ---: | ---: |",
    `| pi | ${report.aggregate.pi.totalTokens} | ${report.aggregate.pi.p50PerTurn} | ${report.aggregate.pi.p90PerTurn} | ${formatUsd(report.aggregate.pi.costUsd)} |`,
    `| codex | ${report.aggregate.codex.totalTokens} | ${report.aggregate.codex.p50PerTurn} | ${report.aggregate.codex.p90PerTurn} | ${formatUsd(report.aggregate.codex.costUsd)} |`,
    `| delta | ${formatPercent(report.aggregate.deltaPercent)} |  |  | ${formatOptionalPercent(report.aggregate.costDeltaPercent)} |`,
    "",
    "## Scenario Efficiency",
    "",
    "| Scenario | Source | Pi in/out/total/tools | Codex in/out/total/tools | Pi cost | Codex cost | Pi prompt/project/skills/tool-summary/tool-schema/transcript chars | Codex prompt/project/skills/tool-summary/tool-schema/transcript chars | Token delta | Cost delta | Flagged | Tools used |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |",
  );

  for (const row of report.rows) {
    lines.push(
      `| ${escapeTableCell(row.scenarioId)} | ${escapeTableCell(row.usageSource)} | ${formatRuntimeUsage(row.pi)} | ${formatRuntimeUsage(
        row.codex,
      )} | ${formatUsd(row.pi.costUsd)} | ${formatUsd(row.codex.costUsd)} | ${formatCharStats(row.pi)} | ${formatCharStats(
        row.codex,
      )} | ${formatPercent(row.deltaPercent)} | ${formatOptionalPercent(row.costDeltaPercent)} | ${
        row.flagged || row.costFlagged ? "yes" : "no"
      } | ${escapeTableCell(row.toolsUsed.join(", "))} |`,
    );
  }

  if (report.failures.length > 0) {
    lines.push("", "## Gate Failures", "");
    for (const failure of report.failures) {
      lines.push(`- ${failure}`);
    }
  }

  if (report.notes.length > 0) {
    lines.push("", "## Notes", "");
    for (const note of report.notes) {
      lines.push(`- ${note}`);
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}
