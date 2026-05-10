import type { RuntimeId, RuntimeParityCell, RuntimeParityResult } from "./runtime-parity.js";

export type TokenEfficiencyRuntimeUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  toolCallCount: number;
};

export type TokenEfficiencyRow = {
  scenarioId: string;
  pi: TokenEfficiencyRuntimeUsage;
  codex: TokenEfficiencyRuntimeUsage;
  deltaPercent: number;
  flagged: boolean;
  toolsUsed: string[];
};

export type TokenEfficiencyReport = {
  status: "evaluated" | "skipped";
  runtimePair: [RuntimeId, RuntimeId];
  generatedAt: string;
  providerMode?: string;
  thresholdPercent: number;
  rows: TokenEfficiencyRow[];
  aggregate: {
    pi: { totalTokens: number; p50PerTurn: number; p90PerTurn: number };
    codex: { totalTokens: number; p50PerTurn: number; p90PerTurn: number };
    deltaPercent: number;
    flaggedScenarios: string[];
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

const LIVE_PROVIDER_MODE = "live-frontier";
const DEFAULT_THRESHOLD_PERCENT = 15;
const ZERO_AGGREGATE: TokenEfficiencyReport["aggregate"] = {
  pi: { totalTokens: 0, p50PerTurn: 0, p90PerTurn: 0 },
  codex: { totalTokens: 0, p50PerTurn: 0, p90PerTurn: 0 },
  deltaPercent: 0,
  flaggedScenarios: [],
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

function cellUsage(cell: RuntimeParityCell): TokenEfficiencyRuntimeUsage {
  return {
    inputTokens: normalizeTokenCount(cell.usage.inputTokens),
    outputTokens: normalizeTokenCount(cell.usage.outputTokens),
    totalTokens: normalizeTokenCount(cell.usage.totalTokens),
    toolCallCount: cell.toolCalls.length,
  };
}

function deltaPercent(piTotalTokens: number, codexTotalTokens: number): number {
  if (piTotalTokens === 0) {
    return codexTotalTokens === 0 ? 0 : 100;
  }
  return ((codexTotalTokens - piTotalTokens) / piTotalTokens) * 100;
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

function buildRow(result: RuntimeParityResult, thresholdPercent: number): TokenEfficiencyRow {
  const pi = cellUsage(result.cells.pi);
  const codex = cellUsage(result.cells.codex);
  const delta = deltaPercent(pi.totalTokens, codex.totalTokens);
  return {
    scenarioId: result.scenarioId,
    pi,
    codex,
    deltaPercent: delta,
    flagged: Math.abs(delta) > thresholdPercent,
    toolsUsed: toolNamesForCells(result.cells.pi, result.cells.codex),
  };
}

function buildAggregate(rows: readonly TokenEfficiencyRow[]): TokenEfficiencyReport["aggregate"] {
  const piTotals = rows.map((row) => row.pi.totalTokens);
  const codexTotals = rows.map((row) => row.codex.totalTokens);
  const piTotalTokens = piTotals.reduce((sum, value) => sum + value, 0);
  const codexTotalTokens = codexTotals.reduce((sum, value) => sum + value, 0);
  return {
    pi: {
      totalTokens: piTotalTokens,
      p50PerTurn: percentile(piTotals, 50),
      p90PerTurn: percentile(piTotals, 90),
    },
    codex: {
      totalTokens: codexTotalTokens,
      p50PerTurn: percentile(codexTotals, 50),
      p90PerTurn: percentile(codexTotals, 90),
    },
    deltaPercent: deltaPercent(piTotalTokens, codexTotalTokens),
    flaggedScenarios: rows.filter((row) => row.flagged).map((row) => row.scenarioId),
  };
}

function skipReasonForProviderMode(providerMode: string | undefined): string {
  if (providerMode?.toLowerCase().includes("mock")) {
    return "skipped - mock provider returns fixed counts; token efficiency is only evaluated for live-frontier summaries";
  }
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
      "Mock provider usage totals are fixed and must not be used for efficiency verdicts.",
    ],
  };
}

export function buildTokenEfficiencyReport(
  params: BuildTokenEfficiencyReportParams,
): TokenEfficiencyReport {
  const generatedAt = params.generatedAt ?? new Date().toISOString();
  const thresholdPercent = params.thresholdPercent ?? DEFAULT_THRESHOLD_PERCENT;
  const providerMode = params.summary.run?.providerMode;

  if (providerMode !== LIVE_PROVIDER_MODE) {
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
    .map((result) => buildRow(result, thresholdPercent));

  if (rows.length === 0) {
    return buildSkippedReport({
      summary: params.summary,
      generatedAt,
      thresholdPercent,
      skipReason: "skipped - no runtime parity cells were present in the live summary",
    });
  }

  const aggregate = buildAggregate(rows);
  const failures = aggregate.flaggedScenarios.map((scenarioId) => {
    const row = rows.find((entry) => entry.scenarioId === scenarioId);
    return `${scenarioId} delta=${formatPercent(row?.deltaPercent ?? 0)} exceeds ${thresholdPercent.toFixed(
      1,
    )}% threshold`;
  });

  return {
    status: "evaluated",
    runtimePair: normalizeRuntimePair(params.summary.run?.runtimePair),
    generatedAt,
    providerMode,
    thresholdPercent,
    rows,
    aggregate,
    pass: failures.length === 0,
    failures,
    notes: [
      "Token totals are read from RuntimeParityCell.usage, which is captured from normalized AssistantMessage.usage.",
      "The report does not inspect provider transport payloads or raw transcripts.",
    ],
  };
}

function formatPercent(value: number): string {
  const normalized = Math.abs(value) < 0.05 ? 0 : value;
  const prefix = normalized > 0 ? "+" : "";
  return `${prefix}${normalized.toFixed(1)}%`;
}

function formatRuntimeUsage(usage: TokenEfficiencyRuntimeUsage): string {
  return `${usage.inputTokens}/${usage.outputTokens}/${usage.totalTokens}/${usage.toolCallCount}`;
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
  ];

  if (report.status === "skipped") {
    lines.push("", "## Not Applicable", "", report.skipReason ?? "skipped");
    return `${lines.join("\n").trimEnd()}\n`;
  }

  lines.push(
    `- Threshold: absolute delta > ${report.thresholdPercent.toFixed(1)}%`,
    "",
    "## Aggregate Metrics",
    "",
    "| Runtime | Total tokens | p50 per turn | p90 per turn |",
    "| --- | ---: | ---: | ---: |",
    `| pi | ${report.aggregate.pi.totalTokens} | ${report.aggregate.pi.p50PerTurn} | ${report.aggregate.pi.p90PerTurn} |`,
    `| codex | ${report.aggregate.codex.totalTokens} | ${report.aggregate.codex.p50PerTurn} | ${report.aggregate.codex.p90PerTurn} |`,
    `| delta | ${formatPercent(report.aggregate.deltaPercent)} |  |  |`,
    "",
    "## Scenario Efficiency",
    "",
    "| Scenario | Pi in/out/total/tools | Codex in/out/total/tools | Delta | Flagged | Tools used |",
    "| --- | ---: | ---: | ---: | --- | --- |",
  );

  for (const row of report.rows) {
    lines.push(
      `| ${escapeTableCell(row.scenarioId)} | ${formatRuntimeUsage(row.pi)} | ${formatRuntimeUsage(
        row.codex,
      )} | ${formatPercent(row.deltaPercent)} | ${row.flagged ? "yes" : "no"} | ${escapeTableCell(
        row.toolsUsed.join(", "),
      )} |`,
    );
  }

  if (report.failures.length > 0) {
    lines.push("", "## Gate Failures", "");
    for (const failure of report.failures) {
      lines.push(`- ${failure}`);
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}
