import fs from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { CodeModeMatrixCellResult } from "../code-mode-model-matrix.ts";

const comparableResult = z
  .object({
    id: z.string(),
    model: z.string(),
    mode: z.string(),
    task: z.string(),
    repetition: z.number().int().positive(),
    passed: z.boolean(),
    gitSha: z.string(),
    elapsedMs: z.number().finite().nonnegative(),
    assistantTurns: z.number().finite().nonnegative().optional(),
    costUsd: z.number().finite().nonnegative().optional(),
    oracle: z.object({ identity: z.boolean().optional() }).passthrough().optional(),
    workload: z
      .object({
        promptSha256: z.string(),
        fixtureSha256: z.string(),
        settings: z.object({ thinking: z.string(), timeoutSeconds: z.number() }).passthrough(),
      })
      .optional(),
    gateway: z
      .object({
        upstreamCalls: z.number().int().nonnegative().optional(),
        taskElapsedMs: z.number().finite().nonnegative().optional(),
        traceAvailable: z.boolean().optional(),
        behavior: z.record(z.string(), z.unknown()).optional(),
        interview: z
          .object({
            traceAvailable: z.boolean().optional(),
            checks: z.record(z.string(), z.unknown()).optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
    usage: z
      .object({
        input: z.number().optional(),
        output: z.number().optional(),
        total: z.number().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

type ComparableResult = z.infer<typeof comparableResult>;

type GatewayCheckEvidence = {
  traceAvailable?: boolean;
  behavior?: Record<string, unknown>;
  interview?: { traceAvailable?: boolean; checks?: Record<string, unknown> };
};

function readGatewayMatrixOutcomes(gateway?: GatewayCheckEvidence) {
  const observed = (traceAvailable?: boolean, checks?: Record<string, unknown>): boolean | null => {
    const values = Object.values(checks ?? {});
    return traceAvailable === true &&
      values.length > 0 &&
      values.every((value) => typeof value === "boolean")
      ? values.every(Boolean)
      : null;
  };
  return {
    taskBehaviorPassed: observed(gateway?.traceAvailable, gateway?.behavior),
    interviewConsistencyPassed: observed(
      gateway?.interview?.traceAvailable,
      gateway?.interview?.checks,
    ),
  };
}

export function summarizeGatewayMatrixOutcomes(
  results: readonly { gateway?: GatewayCheckEvidence }[],
) {
  const outcomes = results.map((result) => readGatewayMatrixOutcomes(result.gateway));
  const count = (values: (boolean | null)[]) => ({
    passed: values.filter((value) => value === true).length,
    failed: values.filter((value) => value === false).length,
    unavailable: values.filter((value) => value === null).length,
  });
  return {
    taskBehavior: count(outcomes.map((result) => result.taskBehaviorPassed)),
    interviewConsistency: count(outcomes.map((result) => result.interviewConsistencyPassed)),
  };
}

function difference(before: number | undefined, after: number | undefined): number | null {
  return before === undefined || after === undefined ? null : after - before;
}

function metricDifferences(before: ComparableResult, after: ComparableResult) {
  return {
    taskElapsedMs: difference(before.gateway?.taskElapsedMs, after.gateway?.taskElapsedMs),
    assistantTurns: difference(before.assistantTurns, after.assistantTurns),
    upstreamCalls: difference(before.gateway?.upstreamCalls, after.gateway?.upstreamCalls),
    inputTokens: difference(before.usage?.input, after.usage?.input),
    outputTokens: difference(before.usage?.output, after.usage?.output),
    costUsd: difference(before.costUsd, after.costUsd),
  };
}

/** Match fixed workloads before reporting measurements; missing metrics remain missing. */
export function compareCodeModeMatrixResults(
  baselineValues: readonly unknown[],
  candidateValues: readonly unknown[],
) {
  const index = (values: readonly unknown[]) => {
    const entries = new Map<string, ComparableResult>();
    for (const value of values) {
      const result = comparableResult.parse(value);
      if (!result.workload) {
        throw new Error(
          "Comparison requires fixed workload fingerprints on every row, including failures.",
        );
      }
      if (entries.has(result.id)) {
        throw new Error(`Duplicate comparison cell: ${result.id}`);
      }
      entries.set(result.id, result);
    }
    return entries;
  };
  const baseline = index(baselineValues);
  const candidate = index(candidateValues);
  if (baseline.size !== candidate.size || [...baseline.keys()].some((id) => !candidate.has(id))) {
    throw new Error(
      "Baseline and candidate must contain the same model/mode/task/repetition cells.",
    );
  }
  const cells = [...candidate.values()].map((after) => {
    const before = baseline.get(after.id)!;
    if (
      before.model !== after.model ||
      before.mode !== after.mode ||
      before.task !== after.task ||
      before.repetition !== after.repetition ||
      before.workload?.promptSha256 !== after.workload?.promptSha256 ||
      before.workload?.fixtureSha256 !== after.workload?.fixtureSha256 ||
      !isDeepStrictEqual(before.workload?.settings, after.workload?.settings)
    ) {
      throw new Error(`Comparison workload changed for ${after.id}; rerun the fixed benchmark.`);
    }
    const bothPassed = before.passed && after.passed;
    const beforeOutcomes = readGatewayMatrixOutcomes(before.gateway);
    const afterOutcomes = readGatewayMatrixOutcomes(after.gateway);
    const bothTasksPassed =
      beforeOutcomes.taskBehaviorPassed === true && afterOutcomes.taskBehaviorPassed === true;
    const modelsMatched = before.oracle?.identity === true && after.oracle?.identity === true;
    return {
      id: after.id,
      model: after.model,
      task: after.task,
      baselineSha: before.gitSha,
      candidateSha: after.gitSha,
      baselinePassed: before.passed,
      candidatePassed: after.passed,
      bothPassed,
      // Failed task timings are retained in the source rows, never called speedups.
      deltas: bothPassed ? metricDifferences(before, after) : null,
      taskBehavior: {
        baselinePassed: beforeOutcomes.taskBehaviorPassed,
        candidatePassed: afterOutcomes.taskBehaviorPassed,
        bothPassed: bothTasksPassed,
        modelsMatched,
        deltas: bothTasksPassed && modelsMatched ? metricDifferences(before, after) : null,
      },
      interviewConsistency: {
        baselinePassed: beforeOutcomes.interviewConsistencyPassed,
        candidatePassed: afterOutcomes.interviewConsistencyPassed,
      },
    };
  });
  const beforeSummary = summarizeGatewayMatrixOutcomes([...baseline.values()]);
  const afterSummary = summarizeGatewayMatrixOutcomes([...candidate.values()]);
  return {
    interpretation:
      "Paired observations of fixed tasks. Overall deltas require two successful runs; taskBehavior deltas require two observed successful task-behavior checks and confirmed requested-model identities. Interview consistency is separate from manual understanding review. Deltas are candidate minus baseline, not statistical performance guarantees.",
    baselinePassed: [...baseline.values()].filter((row) => row.passed).length,
    candidatePassed: [...candidate.values()].filter((row) => row.passed).length,
    total: cells.length,
    outcomes: {
      taskBehavior: {
        baseline: beforeSummary.taskBehavior,
        candidate: afterSummary.taskBehavior,
      },
      interviewConsistency: {
        baseline: beforeSummary.interviewConsistency,
        candidate: afterSummary.interviewConsistency,
      },
    },
    cells,
  };
}

export async function compareCodeModeMatrixResultsFile(
  baselinePath: string,
  candidate: readonly CodeModeMatrixCellResult[],
) {
  if ((await fs.stat(baselinePath)).size > 16 * 1024 * 1024) {
    throw new Error("Baseline results exceed the 16 MiB comparison limit.");
  }
  const rows: unknown[] = (await fs.readFile(baselinePath, "utf8"))
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
  return compareCodeModeMatrixResults(rows, candidate);
}

const modeResult = comparableResult.extend({
  mode: z.enum(["direct", "code"]),
  buildSha256: z.string(),
  sourceDirty: z.boolean(),
  sourcePatchSha256: z.string().nullable(),
  accounting: z
    .object({
      complete: z.boolean(),
      costComplete: z.boolean(),
      totalTokens: z.number().finite().nonnegative().nullable(),
      costUsd: z.number().finite().nonnegative().nullable(),
      knownTotalTokens: z.number().finite().nonnegative(),
      knownCostUsd: z.number().finite().nonnegative(),
      toolFailures: z.number().int().nonnegative(),
      modelErrors: z.number().int().nonnegative(),
    })
    .passthrough()
    .optional(),
});

type ModeResult = z.infer<typeof modeResult>;
type ModePair = { direct: ModeResult; code: ModeResult };

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function completedTask(row: ModeResult): boolean {
  return row.passed && row.oracle?.identity === true;
}

function tokens(row: ModeResult): number | null {
  return row.accounting?.complete ? (row.accounting.totalTokens ?? null) : null;
}

function price(row: ModeResult): number | null {
  return row.accounting?.costComplete ? (row.accounting.costUsd ?? null) : null;
}

function percentile(sorted: readonly number[], quantile: number): number | null {
  if (sorted.length === 0) {
    return null;
  }
  const index = (sorted.length - 1) * quantile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (index - lower);
}

/** These deliberately selected workloads support descriptive pilot statistics only. */
function distribution(values: readonly number[]) {
  const sorted = values.toSorted((a, b) => a - b);
  const mean =
    values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  return {
    samples: values.length,
    mean,
    p50: percentile(sorted, 0.5),
    min: sorted[0] ?? null,
    max: sorted.at(-1) ?? null,
  };
}

function modeTotals(rows: readonly ModeResult[]) {
  const completed = rows.filter(completedTask).length;
  const tokenValues = rows.map(tokens);
  const costValues = rows.map(price);
  const tokenTotal = tokenValues.every((value) => value !== null)
    ? tokenValues.reduce<number>((sum, value) => sum + (value ?? 0), 0)
    : null;
  const costTotal = costValues.every((value) => value !== null)
    ? costValues.reduce<number>((sum, value) => sum + (value ?? 0), 0)
    : null;
  return {
    attempts: rows.length,
    completed,
    failed: rows.length - completed,
    successRate: rows.length > 0 ? completed / rows.length : null,
    completedWithObservedErrors: rows.filter(
      (row) =>
        completedTask(row) &&
        row.accounting &&
        row.accounting.toolFailures + row.accounting.modelErrors > 0,
    ).length,
    usageMissing: tokenValues.filter((value) => value === null).length,
    costMissing: costValues.filter((value) => value === null).length,
    knownTotalTokens: rows.reduce((sum, row) => sum + (row.accounting?.knownTotalTokens ?? 0), 0),
    knownCostUsd: rows.reduce((sum, row) => sum + (row.accounting?.knownCostUsd ?? 0), 0),
    totalTokens: tokenTotal,
    costUsd: costTotal,
    // Failed attempts stay in the numerator, even when no task completes.
    tokensPerCompletedTask: completed > 0 && tokenTotal !== null ? tokenTotal / completed : null,
    costPerCompletedTask: completed > 0 && costTotal !== null ? costTotal / completed : null,
  };
}

function pairMeasurement(pair: ModePair, measure: (row: ModeResult) => number | null) {
  const direct = measure(pair.direct);
  const code = measure(pair.code);
  return completedTask(pair.direct) && completedTask(pair.code) && direct !== null && code !== null
    ? { direct, code, delta: code - direct, ratio: direct > 0 ? code / direct : null }
    : null;
}

function summarizeModeGroup(rows: readonly ModeResult[], pairs: readonly ModePair[]) {
  const direct = modeTotals(rows.filter((row) => row.mode === "direct"));
  const code = modeTotals(rows.filter((row) => row.mode === "code"));
  const unmatched = rows.length - pairs.length * 2;
  const successfulPairs = pairs.filter(
    (pair) => completedTask(pair.direct) && completedTask(pair.code),
  );
  const usageComplete = unmatched === 0 && direct.usageMissing === 0 && code.usageMissing === 0;
  const costComplete = usageComplete && direct.costMissing === 0 && code.costMissing === 0;
  const tokenDeltas = successfulPairs.flatMap((pair) => {
    const observation = pairMeasurement(pair, tokens);
    return observation ? [observation.delta] : [];
  });
  const costDeltas = successfulPairs.flatMap((pair) => {
    const observation = pairMeasurement(pair, price);
    return observation ? [observation.delta] : [];
  });
  const latenciesComplete = successfulPairs.every(
    (pair) =>
      pair.direct.gateway?.taskElapsedMs !== undefined &&
      pair.code.gateway?.taskElapsedMs !== undefined,
  );
  const successDeltas = pairs.map(
    (pair) => Number(completedTask(pair.code)) - Number(completedTask(pair.direct)),
  );
  return {
    models: [...new Set(rows.map((row) => row.model))],
    tasks: [...new Set(rows.map((row) => row.task))],
    pairs: pairs.length,
    unmatched,
    successfulPairs: successfulPairs.length,
    direct,
    code,
    pairedSuccessDifference: distribution(successDeltas),
    pairedSuccessfulDeltas: {
      totalTokens: usageComplete ? distribution(tokenDeltas) : null,
      costUsd: costComplete ? distribution(costDeltas) : null,
      taskElapsedMs:
        unmatched === 0 && latenciesComplete
          ? distribution(
              successfulPairs.map(
                (pair) => pair.code.gateway!.taskElapsedMs! - pair.direct.gateway!.taskElapsedMs!,
              ),
            )
          : null,
    },
    operationalRatios: {
      totalTokensPerCompletedTask:
        usageComplete &&
        direct.tokensPerCompletedTask !== null &&
        direct.tokensPerCompletedTask > 0 &&
        code.tokensPerCompletedTask !== null
          ? code.tokensPerCompletedTask / direct.tokensPerCompletedTask
          : null,
      costPerCompletedTask:
        costComplete &&
        direct.costPerCompletedTask !== null &&
        direct.costPerCompletedTask > 0 &&
        code.costPerCompletedTask !== null
          ? code.costPerCompletedTask / direct.costPerCompletedTask
          : null,
    },
  };
}

/** Same-source treatment comparison; the existing revision comparator remains unchanged. */
export function compareCodeModeMatrixModes(values: readonly unknown[]) {
  if (values.length > 10_000) {
    throw new Error("Mode comparison exceeds the 10,000-observation bound.");
  }
  const rows = values.map((value) => modeResult.parse(value));
  const groups = new Map<string, Partial<Record<"direct" | "code", ModeResult>>>();
  for (const row of rows) {
    if (!row.workload) {
      throw new Error("Mode comparison requires workload fingerprints on every attempt.");
    }
    const identity = canonicalJson({
      model: row.model,
      task: row.task,
      repetition: row.repetition,
      gitSha: row.gitSha,
      buildSha256: row.buildSha256,
      sourceDirty: row.sourceDirty,
      sourcePatchSha256: row.sourcePatchSha256,
      workload: row.workload,
    });
    const group = groups.get(identity) ?? {};
    if (group[row.mode]) {
      throw new Error(`Duplicate mode-comparison observation: ${row.id}`);
    }
    group[row.mode] = row;
    groups.set(identity, group);
  }
  const pairs: ModePair[] = [];
  const incompletePairs: string[] = [];
  for (const group of groups.values()) {
    if (group.direct && group.code) {
      pairs.push({ direct: group.direct, code: group.code });
    } else {
      incompletePairs.push((group.direct ?? group.code)!.id);
    }
  }
  const grouped = (includeTask: boolean) => {
    const subsets = new Map<string, ModeResult[]>();
    for (const row of rows) {
      const settings = row.workload!.settings;
      const identity = canonicalJson({
        model: row.model,
        ...(includeTask
          ? { task: row.task, settings }
          : { thinking: settings.thinking, fast: settings.fast, runtime: settings.runtime }),
        gitSha: row.gitSha,
        buildSha256: row.buildSha256,
        sourcePatchSha256: row.sourcePatchSha256,
      });
      const subset = subsets.get(identity) ?? [];
      subset.push(row);
      subsets.set(identity, subset);
    }
    return [...subsets]
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([identity, subset]) => {
        const members = new Set(subset);
        return Object.assign(
          { identity: JSON.parse(identity) as unknown },
          summarizeModeGroup(
            subset,
            pairs.filter((pair) => members.has(pair.direct) && members.has(pair.code)),
          ),
        );
      });
  };
  return {
    interpretation:
      "Code minus direct, paired on model/task/seed, exact source/build, prompt/fixture and all settings. Completion means automated artifact/effect checks passed; final-response correctness and independent-task integrity require separate adjudication. All scheduled attempts contribute to operational totals; missing usage suppresses token savings for the entire group. Completed-with-observed-errors counts successful cells containing tool or model errors, including expected probes; it does not measure repair turns. Cost placeholders remain unavailable. Task latency excludes startup/interview. No comparison mixes models or reasoning settings.",
    uncertainty:
      "Exploratory pilot of deliberately selected heterogeneous tasks, not a random population sample. Counts, means, medians and ranges describe these observations only; there are no inferential intervals or statistical readiness gates. Ratios use the observed schedule's task frequencies; inspect task groups before aggregating. Unattempted or entirely absent pairs are not represented by results alone; consult the retained schedule.",
    incompletePairs,
    byModel: grouped(false),
    byTask: grouped(true),
    pairs: pairs.map((pair) => ({
      directId: pair.direct.id,
      codeId: pair.code.id,
      model: pair.direct.model,
      task: pair.direct.task,
      repetition: pair.direct.repetition,
      bothCompleted: completedTask(pair.direct) && completedTask(pair.code),
      usageComplete: tokens(pair.direct) !== null && tokens(pair.code) !== null,
      totalTokens: pairMeasurement(pair, tokens),
      costUsd: pairMeasurement(pair, price),
    })),
  };
}
