#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { readBoundedRegularFile } from "./lib/actions-artifact-archive.mjs";
import { rankAdaptiveJev } from "./lib/ci-adaptive-jev.mjs";
import { isDirectRunUrl } from "./lib/direct-run.mjs";

async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({
    args,
    options: { request: { type: "string" }, output: { type: "string" } },
  });
  if (!values.request || !values.output) {
    throw new Error(
      "Usage: node scripts/ci-adaptive-jev.mjs --request <selection-request.json> --output <ranking.json>",
    );
  }
  const request = JSON.parse(
    readBoundedRegularFile(values.request, {
      label: "Adaptive selection request",
      maxBytes: 8 * 1024 * 1024,
    }).toString("utf8"),
  );
  const ranking = await rankAdaptiveJev(request);
  writeFileSync(values.output, `${JSON.stringify(ranking, null, 2)}\n`);
}
if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  await main();
}
