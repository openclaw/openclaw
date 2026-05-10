import type {
  RuntimeId,
  RuntimeParityCell,
  RuntimeParityDrift,
  RuntimeParityResult,
} from "./runtime-parity.js";
import type { QaSeedScenarioWithSource } from "./scenario-catalog.js";

type QaToolCoverageSuiteScenario = {
  name: string;
  status: "pass" | "fail";
  runtimeParity?: RuntimeParityResult;
};

export type QaToolCoverageSuiteSummary = {
  scenarios: QaToolCoverageSuiteScenario[];
  run?: {
    runtimePair?: [RuntimeId, RuntimeId] | null;
  };
};

export type QaToolCoverageStatus = "pass" | "fail" | "missing" | "not-run";
export type QaToolCoverageDrift = RuntimeParityDrift | "not-run";
export type QaToolCoverageBucket = "required-default" | "optional-plugin";

export type QaToolCoverageRow = {
  tool: string;
  bucket: QaToolCoverageBucket;
  fixtureCount: number;
  scenarios: string[];
  sourcePaths: string[];
  pi: QaToolCoverageStatus;
  codex: QaToolCoverageStatus;
  drift: QaToolCoverageDrift;
  tracking?: string;
  details?: string;
};

export type QaToolCoverageReport = {
  runtimePair: [RuntimeId, RuntimeId];
  generatedAt: string;
  evaluated: boolean;
  totalTools: number;
  requiredTools: number;
  optionalTools: number;
  passingTools: number;
  failingTools: number;
  rows: QaToolCoverageRow[];
  pass: boolean;
  failures: string[];
};

type ToolFixtureGroup = {
  tool: string;
  scenarios: QaSeedScenarioWithSource[];
};

