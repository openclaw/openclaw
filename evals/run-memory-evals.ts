import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withRunContext } from "../src/infra/run-context.ts";
import { createRunContextLogger } from "../src/logging/run-context-logger.ts";
import {
  buildRunContext,
  createRunId,
  resolveEvalRevisions,
  sanitizeRunIdForFileName,
  type RevisionInfo,
  type RunContext,
} from "./memory-run-context.ts";

const runLogger = createRunContextLogger();

export type ScenarioSkill =
  | "memory-intake"
  | "memory-recap"
  | "memory-audit"
  | "memory-evolution";
export type ScenarioAction = "save" | "skip" | "recap" | "audit" | "propose";
export type ScenarioKpi =
  | "intake_precision"
  | "skip_precision"
  | "recap_hit_rate"
  | "conflict_precision"
  | "false_apply_zero";
export type EvalErrorType =
  | "routing"
  | "dispatch_contract"
  | "tool_selection"
  | "tool_output_mapping"
  | "schema_contract"
  | "reasoning"
  | "guardrail"
  | "missing_context_propagation"
  | "policy_guardrail";

export type Scenario = {
  id: string;
  category: "intake" | "recap" | "audit" | "evolution";
  transcript: Array<{ role: "user" | "assistant"; content: string }>;
  expected: {
    skill: ScenarioSkill;
    action: ScenarioAction;
    classifications: string[];
    conflictFlag: boolean;
    memoryCreates: number;
    memoryIdsRequired: boolean;
    recapMustInclude: string[];
    evolutionMode: "none" | "propose-only";
  };
  kpis: ScenarioKpi[];
};

export type ActualSnapshot = {
  action?: ScenarioAction | "apply";
  classifications?: string[];
  conflict_flags?: string[];
  conflictFlag?: boolean;
  memory_ids?: string[];
  memoryIds?: string[];
  recap_facts?: string[];
  recapFacts?: string[];
  evolution_mode?: "none" | "propose-only" | "apply";
  evolutionMode?: "none" | "propose-only" | "apply";
};

export type ActualResult = {
  id?: string;
  scenario_id?: string;
  run_id?: string;
  trace_id?: string;
  bucket?: ScenarioKpi;
  buckets?: ScenarioKpi[];
  skill?: ScenarioSkill;
  skill_actual?: ScenarioSkill;
  skill_expected?: ScenarioSkill;
  run_context?: RunContext;
  code_revision?: string;
  plugin_revision?: string;
  gold?: Scenario["expected"];
  actual?: ActualSnapshot;
  pass?: boolean | null;
  error_type?: EvalErrorType | null;
  notes?: string;
  action?: ScenarioAction | "apply";
  classifications?: string[];
  conflictFlag?: boolean;
  memoryIds?: string[];
  recapFacts?: string[];
  evolutionMode?: "none" | "propose-only" | "apply";
};

export type NormalizedActualResult = {
  scenarioId: string;
  runContext: RunContext;
  bucket: ScenarioKpi;
  buckets: ScenarioKpi[];
  skillExpected?: ScenarioSkill;
  skillActual?: ScenarioSkill;
  gold?: Scenario["expected"];
  actual: {
    action?: ScenarioAction | "apply";
    classifications: string[];
    conflictFlag: boolean;
    memoryIds: string[];
    recapFacts: string[];
    evolutionMode: "none" | "propose-only" | "apply";
  };
  pass?: boolean | null;
  errorType?: EvalErrorType | null;
  notes: string;
  hasProvidedTraceContext: boolean;
};

export type FailureEntry = {
  scenarioId: string;
  traceId: string;
  bucket: ScenarioKpi;
  errorType: EvalErrorType;
  notes: string;
};

export type ScoreReport = {
  runId: string;
  codeRevision: string;
  pluginRevision: string;
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  bucketScores: Array<{
    bucket: ScenarioKpi;
    label: string;
    passed: number;
    total: number;
  }>;
  errorTypeCounts: Partial<Record<EvalErrorType, number>>;
  failures: FailureEntry[];
  regressions: string[];
};

const KPI_LABELS: Record<ScenarioKpi, string> = {
  intake_precision: "Intake precision",
  skip_precision: "Skip precision",
  recap_hit_rate: "Recap usefulness/hit-rate",
  conflict_precision: "Conflict precision",
  false_apply_zero: "False apply zero",
};

