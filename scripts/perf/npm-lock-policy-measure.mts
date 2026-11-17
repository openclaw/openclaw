#!/usr/bin/env node
// Run with: node --import tsx scripts/perf/npm-lock-policy-measure.mts <report.json> [package-dir ...]
// Measure the production generator, including real npm stabilization and every validation.
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import {
  generateNpmPackageLock,
  listManagedNpmLockPackageDirs,
} from "../generate-npm-package-lock.mts";

const [output, ...selected] = process.argv.slice(2);
if (!output) {
  throw new Error("Expected a report path and optional package directories");
}
const root = path.resolve(process.env.OPENCLAW_NPM_PACKAGE_LOCK_REPO_ROOT || ".");
const lockPath = path.join(root, "pnpm-lock.yaml");
const lockSha256 = createHash("sha256").update(fs.readFileSync(lockPath)).digest("hex");
const readFileSync = fs.readFileSync;
let reads = 0;
// Forward every overload unchanged; Parameters selects the final overload for the body.
fs.readFileSync = function (...args: Parameters<typeof readFileSync>) {
  if (String(args[0]) === lockPath) {
    reads++;
  }
  return readFileSync(...args);
} as typeof readFileSync;
syncBuiltinESMExports();
const packageDirs = selected.length ? selected : [".", ...listManagedNpmLockPackageDirs(root)];
const samples = [];
try {
  for (const packageDir of packageDirs) {
    const beforeReads = reads;
    const load = loadavg();
    const start = performance.now();
    const generated = generateNpmPackageLock(path.resolve(root, packageDir));
    samples.push({
      packageDir,
      wallMs: performance.now() - start,
      reads: reads - beforeReads,
      bytes: Buffer.byteLength(generated),
      sha256: createHash("sha256").update(generated).digest("hex"),
      load,
    });
  }
} finally {
  fs.readFileSync = readFileSync;
  syncBuiltinESMExports();
  fs.writeFileSync(
    output,
    JSON.stringify({ lockSha256, samples, usage: process.resourceUsage() }, null, 2) + "\n",
  );
}
