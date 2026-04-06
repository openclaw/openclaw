/**
 * Lane B — Parser / representation quality benchmark.
 *
 * Compares output representations fairly across all available arms:
 *   - pdfjs-text (baseline)
 *   - nutrient-cli-markdown
 *   - nutrient-py-text (scaffold)
 *   - nutrient-py-markdown (scaffold)
 *   - nutrient-py-vision (scaffold)
 *
 * Uses fixed GT-backed scoring with text_fields, key_values, tables, snippets.
 * Groups results by doc-type for focused analysis.
 *
 * Answers: "Is Nutrient core technology actually better for downstream use?"
 */

import { getAvailableArms } from "./arms.js";
import { buildAggregate, buildComparison } from "./lane-a.js";
import { scoreArmOutput } from "./scoring.js";
import type {
  ArmAggregate,
  ArmId,
  ArmRunOptions,
  BenchConfig,
  CorpusEntry,
  DocResult,
  LaneBReport,
} from "./types.js";

const LANE_B_ARMS: ArmId[] = [
  "pdfjs-text",
  "nutrient-cli-markdown",
  "nutrient-py-text",
  "nutrient-py-markdown",
  "nutrient-py-vision",
];

export async function runLaneB(corpus: CorpusEntry[], config: BenchConfig): Promise<LaneBReport> {
  const requestedArms = config.arms.filter((a) => LANE_B_ARMS.includes(a));
  const arms = await getAvailableArms(requestedArms.length > 0 ? requestedArms : LANE_B_ARMS);

  if (arms.length === 0) {
    throw new Error("Lane B: no arms available.");
  }

  const runOptions: ArmRunOptions = {
    maxPages: config.maxPages,
    maxPixels: config.maxPixels,
    minTextChars: config.minTextChars,
    nutrientCommand: config.nutrientCommand,
    nutrientTimeoutMs: config.nutrientTimeoutMs,
  };

  const docs: DocResult[] = [];

  // Lane B uses a single run (no warmup/repeat) since we care about
  // representation quality, not timing precision.
  for (const entry of corpus) {
    for (const arm of arms) {
      const output = await arm.extract(entry, runOptions);
      const score = scoreArmOutput(output, entry);
      docs.push({
        docId: entry.id,
        label: entry.label,
        docType: entry.docType,
        bytes: entry.bytes ?? 0,
        armId: arm.id,
        output,
        score,
      });
    }
  }

  const armIds = arms.map((a) => a.id);
  const aggregate = buildAggregate(docs, armIds);
  const comparison = buildComparison(aggregate, armIds);
  const byDocType = buildDocTypeBreakdown(docs, armIds);

  return {
    lane: "b",
    title: "Lane B: Parser / Representation Quality Benchmark",
    description:
      "Compares output quality across extraction engines with GT-backed scoring. Groups results by document type. Answers: Is Nutrient core technology actually better for downstream use?",
    generatedAt: new Date().toISOString(),
    config,
    arms: armIds,
    docs,
    aggregate,
    byDocType,
    comparison,
  };
}

// ---------------------------------------------------------------------------
// Doc-type breakdown
// ---------------------------------------------------------------------------

function buildDocTypeBreakdown(
  docs: DocResult[],
  armIds: ArmId[],
): Record<string, Record<ArmId, ArmAggregate>> {
  const docTypes = new Set(docs.map((d) => d.docType).filter(Boolean) as string[]);
  const result: Record<string, Record<ArmId, ArmAggregate>> = {};

  for (const docType of docTypes) {
    const typeDocs = docs.filter((d) => d.docType === docType);
    result[docType] = buildAggregate(typeDocs, armIds);
  }

  return result;
}
