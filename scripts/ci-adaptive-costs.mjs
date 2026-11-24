#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { adaptiveCostMarkdown, estimateAdaptiveCosts } from "./lib/ci-adaptive-costs.mjs";
import { isDirectRunUrl } from "./lib/direct-run.mjs";

function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({
    args,
    options: {
      input: { type: "string" },
      output: { type: "string" },
      markdown: { type: "string" },
    },
  });
  if (!values.input || !values.output) {
    throw new Error(
      "Usage: node scripts/ci-adaptive-costs.mjs --input <scenario.json> --output <report.json> [--markdown <report.md>]",
    );
  }
  const report = estimateAdaptiveCosts(JSON.parse(readFileSync(values.input, "utf8")));
  writeFileSync(values.output, `${JSON.stringify(report, null, 2)}\n`);
  if (values.markdown) {
    writeFileSync(values.markdown, adaptiveCostMarkdown(report));
  }
}
if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  main();
}