const ERROR_TYPE_LABELS: Record<EvalErrorType, string> = {
  routing: "Routing",
  dispatch_contract: "Dispatch contract",
  tool_selection: "Tool selection",
  tool_output_mapping: "Tool output mapping",
  schema_contract: "Schema contract",
  reasoning: "Reasoning",
  guardrail: "Guardrail",
  missing_context_propagation: "Missing context propagation",
  policy_guardrail: "Guardrail",
};
const ERROR_TYPE_ORDER: EvalErrorType[] = [
  "routing",
  "dispatch_contract",
  "tool_selection",
  "tool_output_mapping",
  "schema_contract",
  "reasoning",
  "guardrail",
  "missing_context_propagation",
];

function primaryBucket(scenario: Scenario): ScenarioKpi {
  return scenario.kpis[0] ?? "intake_precision";
}

function normalizeArray(values: string[] | undefined): string[] {
  return Array.isArray(values) ? values : [];
}

function normalizeErrorType(value: EvalErrorType | null | undefined): EvalErrorType | null {
  if (!value) {
    return null;
  }
  return value === "policy_guardrail" ? "guardrail" : value;
}

export function parseArgs(argv: string[]) {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith("--") || !value) {
      continue;
    }
    args.set(key, value);
    i += 1;
  }
  const runId = args.get("--run-id") ?? createRunId();
  return {
    gold: args.get("--gold") ?? path.resolve(process.cwd(), "evals", "memory-scenarios.jsonl"),
    actual: args.get("--actual"),
    previous: args.get("--previous"),
    seedActual: args.get("--seed-actual"),
    summaryOut:
      args.get("--summary-out") ??
      path.resolve(process.cwd(), "evals", "runs", `${sanitizeRunIdForFileName(runId)}.summary.json`),
    runId,
  };
}

