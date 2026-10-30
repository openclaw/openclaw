/**
 * Status-shaped catalog projection, including one fresh view per reply.
 * Run on a synthetic benchmark host, alternating baseline/candidate launch order:
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/model-catalog-runtime-measure.ts \
 *   --mode baseline --iterations 1000 [--allocations] [--owner /path/to/model-catalog-view.ts]
 * Repeat with --mode candidate. Allocation sampling is a separate pass; its CPU is not a gate.
 * Baseline uses the existing single-entry selector; candidate uses the view's grouped selector.
 * Defaults: 500 logical models, 1,000 API/native variants, 40 synthetic providers.
 * This measures catalog projection, not a Gateway or full status reply.
 */
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { ModelCatalogEntry } from "../../src/agents/model-catalog.types.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    mode: { type: "string" },
    iterations: { type: "string", default: "1000" },
    warmup: { type: "string", default: "20" },
    models: { type: "string", default: "500" },
    providers: { type: "string", default: "40" },
    allocations: { type: "boolean", default: false },
    owner: { type: "string" },
  },
});
assert(values.mode === "baseline" || values.mode === "candidate", "Pass --mode baseline|candidate");
const count = (name: "iterations" | "warmup" | "models" | "providers") =>
  parseStrictIntegerOption({ raw: values[name], label: `--${name}`, min: 1, fallback: 1 });
const iterations = count("iterations");
const warmup = count("warmup");
const models = count("models");
const providers = count("providers");
const ownerUrl = values.owner
  ? pathToFileURL(values.owner)
  : new URL("../../src/agents/model-catalog-view.ts", import.meta.url);
const {
  createModelCatalogView,
  selectModelCatalogRuntimeEntry,
}: typeof import("../../src/agents/model-catalog-view.js") = await import(ownerUrl.href);
const catalog: ModelCatalogEntry[] = Array.from({ length: models }, (_, index) => ({
  provider: `fixture-${index % providers}`,
  id: `model-${index}`,
  name: `Synthetic model ${index}`,
  api: "openai-completions",
  contextWindow: 131_072,
}));
const routeVariants: ModelCatalogEntry[] = catalog.flatMap((entry) => [
  entry,
  { ...entry, nativeRuntime: "fixture-native", contextWindow: 65_536 },
]);
const runtimeId = "fixture-native";
let checksum = 0;
const project =
  values.mode === "baseline"
    ? () =>
        catalog.map(
          (entry) =>
            selectModelCatalogRuntimeEntry({
              entry,
              routeVariants,
              runtimeId,
              allowApiFallback: false,
            }).entry,
        )
    : () => {
        const view = createModelCatalogView({ cfg: {}, catalog, routeVariants });
        return catalog.map(
          (entry) =>
            view.selectRuntimeEntry({
              entry,
              runtimeId,
              allowApiFallback: false,
            }).entry,
        );
      };
for (const entry of project()) {
  assert.equal(entry.nativeRuntime, runtimeId);
  assert.equal(entry.contextWindow, 65_536);
}
for (let i = 0; i < warmup; i++) {
  checksum += project().length;
}
global.gc?.();
const inspector = new Session();
if (values.allocations) {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 32768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const loadStart = os.loadavg();
const memoryStart = process.memoryUsage();
const cpuStart = process.cpuUsage();
const start = performance.now();
for (let i = 0; i < iterations; i++) {
  const entries = project();
  checksum += entries.length + (entries[i % models]?.contextWindow ?? 0);
}
const elapsedMs = performance.now() - start;
const cpu = process.cpuUsage(cpuStart);
const memoryEnd = process.memoryUsage();
let sampledAllocationBytes: number | undefined;
if (values.allocations) {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  sampledAllocationBytes = profile.samples.reduce((total, sample) => total + sample.size, 0);
  inspector.disconnect();
}
console.log(
  JSON.stringify({
    mode: values.mode,
    allocations: values.allocations,
    node: process.version,
    owner: ownerUrl.href,
    models,
    providers,
    variants: routeVariants.length,
    warmup,
    iterations,
    elapsedMs,
    cpuMs: (cpu.user + cpu.system) / 1000,
    cpuMsPerReply: (cpu.user + cpu.system) / 1000 / iterations,
    sampledAllocationBytes,
    sampledAllocationBytesPerReply:
      sampledAllocationBytes === undefined ? undefined : sampledAllocationBytes / iterations,
    rssStart: memoryStart.rss,
    rssEnd: memoryEnd.rss,
    heapUsedStart: memoryStart.heapUsed,
    heapUsedEnd: memoryEnd.heapUsed,
    loadStart,
    loadEnd: os.loadavg(),
    checksum,
  }),
);
