#!/usr/bin/env node
// Export versioned CI evidence from existing Vitest resource receipts; no test execution.
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { collectTestObservations } from "./lib/ci-test-observations.mjs";
import { isDirectRunUrl } from "./lib/direct-run.mjs";

function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({
    args,
    options: {
      log: { type: "string" },
      context: { type: "string" },
      dependencies: { type: "string" },
      output: { type: "string" },
    },
  });
  if (!values.log || !values.context || !values.output) {
    throw new Error(
      "Usage: node scripts/ci-test-observations.mjs --log <file> --context <json> [--dependencies <native-json>] --output <json>",
    );
  }
  const observations = collectTestObservations(
    readFileSync(values.log, "utf8"),
    JSON.parse(readFileSync(values.context, "utf8")),
    values.dependencies ? JSON.parse(readFileSync(values.dependencies, "utf8")) : null,
  );
  writeFileSync(values.output, `${JSON.stringify(observations, null, 2)}\n`);
}
if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  main();
}