export function readJsonl<T>(filePath: string): T[] {
  const text = fs.readFileSync(filePath, "utf8");
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function writeJsonl<T>(filePath: string, rows: T[]): void {
  const text = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, "utf8");
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function validateScenario(scenario: Scenario): string[] {
  const issues: string[] = [];
  if (!scenario.id) issues.push("missing id");
  if (!Array.isArray(scenario.transcript) || scenario.transcript.length === 0) {
    issues.push("missing transcript");
  }
  if (!scenario.expected?.skill) issues.push("missing expected.skill");
  if (!scenario.expected?.action) issues.push("missing expected.action");
  if (!Array.isArray(scenario.expected?.classifications)) {
    issues.push("missing expected.classifications");
  }
  if (!Array.isArray(scenario.expected?.recapMustInclude)) {
    issues.push("missing expected.recapMustInclude");
  }
  if (!Array.isArray(scenario.kpis) || scenario.kpis.length === 0) {
    issues.push("missing kpis");
  }
  return issues;
}

function includesAll(haystack: string[], needles: string[]): boolean {
  const normalized = new Set(haystack.map((entry) => entry.toLowerCase()));
  return needles.every((entry) => normalized.has(entry.toLowerCase()));
}

function classificationMatch(actual: NormalizedActualResult, scenario: Scenario): boolean {
  if (scenario.expected.classifications.length === 0) {
    return actual.actual.classifications.length === 0;
  }
  return includesAll(actual.actual.classifications, scenario.expected.classifications);
}

function memoryIdMatch(actual: NormalizedActualResult, scenario: Scenario): boolean {
  if (!scenario.expected.memoryIdsRequired) {
    return true;
  }
  return actual.actual.memoryIds.length > 0;
}

function recapMatch(actual: NormalizedActualResult, scenario: Scenario): boolean {
  if (scenario.expected.recapMustInclude.length === 0) {
    return true;
  }
  return includesAll(actual.actual.recapFacts, scenario.expected.recapMustInclude);
}

function inferErrorType(actual: NormalizedActualResult, scenario: Scenario): EvalErrorType {
  if (!actual.hasProvidedTraceContext) {
    return "missing_context_propagation";
  }
  if (!actual.skillActual || !actual.actual.action) {
    return "dispatch_contract";
  }
  if (actual.skillActual !== scenario.expected.skill) {
    return "routing";
  }
  if (
    scenario.category === "evolution" &&
    (actual.actual.action === "apply" || actual.actual.evolutionMode === "apply")
  ) {
    return "guardrail";
  }
  if (!memoryIdMatch(actual, scenario)) {
    return "schema_contract";
  }
  if (!recapMatch(actual, scenario)) {
    return "tool_output_mapping";
  }
  return "reasoning";
}

export function createSeedActualEntries(
  gold: Scenario[],
  runId = createRunId(),
  revisions?: RevisionInfo,
): ActualResult[] {
  const resolvedRevisions = revisions ?? resolveEvalRevisions(process.cwd());
  return gold.map((scenario) => {
    const runContext = buildRunContext({
      runId,
      scenarioId: scenario.id,
      mode: "eval",
      skillName: scenario.expected.skill,
      dispatchKind: "skill",
      seed: scenario.id,
      revisions: resolvedRevisions,
    });
    return withRunContext(runContext, () => {
      runLogger.info("eval.actual_seeded", {
        summary: "seeded actual result template",
        meta: {
          scenarioId: scenario.id,
          bucket: primaryBucket(scenario),
        },
      });
      return {
        run_id: runId,
        scenario_id: scenario.id,
        trace_id: runContext.traceId,
        bucket: primaryBucket(scenario),
        buckets: scenario.kpis,
        skill_expected: scenario.expected.skill,
        skill_actual: undefined,
        run_context: runContext,
        code_revision: resolvedRevisions.codeRevision,
        plugin_revision: resolvedRevisions.pluginRevision,
        gold: scenario.expected,
        actual: {},
        pass: null,
        error_type: null,
        notes: "",
      };
    });
  });
}

export function normalizeActualResult(
  entry: ActualResult,
  scenario: Scenario,
  fallbackRunId: string,
  revisions?: RevisionInfo,
): NormalizedActualResult {
  const resolvedRevisions = revisions ?? resolveEvalRevisions(process.cwd());
  const actualSnapshot = entry.actual ?? {};
  const skillActual = entry.skill_actual ?? entry.skill;
  const skillExpected = entry.skill_expected ?? scenario.expected.skill;
  const runId = entry.run_id ?? entry.run_context?.runId ?? fallbackRunId;
  const fallbackRunContext = buildRunContext({
    runId,
    scenarioId: entry.scenario_id ?? entry.id ?? scenario.id,
    mode: "eval",
    skillName: skillExpected,
    dispatchKind: "skill",
    seed: scenario.id,
    revisions: {
      codeRevision: entry.code_revision ?? resolvedRevisions.codeRevision,
      pluginRevision: entry.plugin_revision ?? resolvedRevisions.pluginRevision,
    },
  });
  const runContext = entry.run_context
    ? {
        ...entry.run_context,
        traceId: entry.trace_id ?? entry.run_context.traceId,
        runId,
        scenarioId: entry.scenario_id ?? entry.run_context.scenarioId ?? scenario.id,
        codeRevision: entry.code_revision ?? entry.run_context.codeRevision,
        pluginRevision: entry.plugin_revision ?? entry.run_context.pluginRevision,
      }
    : {
        ...fallbackRunContext,
        traceId: entry.trace_id ?? fallbackRunContext.traceId,
      };
  const providedTraceId = entry.trace_id ?? entry.run_context?.traceId;
  const providedRunId = entry.run_id ?? entry.run_context?.runId;

  return {
    scenarioId: entry.scenario_id ?? entry.id ?? scenario.id,
    runContext,
    bucket: entry.bucket ?? primaryBucket(scenario),
    buckets: entry.buckets ?? scenario.kpis,
    skillExpected,
    skillActual,
    gold: entry.gold ?? scenario.expected,
    actual: {
      action: actualSnapshot.action ?? entry.action,
      classifications: normalizeArray(actualSnapshot.classifications ?? entry.classifications),
      conflictFlag:
        actualSnapshot.conflictFlag ??
        (Array.isArray(actualSnapshot.conflict_flags)
          ? actualSnapshot.conflict_flags.length > 0
          : entry.conflictFlag ?? false),
      memoryIds: normalizeArray(actualSnapshot.memoryIds ?? actualSnapshot.memory_ids ?? entry.memoryIds),
      recapFacts: normalizeArray(actualSnapshot.recapFacts ?? actualSnapshot.recap_facts ?? entry.recapFacts),
      evolutionMode:
        actualSnapshot.evolutionMode ??
        actualSnapshot.evolution_mode ??
        entry.evolutionMode ??
        "none",
    },
    pass: entry.pass,
    errorType: normalizeErrorType(entry.error_type),
    notes: entry.notes ?? "",
    hasProvidedTraceContext: Boolean(providedTraceId && providedRunId),
  };
}

export function scenarioPass(actual: NormalizedActualResult, scenario: Scenario): boolean {
  if (actual.skillActual !== scenario.expected.skill) {
    return false;
  }
  if (actual.actual.action !== scenario.expected.action) {
    return false;
  }
  if (actual.actual.conflictFlag !== scenario.expected.conflictFlag) {
    return false;
  }
  if (
    scenario.category === "evolution" &&
    (actual.actual.action === "apply" || actual.actual.evolutionMode === "apply")
  ) {
    return false;
  }
  if (
    scenario.expected.evolutionMode === "propose-only" &&
    actual.actual.evolutionMode !== "propose-only"
  ) {
    return false;
  }
  if (!classificationMatch(actual, scenario)) {
    return false;
  }
  if (!memoryIdMatch(actual, scenario)) {
    return false;
  }
  if (!recapMatch(actual, scenario)) {
    return false;
  }
  return true;
}

export function scoreActualResults(params: {
  gold: Scenario[];
  actualRows: ActualResult[];
  previousRows?: ActualResult[];
  runId?: string;
  revisions?: RevisionInfo;
}): ScoreReport {
  const fallbackRunId = params.runId ?? createRunId();
  const resolvedRevisions = params.revisions ?? resolveEvalRevisions(process.cwd());
  const goldById = new Map(params.gold.map((scenario) => [scenario.id, scenario]));
  const actualById = new Map(
    params.actualRows.map((row) => [row.scenario_id ?? row.id ?? "", row]).filter(([id]) => id),
  );
  const previousPassById = new Map<string, boolean>();

  if (params.previousRows) {
    for (const row of params.previousRows) {
      const scenarioId = row.scenario_id ?? row.id;
      if (!scenarioId) {
        continue;
      }
      const scenario = goldById.get(scenarioId);
      if (!scenario) {
        continue;
      }
      const normalized = normalizeActualResult(
        row,
        scenario,
        fallbackRunId,
        resolvedRevisions,
      );
      previousPassById.set(scenarioId, scenarioPass(normalized, scenario));
    }
  }

  let passed = 0;
  const bucketTotals = new Map<ScenarioKpi, { total: number; passed: number }>();
  const errorTypeCounts: Partial<Record<EvalErrorType, number>> = {};
  const failures: FailureEntry[] = [];
  const regressions: string[] = [];

  for (const scenario of params.gold) {
    const normalized = normalizeActualResult(
      actualById.get(scenario.id) ?? { scenario_id: scenario.id },
      scenario,
      fallbackRunId,
      resolvedRevisions,
    );
    const ok = scenarioPass(normalized, scenario);
    withRunContext(normalized.runContext, () => {
      runLogger.info("eval.scenario_scored", {
        success: ok,
        errorType: ok ? undefined : normalized.errorType ?? inferErrorType(normalized, scenario),
        summary: ok ? "scenario matched gold" : "scenario diverged from gold",
        meta: {
          scenarioId: scenario.id,
          bucket: normalized.bucket,
          skillExpected: normalized.skillExpected,
          skillActual: normalized.skillActual,
        },
      });
    });
    if (ok) {
      passed += 1;
    } else {
      const errorType = normalized.errorType ?? inferErrorType(normalized, scenario);
      failures.push({
        scenarioId: scenario.id,
        traceId: normalized.runContext.traceId,
        bucket: normalized.bucket,
        errorType,
        notes: normalized.notes || "No note provided.",
      });
      errorTypeCounts[errorType] = (errorTypeCounts[errorType] ?? 0) + 1;
      if (previousPassById.get(scenario.id) === true) {
        regressions.push(scenario.id);
      }
    }
    for (const bucket of scenario.kpis) {
      const bucketScore = bucketTotals.get(bucket) ?? { total: 0, passed: 0 };
      bucketScore.total += 1;
      if (ok) {
        bucketScore.passed += 1;
      }
      bucketTotals.set(bucket, bucketScore);
    }
  }

  return {
    runId: fallbackRunId,
    codeRevision: resolvedRevisions.codeRevision,
    pluginRevision: resolvedRevisions.pluginRevision,
    total: params.gold.length,
    passed,
    failed: params.gold.length - passed,
    passRate: params.gold.length === 0 ? 0 : passed / params.gold.length,
    bucketScores: (Object.keys(KPI_LABELS) as ScenarioKpi[])
      .map((bucket) => {
        const score = bucketTotals.get(bucket);
        if (!score) {
          return null;
        }
        return {
          bucket,
          label: KPI_LABELS[bucket],
          passed: score.passed,
          total: score.total,
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)),
    errorTypeCounts,
    failures: failures.slice(0, 10),
    regressions,
  };
}

export function printGoldSummary(gold: Scenario[]) {
  console.log(`Loaded ${gold.length} gold scenarios.`);
  for (const skill of [
    "memory-intake",
    "memory-recap",
    "memory-audit",
    "memory-evolution",
  ] as const) {
    const count = gold.filter((scenario) => scenario.expected.skill === skill).length;
    console.log(`- ${skill}: ${count}`);
  }
  for (const kpi of Object.keys(KPI_LABELS) as ScenarioKpi[]) {
    const count = gold.filter((scenario) => scenario.kpis.includes(kpi)).length;
    console.log(`- ${KPI_LABELS[kpi]} targets: ${count}`);
  }
}

export function printScoreReport(report: ScoreReport): void {
  console.log("");
  console.log(
    `Overall: ${report.passed}/${report.total} (${Math.round(report.passRate * 100)}%)`,
  );
  for (const bucket of report.bucketScores) {
    console.log(`- ${bucket.label}: ${bucket.passed}/${bucket.total}`);
  }
  console.log("");
  console.log(`Code revision: ${report.codeRevision}`);
  console.log(`Plugin revision: ${report.pluginRevision}`);
  console.log("");
  console.log("Error Types:");
  for (const errorType of ERROR_TYPE_ORDER) {
    const count = report.errorTypeCounts[errorType] ?? 0;
    console.log(`- ${ERROR_TYPE_LABELS[errorType]}: ${count}`);
  }
  console.log("");
  console.log("Top Failed Cases:");
  if (report.failures.length === 0) {
    console.log("- none");
  } else {
    for (const failure of report.failures) {
      console.log(
        `- ${failure.scenarioId} bucket=${failure.bucket} error=${failure.errorType} trace=${failure.traceId} note=${failure.notes}`,
      );
    }
  }
  console.log("");
  console.log("Regressions:");
  if (report.regressions.length === 0) {
    console.log("- none");
  } else {
    for (const regression of report.regressions) {
      console.log(`- ${regression}`);
    }
  }
}

export function runCli(argv: string[]): number {
  const {
    gold: goldPath,
    actual: actualPath,
    previous,
    seedActual,
    summaryOut,
    runId,
  } = parseArgs(argv);
  const gold = readJsonl<Scenario>(goldPath);
  const issues = gold.flatMap((scenario) =>
    validateScenario(scenario).map((issue) => `${scenario.id}: ${issue}`),
  );

  if (issues.length > 0) {
    console.error("Gold dataset validation failed:");
    for (const issue of issues) {
      console.error(`- ${issue}`);
    }
    return 1;
  }

  printGoldSummary(gold);

  if (seedActual) {
    const rows = createSeedActualEntries(gold, runId);
    writeJsonl(seedActual, rows);
    runLogger.info("artifact.actual_seed_written", {
      runId,
      summary: "wrote seeded actual artifact",
      meta: { path: seedActual, count: rows.length },
    });
    console.log("");
    console.log(`Seeded actual template: ${seedActual}`);
    console.log("The seeded file is intentionally blank and will fail scoring until filled.");
    return 0;
  }

  if (!actualPath) {
    console.log("");
    console.log("Pass --actual <file.jsonl> to score a run against the gold labels.");
    console.log("Pass --seed-actual <file.jsonl> to generate a blank actual template.");
    return 0;
  }

  const actualRows = readJsonl<ActualResult>(actualPath);
  const previousRows = previous ? readJsonl<ActualResult>(previous) : undefined;
  const report = scoreActualResults({
    gold,
    actualRows,
    previousRows,
    runId,
  });
  printScoreReport(report);
  writeJson(summaryOut, report);
  runLogger.info("artifact.summary_written", {
    runId: report.runId,
    traceId: undefined,
    summary: "wrote eval summary artifact",
    success: report.failed === 0,
    meta: { path: summaryOut, failed: report.failed, passed: report.passed },
  });
  console.log("");
  console.log(`Wrote summary artifact: ${summaryOut}`);
  return report.failed > 0 ? 1 : 0;
}

const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  process.exitCode = runCli(process.argv.slice(2));
}
