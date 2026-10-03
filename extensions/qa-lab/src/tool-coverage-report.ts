import {
  isRecord,
  normalizeOptionalString as readString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import type { QaParitySuiteSummary } from "./agentic-parity-report.js";
import { escapeTableCell } from "./report.js";
import type { RuntimeId } from "./runtime-id.js";
import {
  runtimeParityCellStatus,
  normalizeRuntimePair,
  type RuntimeParityDrift,
  type RuntimeParityResult,
} from "./runtime-parity.js";
import {
  readRuntimeToolCoverageConfig,
  readScenarioRuntimeToolCoverageMetadata,
  type QaRuntimeCapabilityLayer,
  type QaRuntimeToolBucket,
  type QaRuntimeToolExpectedLayer,
} from "./runtime-tool-metadata.js";
import type { QaSeedScenarioWithSource } from "./scenario-catalog.js";

type QaToolCoverageStatus = "pass" | "fail" | "skip" | "missing" | "not-run";
type QaToolCoverageDrift = RuntimeParityDrift | "not-run";

type QaToolCoverageRow = {
  tool: string;
  runtimeToolName?: string;
  bucket: QaRuntimeToolBucket;
  expectedLayer: QaRuntimeToolExpectedLayer;
  capabilityLayer: QaRuntimeCapabilityLayer;
  required: boolean;
  fixtureCount: number;
  scenarios: string[];
  sourcePaths: string[];
  openclaw: QaToolCoverageStatus;
  codex: QaToolCoverageStatus;
  drift: QaToolCoverageDrift;
  openclawToolCalls: number;
  codexToolCalls: number;
  openclawSuccessfulToolCalls: number;
  codexSuccessfulToolCalls: number;
  tracking?: string;
  codexDefaultImpact?: string;
  qaImpact?: string;
  action?: string;
  details?: string;
};

type QaToolCoverageReport = {
  runtimePair: [RuntimeId, RuntimeId];
  generatedAt: string;
  evaluated: boolean;
  totalTools: number;
  requiredTools: number;
  reportOnlyTools: number;
  trackedTools: number;
  nativeWorkspaceTools: number;
  dynamicIntegrationTools: number;
  searchableDynamicTools: number;
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

const PASSING_DRIFTS: ReadonlySet<QaToolCoverageDrift> = new Set(["none", "text-only"]);

function cellStatus(
  cell: RuntimeParityResult["cells"][RuntimeId] | undefined,
): QaToolCoverageStatus {
  if (!cell) {
    return "missing";
  }
  const status = runtimeParityCellStatus(cell);
  return status === "pass" || status === "skip" ? status : "fail";
}

function toolIdForScenario(scenario: QaSeedScenarioWithSource): string | undefined {
  const toolCoverage = readRuntimeToolCoverageConfig(scenario.execution.config);
  return (
    readString(toolCoverage?.family) ??
    readString(toolCoverage?.tool) ??
    readString(toolCoverage?.actualTool) ??
    readString(scenario.execution.config?.toolName)
  );
}

function groupToolFixtures(scenarios: readonly QaSeedScenarioWithSource[]): ToolFixtureGroup[] {
  const byTool = new Map<string, QaSeedScenarioWithSource[]>();
  for (const scenario of scenarios) {
    if (!scenario.sourcePath.startsWith("qa/scenarios/runtime/tools/")) {
      continue;
    }
    const tool = toolIdForScenario(scenario);
    if (tool) {
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
  const metadata = readScenarioRuntimeToolCoverageMetadata(scenario);
  const config = scenario.execution.config;
  const knownBroken = isRecord(config?.knownBroken) ? config.knownBroken : undefined;
  const knownHarnessGap = isRecord(config?.knownHarnessGap) ? config.knownHarnessGap : undefined;
  const issue =
    metadata.tracking ?? readString(knownHarnessGap?.issue) ?? readString(knownBroken?.issue);
  const reason =
    metadata.reason ?? readString(knownHarnessGap?.reason) ?? readString(knownBroken?.reason);
  if (issue && reason) {
    return `${issue} ${reason}`;
  }
  return issue;
}

function readScenarioRuntimeToolName(scenario: QaSeedScenarioWithSource): string | undefined {
  const config = scenario.execution.config;
  const toolCoverage = readRuntimeToolCoverageConfig(config);
  return readString(toolCoverage?.actualTool) ?? readString(config?.toolName);
}

function mergeScenarioResults(
  scenarios: readonly QaSeedScenarioWithSource[],
  results: ReadonlyMap<string, RuntimeParityResult>,
) {
  const scenarioResults = scenarios
    .map((scenario) => results.get(scenario.id))
    .filter((result): result is RuntimeParityResult => Boolean(result));
  return scenarioResults.find((result) => !PASSING_DRIFTS.has(result.drift)) ?? scenarioResults[0];
}

function summarizeRuntimeToolCalls(
  result: RuntimeParityResult | undefined,
  runtime: RuntimeId,
  toolName: string | undefined,
) {
  const calls = toolName
    ? (result?.cells[runtime].toolCalls.filter((call) => call.tool === toolName) ?? [])
    : [];
  return {
    total: calls.length,
    successful: calls.filter((call) => !call.errorClass && call.resultHash.trim().length > 0)
      .length,
  };
}

function buildRow(params: {
  group: ToolFixtureGroup;
  results: ReadonlyMap<string, RuntimeParityResult>;
}): QaToolCoverageRow {
  const result = mergeScenarioResults(params.group.scenarios, params.results);
  const tracking = params.group.scenarios.map(readScenarioTracking).find(Boolean);
  const metadata = params.group.scenarios.map(readScenarioRuntimeToolCoverageMetadata);
  const rowMetadata = metadata.find((entry) => entry.required) ?? metadata[0]!;
  const runtimeToolName = params.group.scenarios.map(readScenarioRuntimeToolName).find(Boolean);
  const openclawCalls = summarizeRuntimeToolCalls(result, "openclaw", runtimeToolName);
  const codexCalls = summarizeRuntimeToolCalls(result, "codex", runtimeToolName);
  return {
    tool: params.group.tool,
    ...(runtimeToolName ? { runtimeToolName } : {}),
    bucket: rowMetadata.bucket,
    expectedLayer: rowMetadata.expectedLayer,
    capabilityLayer: rowMetadata.capabilityLayer,
    required: rowMetadata.required,
    fixtureCount: params.group.scenarios.length,
    scenarios: params.group.scenarios.map((scenario) => scenario.id),
    sourcePaths: params.group.scenarios.map((scenario) => scenario.sourcePath),
    openclaw: result ? cellStatus(result.cells.openclaw) : "not-run",
    codex: result ? cellStatus(result.cells.codex) : "not-run",
    drift: result?.drift ?? "not-run",
    openclawToolCalls: openclawCalls.total,
    codexToolCalls: codexCalls.total,
    openclawSuccessfulToolCalls: openclawCalls.successful,
    codexSuccessfulToolCalls: codexCalls.successful,
    ...(tracking ? { tracking } : {}),
    ...(rowMetadata.codexDefaultImpact
      ? { codexDefaultImpact: rowMetadata.codexDefaultImpact }
      : {}),
    ...(rowMetadata.qaImpact ? { qaImpact: rowMetadata.qaImpact } : {}),
    ...(rowMetadata.action ? { action: rowMetadata.action } : {}),
    ...(result?.driftDetails ? { details: result.driftDetails } : {}),
  };
}

function coverageFailureForRow(row: QaToolCoverageRow): string | undefined {
  if (!row.required) {
    return undefined;
  }
  if (row.drift === "not-run") {
    return `${row.tool} drift=not-run`;
  }
  if (row.openclaw !== "pass" || row.codex !== "pass") {
    return `${row.tool} status openclaw=${row.openclaw} codex=${row.codex}`;
  }
  if (row.drift === "failure-mode") {
    return `${row.tool} drift=failure-mode${row.details ? ` (${row.details})` : ""}`;
  }
  if (row.runtimeToolName && row.openclawSuccessfulToolCalls === 0) {
    return `${row.tool} missing successful openclaw tool call/result ${row.runtimeToolName}`;
  }
  if (row.runtimeToolName && row.codexSuccessfulToolCalls === 0) {
    return `${row.tool} missing successful codex tool call/result ${row.runtimeToolName}`;
  }
  return undefined;
}

export function buildQaToolCoverageReport(params: {
  scenarios: readonly QaSeedScenarioWithSource[];
  summary?: QaParitySuiteSummary;
  runtimePair?: [RuntimeId, RuntimeId];
  generatedAt?: string;
}): QaToolCoverageReport {
  const results = new Map(
    (params.summary?.scenarios ?? []).flatMap(({ runtimeParity }) =>
      runtimeParity ? [[runtimeParity.scenarioId, runtimeParity] as const] : [],
    ),
  );
  const rows = groupToolFixtures(params.scenarios).map((group) =>
    buildRow({
      group,
      results,
    }),
  );
  const evaluated = Boolean(params.summary);
  const failures = evaluated
    ? rows.map(coverageFailureForRow).filter((failure): failure is string => Boolean(failure))
    : [];
  const requiredTools = rows.filter((row) => row.required).length;
  return {
    runtimePair: normalizeRuntimePair(params.runtimePair ?? params.summary?.run?.runtimePair),
    generatedAt: params.generatedAt ?? new Date().toISOString(),
    evaluated,
    totalTools: rows.length,
    requiredTools,
    reportOnlyTools: rows.length - requiredTools,
    trackedTools: rows.filter((row) => Boolean(row.tracking)).length,
    nativeWorkspaceTools: rows.filter((row) => row.bucket === "codex-native-workspace").length,
    dynamicIntegrationTools: rows.filter((row) => row.bucket === "openclaw-dynamic-integration")
      .length,
    searchableDynamicTools: rows.filter(
      (row) => row.capabilityLayer === "openclaw-dynamic-searchable",
    ).length,
    optionalTools: rows.filter((row) => row.bucket === "optional-profile-or-plugin").length,
    passingTools: evaluated ? requiredTools - failures.length : 0,
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
    `- Required tools: ${report.requiredTools}`,
    `- Report-only tools: ${report.reportOnlyTools}`,
    `- Tracked issue rows: ${report.trackedTools}`,
    `- Codex-native workspace tools: ${report.nativeWorkspaceTools}`,
    `- OpenClaw dynamic integration tools: ${report.dynamicIntegrationTools}`,
    `- Searchable/deferred dynamic tools: ${report.searchableDynamicTools}`,
    `- Optional/profile/plugin-dependent tools: ${report.optionalTools}`,
    `- Passing tools: ${report.passingTools}`,
    `- Failing tools: ${report.failingTools}`,
    `- Verdict: ${report.pass ? "pass" : "fail"}`,
    "",
    "| Tool | Bucket | Expected layer | Capability layer | Required | Fixtures | OpenClaw | Codex | Drift | Codex default impact | QA impact | Action | Tracking |",
    "| --- | --- | --- | --- | --- | ---: | --- | --- | --- | --- | --- | --- | --- |",
  ];

  for (const row of report.rows) {
    const cells = [
      row.tool,
      row.bucket,
      row.expectedLayer,
      row.capabilityLayer,
      row.required ? "yes" : "no",
      row.fixtureCount.toString(),
      row.openclaw,
      row.codex,
      row.drift,
      row.codexDefaultImpact ?? "",
      row.qaImpact ?? "",
      row.action ?? "",
      row.tracking ?? "",
    ].map(escapeTableCell);
    lines.push(`| ${cells.join(" | ")} |`);
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
