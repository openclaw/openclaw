/**
 * Report generation — human-readable and JSON output.
 * Clearly separates extraction fidelity, downstream task quality,
 * token efficiency, and latency/operational cost.
 */

import { formatMs, formatPct } from "./stats.js";
import type {
  ArmAggregate,
  ArmComparison,
  ArmId,
  BenchReport,
  DocResult,
  LaneAReport,
  LaneBReport,
  LaneCReport,
} from "./types.js";

// ---------------------------------------------------------------------------
// Human-readable report
// ---------------------------------------------------------------------------

export function printHumanReport(report: BenchReport): void {
  console.log("=".repeat(72));
  console.log("  OpenClaw PDF Extraction 3-Lane Benchmark");
  console.log("=".repeat(72));
  console.log(`  Node: ${report.node}`);
  console.log(`  Generated: ${report.generatedAt}`);
  console.log(`  Corpus: ${report.corpusSize} documents`);
  console.log(`  Lanes: ${report.config.lanes.join(", ")}`);
  console.log("");

  if (report.lanes.a) {
    printLaneA(report.lanes.a);
  }
  if (report.lanes.b) {
    printLaneB(report.lanes.b);
  }
  if (report.lanes.c) {
    printLaneC(report.lanes.c);
  }
}

// ---------------------------------------------------------------------------
// Lane A
// ---------------------------------------------------------------------------

function printLaneA(lane: LaneAReport): void {
  console.log("-".repeat(72));
  console.log(`  ${lane.title}`);
  console.log(`  ${lane.description}`);
  console.log("-".repeat(72));
  console.log("");

  printArmAggregateTable(lane.aggregate, lane.arms);

  if (lane.comparison) {
    printComparison(lane.comparison);
  }

  // Per-doc detail (compact)
  printDocSummary(lane.docs);
  console.log("");
}

// ---------------------------------------------------------------------------
// Lane B
// ---------------------------------------------------------------------------

function printLaneB(lane: LaneBReport): void {
  console.log("-".repeat(72));
  console.log(`  ${lane.title}`);
  console.log(`  ${lane.description}`);
  console.log("-".repeat(72));
  console.log("");

  console.log("  Overall:");
  printArmAggregateTable(lane.aggregate, lane.arms);

  if (lane.byDocType && Object.keys(lane.byDocType).length > 0) {
    for (const [docType, agg] of Object.entries(lane.byDocType)) {
      console.log(`  By doc-type: ${docType}`);
      printArmAggregateTable(agg, lane.arms);
    }
  }

  if (lane.comparison) {
    printComparison(lane.comparison);
  }

  // Per-doc scoring detail
  printDocScoring(lane.docs);
  console.log("");
}

// ---------------------------------------------------------------------------
// Lane C
// ---------------------------------------------------------------------------

function printLaneC(lane: LaneCReport): void {
  console.log("-".repeat(72));
  console.log(`  ${lane.title}`);
  console.log(`  ${lane.description}`);
  console.log("-".repeat(72));
  console.log("");

  const header =
    "  arm                          docs  avgMs    p50Ms    p95Ms    coldMs   warmMs   throughput  fails";
  console.log(header);
  for (const armId of lane.arms) {
    const agg = lane.aggregate[armId];
    if (!agg) {
      continue;
    }
    const line = [
      `  ${armId.padEnd(30)}`,
      String(agg.docCount).padStart(4),
      formatMs(agg.avgPerDocMs).padStart(8),
      formatMs(agg.p50PerDocMs).padStart(8),
      formatMs(agg.p95PerDocMs).padStart(8),
      agg.coldMs != null ? formatMs(agg.coldMs).padStart(8) : "     n/a",
      agg.warmAvgMs != null ? formatMs(agg.warmAvgMs).padStart(8) : "     n/a",
      `${agg.throughputDocsPerSec.toFixed(2).padStart(10)}/s`,
      String(agg.failureCount).padStart(5),
    ].join(" ");
    console.log(line);
  }

  // Cold vs warm delta for batch arm
  const batch = lane.aggregate["nutrient-cli-batch-markdown"];
  const pdfjs = lane.aggregate["pdfjs-text"];
  if (batch && pdfjs) {
    console.log("");
    console.log("  Overhead analysis:");
    const overheadMs = batch.avgPerDocMs - (pdfjs.avgPerDocMs || 0.001);
    const overheadPct = pdfjs.avgPerDocMs > 0 ? (overheadMs / pdfjs.avgPerDocMs) * 100 : null;
    console.log(
      `    CLI overhead vs pdfjs: ${overheadMs >= 0 ? "+" : ""}${formatMs(overheadMs)} (${formatPct(overheadPct)})`,
    );
    if (batch.coldMs != null && batch.warmAvgMs != null) {
      const coldWarmDelta = batch.coldMs - batch.warmAvgMs;
      console.log(
        `    Cold vs warm delta: ${coldWarmDelta >= 0 ? "+" : ""}${formatMs(coldWarmDelta)} (cold startup cost)`,
      );
    }
  }
  console.log("");
}

