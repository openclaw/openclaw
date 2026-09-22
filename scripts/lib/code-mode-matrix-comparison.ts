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
