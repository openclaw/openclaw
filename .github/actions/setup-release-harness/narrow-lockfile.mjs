#!/usr/bin/env node
// The trusted harness is a sparse checkout of the workflow revision. pnpm 12 rejects a frozen
// install whose lockfile records importers that are absent on disk, so drop exactly those
// importer entries from the harness-private lockfile copy. Present importers stay byte-identical,
// so the frozen check still fails closed on any real manifest/lockfile drift.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2] ?? ".";
const lockfilePath = join(root, "pnpm-lock.yaml");
const lines = readFileSync(lockfilePath, "utf8").split("\n");
const kept = [];
const dropped = [];
let inImporters = false;
let skipping = false;
for (const line of lines) {
  if (line === "importers:") {
    inImporters = true;
    kept.push(line);
    continue;
  }
  if (inImporters && line !== "" && !line.startsWith(" ")) {
    inImporters = false;
    skipping = false;
  }
  const importer = inImporters ? /^ {2}(\S.*):$/.exec(line) : null;
  if (importer) {
    const id = importer[1].replace(/^'(.*)'$/, "$1");
    skipping = !existsSync(join(root, id, "package.json"));
    if (skipping) {
      dropped.push(id);
    }
  }
  if (!skipping) {
    kept.push(line);
  }
}
if (!kept.includes("  .:")) {
  throw new Error(`${lockfilePath} has no root importer to install.`);
}
writeFileSync(lockfilePath, kept.join("\n"));
console.log(`Narrowed harness lockfile: dropped ${dropped.length} absent importer(s).`);
