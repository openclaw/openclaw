import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import {
  collectControlUiCoverageAttribution,
  formatControlUiCoverageAttribution,
  type CoverageInventoryScope,
} from "./lib/control-ui-module-attribution.mts";

const { values } = parseArgs({
  options: {
    dist: { type: "string" },
    coverage: { type: "string" },
    summary: { type: "string" },
    run: { type: "string", default: "1" },
    output: { type: "string" },
    help: { type: "boolean" },
  },
});
if (values.help) {
  console.log(
    "Usage: node --import ./scripts/tsx.mjs scripts/analyze-control-ui-coverage.mts --dist <exact-build> --coverage <run-N.coverage.json> [--summary <summary.json> --run N] [--output <report.json>]",
  );
} else {
  if (!values.dist || !values.coverage) {
    throw new Error("--dist and --coverage are required; use the exact bundle from the capture");
  }
  const readJson = (file: string): unknown => JSON.parse(fs.readFileSync(file, "utf8"));
  const coverage = z
    .array(
      z.object({
        url: z.string(),
        loadedBytes: z.number().int().nonnegative(),
        functions: z.array(
          z.object({
            ranges: z.array(
              z.object({
                startOffset: z.number().int().nonnegative(),
                endOffset: z.number().int().nonnegative(),
                count: z.number().nonnegative(),
              }),
            ),
          }),
        ),
      }),
    )
    .parse(readJson(values.coverage));
  let resources: { url: string; decodedBytes: number }[] | undefined;
  let inventoryScope: CoverageInventoryScope = "V8 only";
  if (values.summary) {
    const run = z.coerce.number().int().positive().parse(values.run);
    const resource = z.object({ url: z.string(), decodedBytes: z.number().nonnegative() });
    const summary = z
      .object({
        results: z.array(
          z.object({
            run: z.number(),
            coverageResources: z.array(resource).optional(),
            http: z.object({ waterfall: z.array(resource) }).optional(),
          }),
        ),
      })
      .parse(readJson(values.summary));
    const result = summary.results.find((entry) => entry.run === run);
    if (!result) {
      throw new Error(`No run ${run} in ${values.summary}`);
    }
    resources = result.coverageResources ?? result.http?.waterfall;
    if (!resources) {
      throw new Error(`No resource inventory for run ${run} in ${values.summary}`);
    }
    inventoryScope = result.coverageResources
      ? "coverage cutoff"
      : "whole-run (may include later fetches)";
  }
  const report = collectControlUiCoverageAttribution(
    values.dist,
    coverage,
    resources,
    inventoryScope,
  );
  if (values.output) {
    fs.mkdirSync(path.dirname(values.output), { recursive: true });
    fs.writeFileSync(values.output, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(formatControlUiCoverageAttribution(report));
}