// ---------------------------------------------------------------------------
// Shared formatting
// ---------------------------------------------------------------------------

function printArmAggregateTable(aggregate: Record<ArmId, ArmAggregate>, armIds: ArmId[]): void {
  const header =
    "  arm                          docs  avgMs    p50Ms    chars    tokens   empty fails  accuracy";
  console.log(header);
  for (const armId of armIds) {
    const agg = aggregate[armId];
    if (!agg) {
      continue;
    }
    const acc = agg.avgAccuracy != null ? `${(agg.avgAccuracy * 100).toFixed(1)}%` : "n/a";
    const line = [
      `  ${armId.padEnd(30)}`,
      String(agg.docCount).padStart(4),
      formatMs(agg.avgDurationMs).padStart(8),
      formatMs(agg.p50DurationMs).padStart(8),
      agg.avgChars.toFixed(0).padStart(8),
      agg.avgTokenEstimate.toFixed(0).padStart(8),
      String(agg.emptyCount).padStart(5),
      String(agg.failureCount).padStart(5),
      acc.padStart(9),
    ].join(" ");
    console.log(line);
  }
  console.log("");
}

function printComparison(comparison: ArmComparison): void {
  console.log(`  Comparison (baseline: ${comparison.baseArm}):`);
  for (const arm of comparison.arms) {
    if (arm.armId === comparison.baseArm) {
      continue;
    }
    const parts = [
      `    ${arm.armId}:`,
      `duration ${arm.durationDeltaMs >= 0 ? "+" : ""}${formatMs(arm.durationDeltaMs)} (${formatPct(arm.durationDeltaPct)})`,
      `chars ${arm.charsDelta >= 0 ? "+" : ""}${arm.charsDelta.toFixed(0)}`,
      `tokens ${arm.tokenDelta >= 0 ? "+" : ""}${arm.tokenDelta.toFixed(0)}`,
    ];
    if (arm.accuracyDelta != null) {
      parts.push(
        `accuracy ${arm.accuracyDelta >= 0 ? "+" : ""}${(arm.accuracyDelta * 100).toFixed(1)}pp`,
      );
    }
    console.log(parts.join("  "));
  }
  console.log("");
}

function printDocSummary(docs: DocResult[]): void {
  const byDoc = new Map<string, DocResult[]>();
  for (const d of docs) {
    const existing = byDoc.get(d.docId) ?? [];
    existing.push(d);
    byDoc.set(d.docId, existing);
  }

  console.log("  Per-document summary:");
  for (const [docId, results] of byDoc) {
    const first = results[0];
    console.log(`    ${first?.label ?? docId} (${first?.bytes ?? 0} bytes)`);
    for (const r of results) {
      const acc = r.score?.overallAccuracy;
      const accStr = acc != null ? `acc=${(acc * 100).toFixed(0)}%` : "acc=n/a";
      console.log(
        `      ${r.armId.padEnd(28)} ${formatMs(r.output.timing.durationMs).padStart(8)} chars=${r.output.counts.chars} ${accStr}${r.output.error ? ` ERR: ${r.output.error}` : ""}`,
      );
    }
  }
}

function printDocScoring(docs: DocResult[]): void {
  const byDoc = new Map<string, DocResult[]>();
  for (const d of docs) {
    const existing = byDoc.get(d.docId) ?? [];
    existing.push(d);
    byDoc.set(d.docId, existing);
  }

  console.log("  Per-document scoring:");
  for (const [docId, results] of byDoc) {
    const first = results[0];
    console.log(`    ${first?.label ?? docId} [${first?.docType ?? "unknown"}]`);
    for (const r of results) {
      const s = r.score;
      if (!s) {
        console.log(`      ${r.armId.padEnd(28)} no GT`);
        continue;
      }
      const parts = [`      ${r.armId.padEnd(28)}`];
      if (s.textFieldsScore) {
        parts.push(`fields=${s.textFieldsScore.found}/${s.textFieldsScore.total}`);
      }
      if (s.keyValuesScore) {
        parts.push(`kv=${s.keyValuesScore.found}/${s.keyValuesScore.total}`);
      }
      if (s.tablesScore) {
        parts.push(`tables=${s.tablesScore.found}/${s.tablesScore.total}`);
        if (s.tablesScore.cellAccuracy != null) {
          parts.push(`cells=${(s.tablesScore.cellAccuracy * 100).toFixed(0)}%`);
        }
      }
      if (s.snippetScore) {
        parts.push(`snippets=${s.snippetScore.found}/${s.snippetScore.total}`);
      }
      parts.push(`tokens=${s.tokenEstimate}`);
      if (s.overallAccuracy != null) {
        parts.push(`overall=${(s.overallAccuracy * 100).toFixed(1)}%`);
      }
      console.log(parts.join(" "));
    }
  }
}
