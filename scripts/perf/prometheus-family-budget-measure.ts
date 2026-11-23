/**
 * node --import ./scripts/tsx.mjs scripts/perf/prometheus-family-budget-measure.ts output.json [store.ts]
 * Frozen observed family counts plus current families and 121 reader operations.
 * Synthetic labels only. Pass a saved store module for interleaved baseline/A/A runs.
 * Accept zero drops with unchanged total cap; report cold admission separately
 * from 100 warm recording passes. This measures the store owner, not Gateway I/O.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { loadavg } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  familyBudgetPopulation,
  populateFamilyBudget,
} from "../../extensions/diagnostics-prometheus/src/family-budget.test-support.js";
import { measureSynchronous } from "../../extensions/diagnostics-prometheus/src/metric-store-record-measure.test-support.js";

const output = process.argv[2];
assert(output, "output.json required");
const {
  createPrometheusMetricStore,
}: typeof import("../../extensions/diagnostics-prometheus/src/prometheus-metric-store.js") =
  await import(
    process.argv[3]
      ? pathToFileURL(resolve(process.argv[3])).href
      : new URL(
          "../../extensions/diagnostics-prometheus/src/prometheus-metric-store.js",
          import.meta.url,
        ).href
  );
const population = familyBudgetPopulation();
const store = createPrometheusMetricStore();
const batch = () => populateFamilyBudget(store, population);
const hostLoad = loadavg();
const cold = measureSynchronous(batch);
for (let index = 0; index < 60; index++) {
  batch();
}
const warm = measureSynchronous(() => {
  for (let index = 0; index < 100; index++) {
    batch();
  }
});
const body = store.render().toString();
const lines = body.split("\n");
const families = population.map((row) => {
  const name = row.type === "histogram" ? `${row.name}_count` : row.name;
  const samples = lines.filter((line) => line.startsWith(`${name}{`));
  return {
    name: row.name,
    offered: row.labelSets,
    retained: samples.length,
    total: samples.reduce((sum, line) => sum + Number(line.split(" ").at(-1)), 0),
  };
});
await writeFile(`${output}.prom`, body);
await writeFile(
  output,
  JSON.stringify(
    {
      node: process.version,
      hostLoad,
      passes: 161,
      observationsPerPass: population.reduce((sum, row) => sum + row.labelSets, 0),
      cold,
      warm,
      families,
      bytes: Buffer.byteLength(body),
      drops: lines.filter(
        (line) => line.startsWith("openclaw_prometheus_") && line.includes("dropped_total"),
      ),
    },
    null,
    2,
  ) + "\n",
);
