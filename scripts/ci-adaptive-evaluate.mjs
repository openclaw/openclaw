#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { readBoundedRegularFile } from "./lib/actions-artifact-archive.mjs";
import { evaluateAdaptiveCapture } from "./lib/ci-adaptive-evaluation.mjs";
import { isDirectRunUrl } from "./lib/direct-run.mjs";

function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({
    args,
    options: { input: { type: "string" }, output: { type: "string" } },
  });
  if (!values.input || !values.output) {
    throw new Error(
      "Usage: node scripts/ci-adaptive-evaluate.mjs --input <observations.json> --output <report.json>",
    );
  }
  const capture = JSON.parse(
    readBoundedRegularFile(values.input, {
      label: "Adaptive observation export",
      maxBytes: 8 * 1024 * 1024,
    }).toString("utf8"),
  );
  const report = evaluateAdaptiveCapture(capture);
  writeFileSync(values.output, `${JSON.stringify(report, null, 2)}\n`);
}
if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  main();
}
