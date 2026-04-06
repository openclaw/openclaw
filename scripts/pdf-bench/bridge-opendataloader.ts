#!/usr/bin/env node
/**
 * Bridge: run OpenClaw extraction arms against the opendataloader-bench corpus,
 * then write prediction markdown files compatible with their evaluator.
 *
 * Usage:
 *   pnpm tsx scripts/pdf-bench/bridge-opendataloader.ts \
 *     --bench-dir /tmp/opendataloader-bench \
 *     --nutrient-command /path/to/pdf-to-markdown \
 *     [--limit 10] [--doc-id 01030000000001]
 *
 * This creates:
 *   /tmp/opendataloader-bench/prediction/pdfjs-text/markdown/*.md
 *   /tmp/opendataloader-bench/prediction/pdfjs-text/summary.json
 *   /tmp/opendataloader-bench/prediction/nutrient-cli-openclaw/markdown/*.md
 *   /tmp/opendataloader-bench/prediction/nutrient-cli-openclaw/summary.json
 *
 * Then run their evaluator:
 *   cd /tmp/opendataloader-bench && uv run src/evaluator.py --engine pdfjs-text
 *   cd /tmp/opendataloader-bench && uv run src/evaluator.py --engine nutrient-cli-openclaw
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setNutrientCommand, getArm, checkArmAvailability } from "./arms.js";
import type { ArmId, ArmRunOptions, CorpusEntry } from "./types.js";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseFlagValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
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

const benchDir = parseFlagValue("--bench-dir") ?? "/tmp/opendataloader-bench";
const nutrientCommand = parseFlagValue("--nutrient-command") ?? "pdf-to-markdown";
const limitRaw = parseFlagValue("--limit");
const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
const docIds = new Set(parseRepeatableFlag("--doc-id"));
const maxPages = 50; // opendataloader corpus has some multi-page docs

if (hasFlag("--help")) {
  console.log(`Bridge: run OpenClaw arms against opendataloader-bench corpus

Usage:
  pnpm tsx scripts/pdf-bench/bridge-opendataloader.ts [options]

Options:
  --bench-dir <path>          Path to opendataloader-bench repo (default: /tmp/opendataloader-bench)
  --nutrient-command <cmd>    pdf-to-markdown CLI path
  --limit <n>                 Max documents to process
  --doc-id <id>               Process specific doc ID (repeatable)
  --help                      Show this help

After running, evaluate with:
  cd /tmp/opendataloader-bench
  uv run src/evaluator.py --engine pdfjs-text
  uv run src/evaluator.py --engine nutrient-cli-openclaw
`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Corpus loading
// ---------------------------------------------------------------------------

const pdfDir = path.join(benchDir, "pdfs");

function loadCorpus(): CorpusEntry[] {
  const pdfFiles = readdirSync(pdfDir)
    .filter((f) => f.endsWith(".pdf"))
    .toSorted();

  let entries: CorpusEntry[] = pdfFiles.map((f) => {
    const id = f.replace(/\.pdf$/, "");
    const filePath = path.join(pdfDir, f);
    const buffer = readFileSync(filePath);
    return {
      id,
      label: f,
      filePath,
      bytes: buffer.length,
      buffer,
    };
  });

  if (docIds.size > 0) {
    entries = entries.filter((e) => docIds.has(e.id));
  }
  if (limit && limit > 0) {
    entries = entries.slice(0, limit);
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Arm execution + markdown output
// ---------------------------------------------------------------------------

type ArmConfig = {
  armId: ArmId;
  outputName: string;
};

const ARMS: ArmConfig[] = [
  { armId: "pdfjs-text", outputName: "pdfjs-text" },
  { armId: "nutrient-cli-markdown", outputName: "nutrient-cli-openclaw" },
];

async function runArm(
  armConfig: ArmConfig,
  corpus: CorpusEntry[],
  runOptions: ArmRunOptions,
): Promise<{ totalMs: number; successCount: number; failCount: number }> {
  const arm = getArm(armConfig.armId);
  const outDir = path.join(benchDir, "prediction", armConfig.outputName, "markdown");
  mkdirSync(outDir, { recursive: true });

  let totalMs = 0;
  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < corpus.length; i++) {
    const entry = corpus[i];
    const progress = `[${i + 1}/${corpus.length}]`;
    process.stdout.write(`  ${progress} ${entry.id}...`);

    const output = await arm.extract(entry, runOptions);
    totalMs += output.timing.durationMs;

    if (output.error) {
      failCount++;
      process.stdout.write(` ERR: ${output.error.slice(0, 80)}\n`);
      // Write empty file so evaluator knows it was attempted
      writeFileSync(path.join(outDir, `${entry.id}.md`), "", "utf8");
    } else {
      successCount++;
      const text = output.markdown ?? output.text;
      writeFileSync(path.join(outDir, `${entry.id}.md`), text, "utf8");
      process.stdout.write(
        ` ${output.counts.chars} chars ${output.timing.durationMs.toFixed(0)}ms\n`,
      );
    }
  }

  // Write summary.json
  const summary = {
    engine_name: armConfig.outputName,
    engine_version: "openclaw-bench3",
    processor: "benchmark bridge",
    document_count: corpus.length,
    total_elapsed: totalMs / 1000,
    elapsed_per_doc: totalMs / 1000 / Math.max(1, corpus.length),
    date: new Date().toISOString().slice(0, 10),
  };
  const summaryPath = path.join(benchDir, "prediction", armConfig.outputName, "summary.json");
  writeFileSync(summaryPath, JSON.stringify(summary, null, 2), "utf8");

  return { totalMs, successCount, failCount };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  setNutrientCommand(nutrientCommand);

  const corpus = loadCorpus();
  console.log(`Corpus: ${corpus.length} documents from ${pdfDir}`);
  console.log(`Nutrient command: ${nutrientCommand}`);
  console.log("");

  // Check arm availability
  const armStatus = await checkArmAvailability(ARMS.map((a) => a.armId));
  for (const s of armStatus) {
    console.log(`  ${s.id.padEnd(30)} ${s.available ? "OK" : "MISSING"}`);
  }
  console.log("");

  const runOptions: ArmRunOptions = {
    maxPages,
    maxPixels: 4_000_000,
    minTextChars: 200,
    nutrientCommand,
    nutrientTimeoutMs: 60_000,
  };

  for (const armConfig of ARMS) {
    const arm = armStatus.find((s) => s.id === armConfig.armId);
    if (!arm?.available) {
      console.log(`Skipping ${armConfig.outputName} (${armConfig.armId} not available)`);
      continue;
    }

    console.log(`Running ${armConfig.outputName} (${armConfig.armId})...`);
    const result = await runArm(armConfig, corpus, runOptions);
    console.log(
      `  Done: ${result.successCount} ok, ${result.failCount} failed, ${(result.totalMs / 1000).toFixed(1)}s total\n`,
    );
  }

  console.log("Predictions written. Run evaluation with:");
  for (const armConfig of ARMS) {
    console.log(`  cd ${benchDir} && uv run src/evaluator.py --engine ${armConfig.outputName}`);
  }
}

await main();
