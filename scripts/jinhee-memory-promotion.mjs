#!/usr/bin/env node
/**
 * jinhee-memory-promotion.mjs — MEMORY-PROMOTION-004 CLI
 *
 * Reads a batch markdown file and promotes approved candidates to canonical_memories.
 *
 * Usage:
 *   node scripts/jinhee-memory-promotion.mjs --batch PATH --db PATH [--dry-run] [--apply]
 *
 * Safety:
 *   --dry-run is the DEFAULT. --apply is required to actually write.
 */

import { readFile } from "fs/promises";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Parse args
const args = process.argv.slice(2);
const batchIdx = args.indexOf("--batch");
const dbIdx = args.indexOf("--db");
const isDryRun = !args.includes("--apply"); // default dry-run
const isApply = args.includes("--apply");

if (batchIdx === -1 || batchIdx + 1 >= args.length) {
  console.error(
    "Usage: node scripts/jinhee-memory-promotion.mjs --batch PATH --db PATH [--dry-run] [--apply]",
  );
  console.error("  --batch PATH     Path to promotion batch markdown file");
  console.error("  --db PATH        Path to jinhee.db");
  console.error("  --dry-run        (default) Simulate only, no DB write");
  console.error("  --apply          Execute INSERT into canonical_memories");
  process.exit(1);
}

const batchPath = resolve(args[batchIdx + 1]);
const dbPath = args[dbIdx + 1] ? resolve(args[dbIdx + 1]) : "/home/savit/ai/jinhee_data/jinhee.db";

async function main() {
  // Dynamic import to avoid tsx dependency in scripts/
  const modPath = resolve(__dirname, "../src/agents/jinhee-memory-promotion.ts");
  const mod = await import(modPath);

  console.log(`MEMORY-PROMOTION-004 CLI`);
  console.log(`  batch: ${batchPath}`);
  console.log(`  db:    ${dbPath}`);
  console.log(`  mode:  ${isApply ? "APPLY (write)" : "DRY RUN (read-only)"}`);
  console.log();

  // Read and parse batch file
  const batchText = await readFile(batchPath, "utf-8");
  const candidates = mod.parseBatchFile(batchText);

  if (candidates.length === 0) {
    console.error("ERROR: No candidates found in batch file.");
    console.error("Check the batch file format. Expected PROMOTE-NNN sections.");
    process.exit(1);
  }

  console.log(`Parsed ${candidates.length} candidates from batch file.`);
  console.log();

  // Validate first
  let validCount = 0;
  let skipCount = 0;
  for (let i = 0; i < candidates.length; i++) {
    const err = mod.isValidPromotionItem(candidates[i], i);
    if (err) {
      console.log(`  SKIP ${candidates[i].sourceCandidateId}: ${err}`);
      skipCount++;
    } else {
      validCount++;
    }
  }
  console.log(`\nValidation: ${validCount} valid, ${skipCount} skipped`);

  // Execute promotion (dry-run by default)
  const result = await mod.promoteApprovedCanonicalMemories(candidates, {
    dbPath,
    dryRun: !isApply,
    maxBatch: 20,
  });

  if (!result.ok) {
    console.error(`\nERROR: ${result.reason}`);
    process.exit(1);
  }

  console.log(`\n--- Result ---`);
  console.log(`  OK:        ${result.ok}`);
  console.log(`  dryRun:    ${result.dryRun}`);
  console.log(`  before:    ${result.beforeCount}`);
  console.log(`  after:     ${result.afterCount}`);
  console.log(
    `  inserted:  ${result.insertedIds.length} (IDs: ${result.insertedIds.join(", ") || "none"})`,
  );
  console.log(`  skipped:   ${result.skipped.length}`);
  console.log(`  rollback:  ${result.rollbackSql.slice(0, 100)}...`);
  console.log();

  if (result.skipped.length > 0) {
    console.log("Skipped items:");
    for (const s of result.skipped) {
      console.log(`  - ${s.sourceCandidateId}: ${s.reason}`);
    }
  }
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
