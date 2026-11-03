#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { planAdaptiveSelection } from "./lib/ci-adaptive-selection.mjs";
import { isDirectRunUrl } from "./lib/direct-run.mjs";

function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({
    args,
    options: {
      observations: { type: "string" },
      request: { type: "string" },
      recommendations: { type: "string" },
      output: { type: "string" },
    },
  });
  if (!values.observations || !values.request || !values.output) {
    throw new Error(
      "Usage: node scripts/ci-adaptive-select.mjs --observations <json> --request <json> [--recommendations <json>] --output <json>",
    );
  }
  const read = (file) => JSON.parse(readFileSync(file, "utf8"));
  const report = planAdaptiveSelection(
    read(values.observations),
    read(values.request),
    values.recommendations ? read(values.recommendations) : null,
  );
  writeFileSync(values.output, `${JSON.stringify(report, null, 2)}\n`);
}
if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  main();
}
