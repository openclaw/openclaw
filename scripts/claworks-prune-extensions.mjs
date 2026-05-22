#!/usr/bin/env node
/**
 * Physically remove non-industrial extensions from the ClaWorks fork.
 * Manifest: contrib/claworks-extensions-prune.json
 */
import { rmSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(root, "contrib/claworks-extensions-prune.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const apply = process.argv.includes("--apply");
const dryRun = process.argv.includes("--dry-run") || !apply;

if (!dryRun && !apply) {
  console.log("Usage: node scripts/claworks-prune-extensions.mjs --dry-run | --apply");
  process.exit(1);
}

const removed = [];
const missing = [];

for (const id of manifest.prune) {
  const dir = join(root, "extensions", id);
  if (!existsSync(dir)) {
    missing.push(id);
    continue;
  }
  if (apply) {
    rmSync(dir, { recursive: true, force: true });
  }
  removed.push(id);
}

console.log(`${apply ? "Removed" : "Would remove"} ${removed.length} extension(s):`);
for (const id of removed) {
  console.log(`  - ${id}`);
}
if (missing.length > 0) {
  console.log(`Already absent (${missing.length}): ${missing.join(", ")}`);
}
if (manifest.deferred?.length) {
  console.log("\nDeferred (not pruned):");
  for (const entry of manifest.deferred) {
    console.log(`  - ${entry.id}: ${entry.reason}`);
  }
}
if (dryRun) {
  console.log("\nRe-run with --apply to delete directories.");
}
