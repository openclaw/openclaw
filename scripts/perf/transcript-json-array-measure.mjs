/**
 * Transcript normalization CPU/allocation, with 64-row synthetic tool-result arrays.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/transcript-json-array-measure.mjs \
 *   --owner ./src/config/sessions/transcript-json.ts --mode timing --iterations 3000
 * Save the baseline owner with git show; alternate base/candidate then candidate/base
 * for five pairs, separately in timing and allocation modes. Setup and byte checks
 * are excluded. Acceptance: identical bytes/ownership, less allocation, no material
 * untraced CPU increase. This measures first admission and retained-payload reuse,
 * not Gateway latency. Sampling includes collected objects; report host load.
 */
import assert from "node:assert/strict";
import { hash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { GCProfiler } from "node:v8";

const { values } = parseArgs({
  options: {
    owner: { type: "string", default: "./src/config/sessions/transcript-json.ts" },
    mode: { type: "string", default: "timing" },
    iterations: { type: "string", default: "3000" },
  },
});
const count = Number(values.iterations);
assert(Number.isSafeInteger(count) && count > 0);
assert(values.mode === "timing" || values.mode === "allocation");
assert(global.gc, "Run with --expose-gc");
const owner = path.resolve(values.owner);
const { normalizeTranscriptJsonValue: normalize } = await import(pathToFileURL(owner));
function fixture() {
  return {
    message: {
      role: "toolResult",
      toolName: "list",
      toolCallId: "synthetic",
      content: [{ type: "text", text: "Synthetic rows 🦞\ud800" }],
      details: {
        rows: Array.from({ length: 64 }, (_, index) => ({
          id: `row-${index}`,
          labels: ["synthetic", "completed"],
          values: [index, null, true],
        })),
      },
    },
  };
}
const expected = JSON.stringify(fixture());
for (let index = 0; index < 200; index++) {
  normalize(fixture(), "");
}
const retained = fixture();
normalize(retained, "");
for (const workload of ["fresh", "retained"]) {
  const fixtures = Array.from({ length: count }, () =>
    workload === "fresh" ? fixture() : retained,
  );
  global.gc();
  const inspector = values.mode === "allocation" ? new Session() : undefined;
  if (inspector) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const profiler = new GCProfiler();
  profiler.start();
  const hostLoadBefore = loadavg();
  const before = process.memoryUsage();
  const cpu = process.threadCpuUsage();
  const start = performance.now();
  for (const input of fixtures) {
    normalize(input, "");
  }
  const elapsedMs = performance.now() - start;
  const used = process.threadCpuUsage(cpu);
  const gc = profiler.stop();
  const after = process.memoryUsage();
  const hostLoadAfter = loadavg();
  let sampledBytes;
  if (inspector) {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    sampledBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
    inspector.disconnect();
  }
  for (const input of fixtures) {
    assert.equal(JSON.stringify(input), expected);
    assert.equal(normalize(input.message, ""), input.message);
    assert(Object.isFrozen(input.message.details.rows[0].labels));
  }
  console.log(
    JSON.stringify({
      owner,
      sourceDigest: hash("sha256", readFileSync(owner)),
      payloadDigest: hash("sha256", expected),
      mode: values.mode,
      workload,
      count,
      cpuUsPerOperation: (used.user + used.system) / count,
      elapsedMs,
      allocatedBytesPerOperation: sampledBytes === undefined ? undefined : sampledBytes / count,
      gc,
      memory: { before, after },
      hostLoadBefore,
      hostLoadAfter,
      node: process.version,
    }),
  );
}
