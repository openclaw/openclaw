/**
 * Measure the real plugin-health formatter with 40 synthetic plugins.
 * Save the base owner with git show <base>:src/status/status-plugin-health.ts
 * to a .ts file; run each revision in separate, alternating processes:
 * node --expose-gc scripts/perf/misc-fresh-array-copies-measure.mjs \
 *   --owner-file <owner.ts> --mode timing --iterations 6000
 * Repeat with --mode allocation; sampled allocation includes collected objects.
 * Timing and allocation passes are separate because sampling perturbs CPU time.
 */
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    "owner-file": { type: "string", default: "src/status/status-plugin-health.ts" },
    mode: { type: "string", default: "timing" },
    iterations: { type: "string", default: "6000" },
  },
});
const iterations = Number(values.iterations);
assert.ok(Number.isSafeInteger(iterations) && iterations > 0);
assert.ok(values.mode === "timing" || values.mode === "allocation");
// A saved base owner uses the same unchanged production dependency as the candidate.
registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === "../shared/dedupe-by-key.js"
      ? {
          url: new URL("../../src/shared/dedupe-by-key.ts", import.meta.url).href,
          shortCircuit: true,
        }
      : nextResolve(specifier, context);
  },
});
const { formatDetailedPluginHealth } = await import(pathToFileURL(resolve(values["owner-file"])));
const id = (index) => `plugin-${String(index).padStart(2, "0")}`;
const snapshot = {
  plugins: Array.from({ length: 40 }, (_, offset) => {
    const index = 39 - offset;
    return {
      id: id(index),
      status: index < 10 || index >= 30 ? "loaded" : index < 20 ? "disabled" : "error",
      ...(index >= 10 && index < 20 ? { error: `reason-${index % 2}` } : {}),
      ...(index >= 30
        ? {
            dependencyStatus: { hasDependencies: true, requiredInstalled: false, missing: ["pkg"] },
          }
        : {}),
    };
  }),
  runtimeLoadedPluginIds: [id(3), id(1)],
  shouldRunPluginIds: [id(2), id(0), id(15), id(25)],
  diagnostics: [],
  contextEngineQuarantines: [],
};
const original = structuredClone(snapshot);
const expected = [
  "⚠️ Plugins: 10 plugin errors · 10 dependency issues",
  "Loaded: 2 (plugin-01, plugin-03)",
  "Disabled: 10",
  "- reason-0: 5 (plugin-10, plugin-12, plugin-14, plugin-16, plugin-18)",
  "- reason-1: 5 (plugin-11, plugin-13, plugin-15, plugin-17, plugin-19)",
  "Installed (not active): 16 (plugin-04, plugin-05, plugin-06, plugin-07, plugin-08, plugin-09, plugin-30, plugin-31, +8 more)",
  "Configured to run but not loaded: 2 (plugin-00, plugin-02)",
  "Errors: 10",
  ...Array.from({ length: 8 }, (_, index) => `- plugin-${20 + index}: failed to load`),
  "Dependency issues: 10",
  ...Array.from({ length: 8 }, (_, index) => `- plugin-${30 + index}: missing pkg`),
  "Full inventory: /plugins list",
].join("\n");
assert.equal(formatDetailedPluginHealth(snapshot), expected);
assert.deepEqual(snapshot, original);
for (let index = 0; index < 500; index++) {
  formatDetailedPluginHealth(snapshot);
}
globalThis.gc?.();
const inspector = new Session();
if (values.mode === "allocation") {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 32768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const hostLoadBefore = loadavg();
const cpuBefore = process.cpuUsage();
const started = performance.now();
let checksum = 0;
for (let index = 0; index < iterations; index++) {
  checksum += formatDetailedPluginHealth(snapshot).length;
}
const elapsedMs = performance.now() - started;
const cpu = process.cpuUsage(cpuBefore);
let samples;
if (values.mode === "allocation") {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  samples = profile.samples;
  inspector.disconnect();
}
assert.equal(checksum, expected.length * iterations);
assert.deepEqual(snapshot, original);
console.log(
  JSON.stringify({
    ownerFile: values["owner-file"],
    mode: values.mode,
    iterations,
    checksum,
    cpuUsPerOp: (cpu.user + cpu.system) / iterations,
    elapsedMs,
    sampledAllocationBytesPerOp:
      samples?.reduce((sum, sample) => sum + sample.size, 0) / iterations,
    allocationSamples: samples?.length,
    samplingInterval: samples ? 32768 : undefined,
    hostLoadBefore,
    hostLoadAfter: loadavg(),
    memory: process.memoryUsage(),
  }),
);