const PASSING_DRIFTS: ReadonlySet<QaToolCoverageDrift> = new Set(["none", "text-only", "not-run"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeRuntimePair(
  pair: [RuntimeId, RuntimeId] | null | undefined,
): [RuntimeId, RuntimeId] {
  if (pair?.[0] && pair?.[1]) {
    return pair;
  }
  return ["pi", "codex"];
}

function cellStatus(cell: RuntimeParityCell | undefined): QaToolCoverageStatus {
  if (!cell) {
    return "missing";
  }
  return cell.runtimeErrorClass || cell.transportErrorClass ? "fail" : "pass";
}

function toolIdsForScenario(scenario: QaSeedScenarioWithSource): string[] {
  const coverageIds = [
    ...(scenario.coverage?.primary ?? []),
    ...(scenario.coverage?.secondary ?? []),
  ];
  return [
    ...new Set(
      coverageIds
        .filter((coverageId) => coverageId.startsWith("tools."))
        .map((coverageId) => coverageId.slice("tools.".length)),
    ),
  ].toSorted((left, right) => left.localeCompare(right));
}

function groupToolFixtures(scenarios: readonly QaSeedScenarioWithSource[]): ToolFixtureGroup[] {
  const byTool = new Map<string, QaSeedScenarioWithSource[]>();
  for (const scenario of scenarios) {
    if (!scenario.sourcePath.startsWith("qa/scenarios/runtime/tools/")) {
      continue;
    }
    for (const tool of toolIdsForScenario(scenario)) {
      const entries = byTool.get(tool) ?? [];
      entries.push(scenario);
      byTool.set(tool, entries);
    }
  }
  return [...byTool.entries()]
    .map(([tool, groupedScenarios]) => ({
      tool,
      scenarios: groupedScenarios.toSorted((left, right) => left.id.localeCompare(right.id)),
    }))
    .toSorted((left, right) => left.tool.localeCompare(right.tool));
}

function readScenarioTracking(scenario: QaSeedScenarioWithSource): string | undefined {
  const config = scenario.execution.config;
  const toolCoverage = isRecord(config?.toolCoverage) ? config.toolCoverage : undefined;
  const knownBroken = isRecord(config?.knownBroken) ? config.knownBroken : undefined;
  const knownHarnessGap = isRecord(config?.knownHarnessGap) ? config.knownHarnessGap : undefined;
  const issue =
    readString(toolCoverage?.tracking) ??
    readString(toolCoverage?.issue) ??
    readString(knownHarnessGap?.issue) ??
    readString(knownBroken?.issue);
  const reason =
    readString(toolCoverage?.reason) ??
    readString(knownHarnessGap?.reason) ??
    readString(knownBroken?.reason);
  if (issue && reason) {
    return `${issue} ${reason}`;
  }
  return issue ?? reason;
}

function readScenarioToolBucket(scenario: QaSeedScenarioWithSource): QaToolCoverageBucket {
  const config = scenario.execution.config;
  const toolCoverage = isRecord(config?.toolCoverage) ? config.toolCoverage : undefined;
  const explicit = readString(toolCoverage?.bucket);
  if (explicit === "required-default" || explicit === "optional-plugin") {
    return explicit;
  }
  if (scenario.runtimeParityTier === "optional" || config?.expectedAvailable === false) {
    return "optional-plugin";
  }
  return "required-default";
}

function summaryByScenarioId(
  summary: QaToolCoverageSuiteSummary | undefined,
): Map<string, RuntimeParityResult> {
  const byScenarioId = new Map<string, RuntimeParityResult>();
  for (const scenario of summary?.scenarios ?? []) {
    if (scenario.runtimeParity) {
      byScenarioId.set(scenario.runtimeParity.scenarioId, scenario.runtimeParity);
    }
  }
  return byScenarioId;
}

function mergeScenarioResults(
  scenarios: readonly QaSeedScenarioWithSource[],
  results: ReadonlyMap<string, RuntimeParityResult>,
) {
  const scenarioResults = scenarios
    .map((scenario) => results.get(scenario.id))
    .filter((result): result is RuntimeParityResult => Boolean(result));
  if (scenarioResults.length === 0) {
    return undefined;
  }
  const failingResult =
    scenarioResults.find((result) => !PASSING_DRIFTS.has(result.drift)) ?? scenarioResults[0];
  return failingResult;
}

function buildRow(params: {
  group: ToolFixtureGroup;
  results: ReadonlyMap<string, RuntimeParityResult>;
}): QaToolCoverageRow {
  const result = mergeScenarioResults(params.group.scenarios, params.results);
  const tracking = params.group.scenarios.map(readScenarioTracking).find(Boolean);
  const bucket = params.group.scenarios.some(
    (scenario) => readScenarioToolBucket(scenario) === "required-default",
  )
    ? "required-default"
    : "optional-plugin";
  return {
    tool: params.group.tool,
    bucket,
    fixtureCount: params.group.scenarios.length,
    scenarios: params.group.scenarios.map((scenario) => scenario.id),
    sourcePaths: params.group.scenarios.map((scenario) => scenario.sourcePath),
    pi: result ? cellStatus(result.cells.pi) : "not-run",
    codex: result ? cellStatus(result.cells.codex) : "not-run",
    drift: result?.drift ?? "not-run",
    ...(tracking ? { tracking } : {}),
    ...(result?.driftDetails ? { details: result.driftDetails } : {}),
  };
}

export function buildQaToolCoverageReport(params: {
  scenarios: readonly QaSeedScenarioWithSource[];
  summary?: QaToolCoverageSuiteSummary;
  runtimePair?: [RuntimeId, RuntimeId];
  generatedAt?: string;
}): QaToolCoverageReport {
  const results = summaryByScenarioId(params.summary);
  const rows = groupToolFixtures(params.scenarios).map((group) =>
    buildRow({
      group,
      results,
    }),
  );
  const evaluated = Boolean(params.summary);
  const failures = evaluated
    ? rows
        .filter(
          (row) =>
            row.bucket === "required-default" && !row.tracking && !PASSING_DRIFTS.has(row.drift),
        )
        .map((row) => `${row.tool} drift=${row.drift}${row.details ? ` (${row.details})` : ""}`)
    : [];
  return {
    runtimePair: normalizeRuntimePair(params.runtimePair ?? params.summary?.run?.runtimePair),
    generatedAt: params.generatedAt ?? new Date().toISOString(),
    evaluated,
    totalTools: rows.length,
    requiredTools: rows.filter((row) => row.bucket === "required-default").length,
    optionalTools: rows.filter((row) => row.bucket === "optional-plugin").length,
    passingTools: evaluated
      ? rows.filter(
          (row) =>
            row.bucket === "optional-plugin" ||
            PASSING_DRIFTS.has(row.drift) ||
            Boolean(row.tracking),
        ).length
      : 0,
    failingTools: failures.length,
    rows,
    pass: failures.length === 0,
    failures,
  };
}

export function renderQaToolCoverageMarkdownReport(report: QaToolCoverageReport): string {
  const lines = [
    `# OpenClaw Runtime Tool Coverage — ${report.runtimePair[0]} vs ${report.runtimePair[1]}`,
    "",
    `- Generated at: ${report.generatedAt}`,
    `- Mode: ${report.evaluated ? "runtime summary" : "catalog inventory"}`,
    `- Tools: ${report.totalTools}`,
    `- Required default tools: ${report.requiredTools}`,
    `- Optional/plugin-dependent tools: ${report.optionalTools}`,
    `- Passing tools: ${report.passingTools}`,
    `- Failing tools: ${report.failingTools}`,
    `- Verdict: ${report.pass ? "pass" : "fail"}`,
    "",
    "| Tool | Bucket | Fixtures | Pi | Codex | Drift | Tracking |",
    "| --- | --- | ---: | --- | --- | --- | --- |",
  ];

  for (const row of report.rows) {
    lines.push(
      `| ${row.tool} | ${row.bucket} | ${row.fixtureCount} | ${row.pi} | ${row.codex} | ${row.drift} | ${row.tracking ?? ""} |`,
    );
  }

  if (report.failures.length > 0) {
    lines.push("", "## Gate Failures", "");
    for (const failure of report.failures) {
      lines.push(`- ${failure}`);
    }
  }

  lines.push("", "## Fixture Sources", "");
  for (const row of report.rows) {
    lines.push(`- ${row.tool}: ${row.scenarios.join(", ")}`);
  }

  return `${lines.join("\n").trimEnd()}\n`;
}
