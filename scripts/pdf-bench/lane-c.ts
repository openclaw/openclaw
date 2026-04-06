/**
 * Lane C — Invocation overhead benchmark.
 *
 * Measures how much performance is due to wrapper/CLI overhead vs parser quality:
 *   - pdfjs-text (in-process, no subprocess)
 *   - nutrient-cli-markdown (one subprocess per file)
 *   - nutrient-cli-batch-markdown (sequential, measures cold vs warm)
 *   - nutrient-py-text (scaffold — would be in-process via Python)
 *
 * Reports cold/warm timing, per-doc timing, throughput, and failure counts.
 *
 * Answers: "How much of the current latency gap is caused by CLI/process overhead?"
 */

import { getArm, getAvailableArms } from "./arms.js";
import { mean, summarize } from "./stats.js";
import type {
  ArmId,
  ArmRunOptions,
  BenchConfig,
  CorpusEntry,
  LaneCReport,
  OverheadAggregate,
  OverheadResult,
} from "./types.js";

const LANE_C_ARMS: ArmId[] = [
  "pdfjs-text",
  "nutrient-cli-markdown",
  "nutrient-cli-batch-markdown",
  "nutrient-py-text",
];

export async function runLaneC(corpus: CorpusEntry[], config: BenchConfig): Promise<LaneCReport> {
  const requestedArms = config.arms.filter((a) => LANE_C_ARMS.includes(a));
  const arms = await getAvailableArms(requestedArms.length > 0 ? requestedArms : LANE_C_ARMS);

  if (arms.length === 0) {
    throw new Error("Lane C: no arms available.");
  }

  const runOptions: ArmRunOptions = {
    maxPages: config.maxPages,
    maxPixels: config.maxPixels,
    minTextChars: config.minTextChars,
    nutrientCommand: config.nutrientCommand,
    nutrientTimeoutMs: config.nutrientTimeoutMs,
  };

  const overheadResults: OverheadResult[] = [];

  for (const arm of arms) {
    // If arm supports batch mode, use it (measures cold vs warm)
    if (arm.extractBatch) {
      const batchResult = await runBatchOverhead(arm.id, corpus, runOptions, arm.extractBatch);
      overheadResults.push(batchResult);
    } else {
      // Single-file mode: run each doc individually
      const result = await runSingleFileOverhead(arm.id, corpus, runOptions);
      overheadResults.push(result);
    }
  }

  const armIds = arms.map((a) => a.id);
  const aggregate = buildOverheadAggregate(overheadResults);

  return {
    lane: "c",
    title: "Lane C: Invocation Overhead Benchmark",
    description:
      "Measures invocation overhead by comparing in-process extraction (pdfjs) with subprocess-per-file (nutrient CLI) and sequential batch. Reports cold/warm timing, throughput, and failure counts. Answers: How much of the current latency gap is caused by CLI/process overhead?",
    generatedAt: new Date().toISOString(),
    config,
    arms: armIds,
    overheadResults,
    aggregate,
  };
}

// ---------------------------------------------------------------------------
// Single-file overhead measurement
// ---------------------------------------------------------------------------

async function runSingleFileOverhead(
  armId: ArmId,
  corpus: CorpusEntry[],
  options: ArmRunOptions,
): Promise<OverheadResult> {
  const arm = getArm(armId);
  const perDocMs: number[] = [];
  let failures = 0;
  const totalStart = process.hrtime.bigint();

  for (const entry of corpus) {
    const output = await arm.extract(entry, options);
    perDocMs.push(output.timing.durationMs);
    if (output.error) {
      failures++;
    }
  }

  const totalMs = Number(process.hrtime.bigint() - totalStart) / 1e6;

  return {
    armId,
    docCount: corpus.length,
    totalDurationMs: totalMs,
    perDocDurationMs: perDocMs,
    coldDurationMs: perDocMs[0],
    warmAvgDurationMs: perDocMs.length > 1 ? mean(perDocMs.slice(1)) : undefined,
    failureCount: failures,
    throughputDocsPerSec: totalMs > 0 ? (corpus.length / totalMs) * 1000 : 0,
  };
}

// ---------------------------------------------------------------------------
// Batch overhead measurement
// ---------------------------------------------------------------------------

async function runBatchOverhead(
  armId: ArmId,
  corpus: CorpusEntry[],
  options: ArmRunOptions,
  extractBatch: (
    entries: CorpusEntry[],
    options: ArmRunOptions,
  ) => Promise<Array<{ timing: { durationMs: number; cold?: boolean }; error?: string }>>,
): Promise<OverheadResult> {
  const totalStart = process.hrtime.bigint();
  const outputs = await extractBatch(corpus, options);
  const totalMs = Number(process.hrtime.bigint() - totalStart) / 1e6;

  const perDocMs = outputs.map((o) => o.timing.durationMs);
  const cold = outputs.find((o) => o.timing.cold);
  const warm = outputs.filter((o) => !o.timing.cold);
  const failures = outputs.filter((o) => o.error).length;

  return {
    armId,
    docCount: corpus.length,
    totalDurationMs: totalMs,
    perDocDurationMs: perDocMs,
    coldDurationMs: cold?.timing.durationMs,
    warmAvgDurationMs: warm.length > 0 ? mean(warm.map((o) => o.timing.durationMs)) : undefined,
    failureCount: failures,
    throughputDocsPerSec: totalMs > 0 ? (corpus.length / totalMs) * 1000 : 0,
  };
}

// ---------------------------------------------------------------------------
// Aggregate
// ---------------------------------------------------------------------------

function buildOverheadAggregate(results: OverheadResult[]): Record<ArmId, OverheadAggregate> {
  const agg: Record<string, OverheadAggregate> = {};
  for (const r of results) {
    const stats = summarize(r.perDocDurationMs);
    agg[r.armId] = {
      armId: r.armId,
      docCount: r.docCount,
      avgPerDocMs: stats.avg,
      p50PerDocMs: stats.p50,
      p95PerDocMs: stats.p95,
      totalMs: r.totalDurationMs,
      throughputDocsPerSec: r.throughputDocsPerSec,
      failureCount: r.failureCount,
      coldMs: r.coldDurationMs,
      warmAvgMs: r.warmAvgDurationMs,
    };
  }
  return agg as Record<ArmId, OverheadAggregate>;
}
