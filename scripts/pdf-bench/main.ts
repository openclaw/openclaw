#!/usr/bin/env node
/**
 * OpenClaw PDF extraction 3-lane benchmark.
 *
 * Lanes:
 *   A — Shipped-path: measures the exact integration paths in OpenClaw
 *   B — Quality: compares parser/representation quality with GT-backed scoring
 *   C — Overhead: isolates invocation/wrapper overhead from parser quality
 *
 * Usage:
 *   pnpm test:pdf:bench3 -- --smoke                          # all lanes, smoke corpus
 *   pnpm test:pdf:bench3 -- --lane a --manifest corpus.json  # lane A only, real corpus
 *   pnpm test:pdf:bench3 -- --lane b --doc-type invoice      # lane B, invoices only
 *   pnpm test:pdf:bench3 -- --lane c --limit 5               # lane C, first 5 docs
 *   pnpm test:pdf:bench3 -- --help
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { checkArmAvailability, setNutrientCommand } from "./arms.js";
import { resolveCorpus, type CorpusOptions } from "./corpus.js";
import { runLaneA } from "./lane-a.js";
import { runLaneB } from "./lane-b.js";
import { runLaneC } from "./lane-c.js";
import { printHumanReport } from "./report.js";
import type { ArmId, BenchConfig, BenchReport, LaneId } from "./types.js";

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

type CliOptions = {
  lanes: LaneId[];
  arms: ArmId[];
  manifestPath?: string;
  gtPath?: string;
  corpusDir?: string;
  pdfPaths: string[];
  inputDir?: string;
  docIds: string[];
  docTypes: string[];
  limit?: number;
  smoke: boolean;
  runs: number;
  warmup: number;
  maxPages: number;
  maxPixels: number;
  minTextChars: number;
  nutrientCommand: string;
  nutrientTimeoutMs: number;
  json: boolean;
  output?: string;
  checkArms: boolean;
};

const DEFAULT_RUNS = 3;
const DEFAULT_WARMUP = 1;
const DEFAULT_MAX_PAGES = 20;
const DEFAULT_MAX_PIXELS = 4_000_000;
const DEFAULT_MIN_TEXT_CHARS = 200;
const DEFAULT_NUTRIENT_COMMAND = "pdf-to-markdown";
const DEFAULT_NUTRIENT_TIMEOUT_MS = 30_000;

function parseFlagValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

function parseRepeatableFlag(flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === flag && process.argv[i + 1]) {
      values.push(process.argv[i + 1]);
    }
  }
  return values;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseLanes(raw: string[]): LaneId[] {
  const valid = new Set<LaneId>(["a", "b", "c"]);
  const lanes = raw.map((s) => s.toLowerCase().trim() as LaneId).filter((l) => valid.has(l));
  return lanes.length > 0 ? lanes : ["a", "b", "c"];
}

function parseOptions(): CliOptions {
  return {
    lanes: parseLanes(parseRepeatableFlag("--lane")),
    arms: parseRepeatableFlag("--arm") as ArmId[],
    manifestPath: parseFlagValue("--manifest"),
    gtPath: parseFlagValue("--gt"),
    corpusDir: parseFlagValue("--corpus-dir"),
    pdfPaths: parseRepeatableFlag("--pdf"),
    inputDir: parseFlagValue("--input-dir"),
    docIds: parseRepeatableFlag("--doc-id"),
    docTypes: parseRepeatableFlag("--doc-type"),
    limit: parseFlagValue("--limit") ? parsePositiveInt(parseFlagValue("--limit"), 0) : undefined,
    smoke: hasFlag("--smoke"),
    runs: parsePositiveInt(parseFlagValue("--runs"), DEFAULT_RUNS),
    warmup: parsePositiveInt(parseFlagValue("--warmup"), DEFAULT_WARMUP),
    maxPages: parsePositiveInt(parseFlagValue("--max-pages"), DEFAULT_MAX_PAGES),
    maxPixels: parsePositiveInt(parseFlagValue("--max-pixels"), DEFAULT_MAX_PIXELS),
    minTextChars: parsePositiveInt(parseFlagValue("--min-text-chars"), DEFAULT_MIN_TEXT_CHARS),
    nutrientCommand: parseFlagValue("--nutrient-command") ?? DEFAULT_NUTRIENT_COMMAND,
    nutrientTimeoutMs: parsePositiveInt(
      parseFlagValue("--nutrient-timeout-ms"),
      DEFAULT_NUTRIENT_TIMEOUT_MS,
    ),
    json: hasFlag("--json"),
    output: parseFlagValue("--output"),
    checkArms: hasFlag("--check-arms"),
  };
}

function printUsage(): void {
  console.log(`OpenClaw PDF extraction 3-lane benchmark

Usage:
  pnpm test:pdf:bench3 -- [options]

Lanes:
  --lane a                        Shipped-path benchmark (pdfjs vs nutrient CLI)
  --lane b                        Parser/representation quality (GT-backed scoring)
  --lane c                        Invocation overhead (cold/warm, throughput)
  (default: all three lanes)

Corpus:
  --manifest <path>               Load dataset-manifest.json
  --gt <path>                     Load extraction_ground_truth.jsonl
  --corpus-dir <dir>              Base directory for manifest-relative PDF paths
  --pdf <path>                    Ad-hoc PDF (repeatable)
  --input-dir <dir>               Load all *.pdf from a directory
  --smoke                         Generate synthetic corpus with embedded GT

Filtering:
  --doc-id <id>                   Filter by document ID (repeatable)
  --doc-type <type>               Filter by document type (repeatable)
  --limit <n>                     Max documents

Arms:
  --arm <id>                      Restrict to specific arms (repeatable)
  --check-arms                    Check arm availability and exit

Tuning:
  --runs <n>                      Measured runs per arm/file (default: ${DEFAULT_RUNS})
  --warmup <n>                    Warmup runs per arm/file (default: ${DEFAULT_WARMUP})
  --max-pages <n>                 Max pages (default: ${DEFAULT_MAX_PAGES})
  --nutrient-command <cmd>        pdf-to-markdown command (default: ${DEFAULT_NUTRIENT_COMMAND})
  --nutrient-timeout-ms <ms>      Nutrient timeout (default: ${DEFAULT_NUTRIENT_TIMEOUT_MS})

Output:
  --output <path>                 Write JSON report to file
  --json                          Print JSON report to stdout
  --help                          Show this help

Arm IDs:
  pdfjs-text                      pdf.js text extraction (baseline)
  nutrient-cli-markdown           Nutrient CLI single-file
  nutrient-cli-batch-markdown     Nutrient CLI sequential batch
  nutrient-py-text                Nutrient Python SDK text (scaffold)
  nutrient-py-markdown            Nutrient Python SDK markdown (scaffold)
  nutrient-py-vision              Nutrient Python SDK vision (scaffold)

Examples:
  pnpm test:pdf:bench3:smoke
  pnpm test:pdf:bench3 -- --manifest /path/to/dataset-manifest.json --gt /path/to/extraction_ground_truth.jsonl
  pnpm test:pdf:bench3 -- --lane b --smoke --doc-type invoice
  pnpm test:pdf:bench3 -- --lane c --pdf /tmp/big-report.pdf --runs 5
  pnpm test:pdf:bench3 -- --check-arms
`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (hasFlag("--help")) {
    printUsage();
    return;
  }

  const options = parseOptions();

  // --check-arms: print availability and exit
  if (options.checkArms) {
    const allIds: ArmId[] = [
      "pdfjs-text",
      "nutrient-cli-markdown",
      "nutrient-cli-batch-markdown",
      "nutrient-py-text",
      "nutrient-py-markdown",
      "nutrient-py-vision",
    ];
    setNutrientCommand(options.nutrientCommand);
    const status = await checkArmAvailability(allIds);
    console.log("Arm availability:");
    for (const s of status) {
      console.log(`  ${s.id.padEnd(30)} ${s.available ? "OK" : "MISSING"}  ${s.label}`);
    }
    return;
  }

  // Resolve corpus
  const corpusOptions: CorpusOptions = {
    manifestPath: options.manifestPath,
    gtPath: options.gtPath,
    corpusDir: options.corpusDir,
    pdfPaths: options.pdfPaths,
    inputDir: options.inputDir,
    smoke: options.smoke,
    docIds: options.docIds.length > 0 ? options.docIds : undefined,
    docTypes: options.docTypes.length > 0 ? options.docTypes : undefined,
    limit: options.limit,
  };

  const resolved = resolveCorpus(corpusOptions);

  const config: BenchConfig = {
    runs: options.runs,
    warmup: options.warmup,
    maxPages: options.maxPages,
    maxPixels: options.maxPixels,
    minTextChars: options.minTextChars,
    nutrientCommand: options.nutrientCommand,
    nutrientTimeoutMs: options.nutrientTimeoutMs,
    lanes: options.lanes,
    arms:
      options.arms.length > 0
        ? options.arms
        : [
            "pdfjs-text",
            "nutrient-cli-markdown",
            "nutrient-cli-batch-markdown",
            "nutrient-py-text",
            "nutrient-py-markdown",
            "nutrient-py-vision",
          ],
    filters: {
      docIds: options.docIds.length > 0 ? options.docIds : undefined,
      docTypes: options.docTypes.length > 0 ? options.docTypes : undefined,
      limit: options.limit,
    },
  };

  try {
    // Configure nutrient command before availability checks
    setNutrientCommand(config.nutrientCommand);

    console.log(`Corpus: ${resolved.entries.length} documents`);
    console.log(`Lanes: ${config.lanes.join(", ")}`);

    // Check arm availability
    const armStatus = await checkArmAvailability(config.arms);
    const availableArmIds = armStatus.filter((s) => s.available).map((s) => s.id);
    const unavailableArms = armStatus.filter((s) => !s.available);
    if (unavailableArms.length > 0) {
      console.log(
        `Unavailable arms (will be skipped): ${unavailableArms.map((a) => a.id).join(", ")}`,
      );
    }
    console.log(`Available arms: ${availableArmIds.join(", ")}`);
    console.log("");

    const report: BenchReport = {
      node: process.version,
      generatedAt: new Date().toISOString(),
      config,
      corpusSize: resolved.entries.length,
      lanes: {},
    };

    if (config.lanes.includes("a")) {
      console.log("Running Lane A (shipped-path)...");
      report.lanes.a = await runLaneA(resolved.entries, config);
    }

    if (config.lanes.includes("b")) {
      console.log("Running Lane B (quality)...");
      report.lanes.b = await runLaneB(resolved.entries, config);
    }

    if (config.lanes.includes("c")) {
      console.log("Running Lane C (overhead)...");
      report.lanes.c = await runLaneC(resolved.entries, config);
    }

    // Output
    if (options.output) {
      mkdirSync(path.dirname(options.output), { recursive: true });
      writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      console.log(`\nJSON report written to: ${options.output}`);
    }

    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log("");
      printHumanReport(report);
    }
  } finally {
    // Clean up smoke corpus temp dir
    if (resolved.smokeTmpDir) {
      rmSync(resolved.smokeTmpDir, { recursive: true, force: true });
    }
  }
}

await main();
