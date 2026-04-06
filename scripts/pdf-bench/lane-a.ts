/**
 * Lane A — Shipped-path benchmark.
 *
 * Measures the exact current integration paths as they would be used in OpenClaw.
 * Uses pdfjs-text and nutrient-cli-markdown (the two engines available in the
 * shipped extractPdfContent() function).
 *
 * Answers: "Should OpenClaw change the default extraction path today?"
 */

import { getAvailableArms } from "./arms.js";
import { scoreArmOutput } from "./scoring.js";
import { mean, summarize } from "./stats.js";
import type {
  ArmAggregate,
  ArmComparison,
  ArmId,
  ArmRunOptions,
  BenchConfig,
  CorpusEntry,
  DocResult,
  LaneAReport,
} from "./types.js";

const LANE_A_ARMS: ArmId[] = ["pdfjs-text", "nutrient-cli-markdown"];

export async function runLaneA(corpus: CorpusEntry[], config: BenchConfig): Promise<LaneAReport> {
  const requestedArms = config.arms.filter((a) => LANE_A_ARMS.includes(a));
  const arms = await getAvailableArms(requestedArms.length > 0 ? requestedArms : LANE_A_ARMS);

  if (arms.length === 0) {
    throw new Error("Lane A: no arms available. Need at least pdfjs-text.");
  }

  const runOptions: ArmRunOptions = {
    maxPages: config.maxPages,
    maxPixels: config.maxPixels,
    minTextChars: config.minTextChars,
    nutrientCommand: config.nutrientCommand,
    nutrientTimeoutMs: config.nutrientTimeoutMs,
  };

  const docs: DocResult[] = [];
  const totalRuns = config.warmup + config.runs;

  for (const entry of corpus) {
    for (const arm of arms) {
      // Warmup + measured runs
      const measured: DocResult[] = [];
      for (let run = 0; run < totalRuns; run++) {
        const output = await arm.extract(entry, runOptions);
        if (run < config.warmup) {
          continue;
        }
        const score = scoreArmOutput(output, entry);
        measured.push({
          docId: entry.id,
          label: entry.label,
          docType: entry.docType,
          bytes: entry.bytes ?? 0,
          armId: arm.id,
          output,
          score,
        });
      }
      // Use median run for the doc result
      const sorted = measured.toSorted(
        (a, b) => a.output.timing.durationMs - b.output.timing.durationMs,
      );
      const medianResult = sorted[Math.floor(sorted.length / 2)] ?? sorted[0];
      if (medianResult) {
        docs.push(medianResult);
      }
    }
  }

  const armIds = arms.map((a) => a.id);
  const aggregate = buildAggregate(docs, armIds);
  const comparison = buildComparison(aggregate, armIds);

  return {
    lane: "a",
    title: "Lane A: Shipped-Path Benchmark",
    description:
      "Measures the exact current integration paths (pdfjs-text vs nutrient-cli-markdown) as used in OpenClaw. Answers: Should OpenClaw change the default extraction path today?",
    generatedAt: new Date().toISOString(),
    config,
    arms: armIds,
    docs,
    aggregate,
    comparison,
  };
}

// ---------------------------------------------------------------------------
// Aggregation helpers
// ---------------------------------------------------------------------------

function buildAggregate(docs: DocResult[], armIds: ArmId[]): Record<ArmId, ArmAggregate> {
  const result: Record<string, ArmAggregate> = {};
  for (const armId of armIds) {
    const armDocs = docs.filter((d) => d.armId === armId);
    const durations = armDocs.map((d) => d.output.timing.durationMs);
    const chars = armDocs.map((d) => d.output.counts.chars);
    const tokens = armDocs.map((d) => d.output.tokenEstimate ?? 0);
    const accuracies = armDocs
      .map((d) => d.score?.overallAccuracy)
      .filter((a): a is number => typeof a === "number");
    const textFieldAcc = armDocs
      .map((d) => d.score?.textFieldsScore?.accuracy)
      .filter((a): a is number => typeof a === "number");
    const kvAcc = armDocs
      .map((d) => d.score?.keyValuesScore?.accuracy)
      .filter((a): a is number => typeof a === "number");
    const tableAcc = armDocs
      .map((d) => d.score?.tablesScore?.accuracy)
      .filter((a): a is number => typeof a === "number");
    const snippetAcc = armDocs
      .map((d) => d.score?.snippetScore?.accuracy)
      .filter((a): a is number => typeof a === "number");

    const stats = summarize(durations);
    result[armId] = {
      armId,
      docCount: armDocs.length,
      avgDurationMs: stats.avg,
      p50DurationMs: stats.p50,
      p95DurationMs: stats.p95,
      avgChars: mean(chars),
      avgTokenEstimate: mean(tokens),
      emptyCount: armDocs.filter((d) => d.output.counts.empty).length,
      failureCount: armDocs.filter((d) => d.output.error).length,
      ...(accuracies.length > 0 ? { avgAccuracy: mean(accuracies) } : {}),
      ...(textFieldAcc.length > 0 ? { avgTextFieldsAccuracy: mean(textFieldAcc) } : {}),
      ...(kvAcc.length > 0 ? { avgKeyValuesAccuracy: mean(kvAcc) } : {}),
      ...(tableAcc.length > 0 ? { avgTablesAccuracy: mean(tableAcc) } : {}),
      ...(snippetAcc.length > 0 ? { avgSnippetAccuracy: mean(snippetAcc) } : {}),
    };
  }
  return result as Record<ArmId, ArmAggregate>;
}

function buildComparison(
  aggregate: Record<ArmId, ArmAggregate>,
  armIds: ArmId[],
): ArmComparison | undefined {
  const base = aggregate["pdfjs-text"];
  if (!base || armIds.length < 2) {
    return undefined;
  }
  return {
    baseArm: "pdfjs-text",
    arms: armIds.map((id) => {
      const arm = aggregate[id];
      if (!arm) {
        return {
          armId: id,
          durationDeltaMs: 0,
          durationDeltaPct: null,
          charsDelta: 0,
          tokenDelta: 0,
        };
      }
      const durationDelta = arm.avgDurationMs - base.avgDurationMs;
      return {
        armId: id,
        durationDeltaMs: durationDelta,
        durationDeltaPct:
          base.avgDurationMs > 0 ? (durationDelta / base.avgDurationMs) * 100 : null,
        charsDelta: arm.avgChars - base.avgChars,
        tokenDelta: arm.avgTokenEstimate - base.avgTokenEstimate,
        ...(arm.avgAccuracy != null && base.avgAccuracy != null
          ? { accuracyDelta: arm.avgAccuracy - base.avgAccuracy }
          : {}),
      };
    }),
  };
}

// Re-export the aggregate builder for other lanes
export { buildAggregate, buildComparison };
