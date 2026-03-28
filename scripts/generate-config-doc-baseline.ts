#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeConfigDocBaselineStatefile } from "../src/config/doc-baseline.js";

const args = new Set(process.argv.slice(2));
const checkOnly = args.has("--check");

if (checkOnly && args.has("--write")) {
  console.error("Use either --check or --write, not both.");
  process.exit(1);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  const result = await writeConfigDocBaselineStatefile({
    repoRoot,
    check: checkOnly,
  });

  if (checkOnly) {
    if (!result.changed) {
      console.log(
        `OK ${path.relative(repoRoot, result.jsonPath)} ${path.relative(repoRoot, result.statefilePath)}`,
      );
      process.exit(0);
    }
    console.error(
      [
        "Config baseline drift detected.",
        `Expected JSON baseline: ${path.relative(repoRoot, result.jsonPath)}`,
        `Expected current: ${path.relative(repoRoot, result.statefilePath)}`,
        "If this config-surface change is intentional, run `pnpm config:docs:gen` and commit the updated baseline files.",
        "If not intentional, treat this as docs drift or a possible breaking config change and fix the schema/help changes first.",
      ].join("\n"),
    );
    process.exit(1);
  }

  console.log(
    [
      `Wrote ${path.relative(repoRoot, result.jsonPath)}`,
      `Wrote ${path.relative(repoRoot, result.statefilePath)}`,
    ].join("\n"),
  );
} catch (error) {
  console.error("Failed to generate config doc baseline:", error);
  process.exit(1);
}
