/**
 * Measure Tool Search's detached result snapshot, including JSON conversion and freeze.
 * Copy this script unchanged to both revisions and alternate base/candidate order:
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/tool-search-snapshot-measure.ts timing table 2000
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/tool-search-snapshot-measure.ts allocation table 2000
 * Workloads: table (1,000 Code Mode rows), files (400 file descriptions), large
 * (416 KiB stdout), small (two paths). Run timing separately from sampled allocation,
 * which includes collected objects. These are owner costs, not Gateway throughput.
 */
import assert from "node:assert/strict";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { snapshotToolSearchTargetTranscriptResult } from "../../src/agents/tool-search-transcript.js";
import { jsonResult } from "../../src/agents/tools/tool-results.js";

const [mode = "timing", workload = "table", count = "2000"] = process.argv.slice(2);
const iterations = Number(count);
assert(mode === "timing" || mode === "allocation");
assert(Number.isSafeInteger(iterations) && iterations > 0);
const fixtures = {
  table: {
    rows: Array.from({ length: 1000 }, (_, i) => [
      i,
      `src/synthetic/file-${i}.ts`,
      1234,
      "file",
      "2026-01-01",
    ]),
  },
  files: {
    files: Array.from({ length: 400 }, (_, i) => ({
      path: `src/synthetic/file-${i}.ts`,
      bytes: 1234,
      preview: "synthetic result text ".repeat(12),
    })),
  },
  large: { stdout: "synthetic code mode output\n".repeat(16000), code: 0 },
  small: { ok: true, files: ["src/a.ts", "src/b.ts"] },
};
assert(
  workload === "table" || workload === "files" || workload === "large" || workload === "small",
);
const result = jsonResult(fixtures[workload]);
const serialized = JSON.stringify(result);
const proof = snapshotToolSearchTargetTranscriptResult(result);
assert.equal(JSON.stringify(proof), serialized);
assert.notEqual(proof.details, result.details);
assert(Object.isFrozen(proof.details));
for (let i = 0; i < 100; i++) {
  snapshotToolSearchTargetTranscriptResult(result);
}
global.gc?.();
const inspector = new Session();
if (mode === "allocation") {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 32768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const load = os.loadavg();
const cpuStart = process.threadCpuUsage();
const start = performance.now();
let checksum = 0;
for (let i = 0; i < iterations; i++) {
  checksum += snapshotToolSearchTargetTranscriptResult(result).content.length;
}
const elapsedMs = performance.now() - start;
const cpu = process.threadCpuUsage(cpuStart);
let sampledBytes: number | undefined;
if (mode === "allocation") {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
    node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
  sampledBytes = sum(profile.head);
  inspector.disconnect();
}
assert.equal(checksum, iterations);
console.log(
  JSON.stringify({
    mode,
    workload,
    iterations,
    inputBytes: Buffer.byteLength(serialized),
    cpuUsPerResult: mode === "timing" ? (cpu.user + cpu.system) / iterations : undefined,
    elapsedMs: mode === "timing" ? elapsedMs : undefined,
    bytesPerResult: sampledBytes === undefined ? undefined : sampledBytes / iterations,
    load,
    memory: process.memoryUsage(),
  }),
);
