#!/usr/bin/env node
import path from "node:path";
import { writeBundledQaRunnerCatalog } from "../src/plugins/qa-runner-catalog.js";

const args = new Set(process.argv.slice(2));
const checkOnly = args.has("--check");
const writeMode = args.has("--write");

if (checkOnly === writeMode) {
  console.error("Use exactly one of --check or --write.");
  process.exit(1);
}

const repoRoot = process.cwd();
const result = await writeBundledQaRunnerCatalog({
  repoRoot,
  check: checkOnly,
});

if (checkOnly) {
  if (result.changed) {
    console.error(
      [
        "QA runner catalog drift detected.",
        `Expected current: ${path.relative(repoRoot, result.jsonPath)}`,
        "If this QA runner metadata change is intentional, run `pnpm qa-runners:gen` and commit the updated baseline file.",
        "If not intentional, fix the bundled plugin metadata drift first.",
      ].join("\n"),
    );
    process.exit(1);
  }
  console.log(`OK ${path.relative(repoRoot, result.jsonPath)}`);
} else {
  console.log(`Wrote ${path.relative(repoRoot, result.jsonPath)}`);
}
