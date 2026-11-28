/**
 * Measures the exact host CPU read/delta functions from an event-loop-health.ts
 * revision, including real os.cpus() costs. This is an owner microbenchmark,
 * not the scheduler, worker CPU sampler, or a whole-Gateway load measurement.
 *
 * node --expose-gc scripts/perf/host-cpu-sample-measure.mjs \
 *   --source <revision>/src/gateway/server/event-loop-health.ts --iterations 5000
 * Repeat with --allocations for a separate allocation pass. Run both revisions
 * in AB/BA order on the same host (128 logical CPUs matches the Team workload).
 * The retained snapshot batch amplifies the one-window metadata retention cost;
 * it runs outside timing/allocation capture. No production state is accessed.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { stripTypeScriptTypes } from "node:module";
import { loadavg } from "node:os";
import { parseArgs } from "node:util";
import { startCollectedHeapSampling } from "../lib/heap-sampling.ts";

const { values } = parseArgs({
  options: {
    source: { type: "string" },
    iterations: { type: "string", default: "5000" },
    allocations: { type: "boolean", default: false },
  },
});
assert(values.source, "--source is required");
assert(global.gc, "Run with --expose-gc for retained snapshot measurement");
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations >= 1000, "Use at least 1000 iterations");
const source = readFileSync(values.source, "utf8");
const start = source.search(/^(?:async )?function readHostCpuTimes\(/m);
const end = source.indexOf("function classifyGatewayEventLoopHealthReasons(", start);
const hostConstants = [...source.matchAll(/^const HOST_CPU_.*;$/gm)]
  .map((match) => match[0])
  .join("\n");
assert(start >= 0 && end > start && hostConstants, "Host CPU owner functions were not found");
const metricSource = readFileSync(
  new URL("../../src/logging/diagnostic-metric.ts", import.meta.url),
  "utf8",
).replace("export function roundDiagnosticMetric", "function roundMetric");
const code = stripTypeScriptTypes(`${metricSource}\n${hostConstants}\n${source.slice(start, end)}`);
// Only the named production functions are extracted; no rewritten algorithm or
// test-only production export substitutes for the source under measurement.
const ownerModule = `import { cpus } from "node:os";\nimport { openSync, readSync, closeSync, readFileSync } from "node:fs";\nimport { open, readFile } from "node:fs/promises";\n${code}\nconst buffer = typeof HOST_CPU_STAT_BUFFER_BYTES === "number" ? Buffer.alloc(HOST_CPU_STAT_BUFFER_BYTES) : undefined;\nexport { readHostCpuTimes, hostCpuUtilization, buffer };`;
const { readHostCpuTimes, hostCpuUtilization, buffer } = await import(
  `data:text/javascript;base64,${Buffer.from(ownerModule).toString("base64")}`
);
const count = (snapshot) => snapshot?.count ?? snapshot?.length;
let previous = await readHostCpuTimes(buffer);
assert(count(previous), "Native host CPU counters unavailable");
const cpuCount = count(previous);
let checksum = 0;
const sample = async () => {
  const current = await readHostCpuTimes(buffer);
  assert.equal(count(current), cpuCount, "CPU topology changed during measurement");
  checksum += hostCpuUtilization(current, previous) ?? 0;
  previous = current;
};
for (let index = 0; index < 100; index++) {
  await sample();
}
const inspector = values.allocations ? new Session() : undefined;
let allocatedBytes;
try {
  const latencies = new Float64Array(iterations);
  const hostLoadBefore = loadavg();
  if (inspector) {
    await startCollectedHeapSampling(inspector, 4096);
  }
  const started = performance.now();
  const cpuStarted = process.cpuUsage();
  const threadStarted = process.threadCpuUsage();
  for (let index = 0; index < iterations; index++) {
    const began = performance.now();
    await sample();
    latencies[index] = performance.now() - began;
  }
  const elapsedMs = performance.now() - started;
  const used = process.cpuUsage(cpuStarted);
  const mainUsed = process.threadCpuUsage(threadStarted);
  if (inspector) {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    allocatedBytes = 0;
    const pending = [profile.head];
    for (const node of pending) {
      allocatedBytes += node.selfSize;
      pending.push(...node.children);
    }
  }
  const hostLoadAfter = loadavg();
  const sortedLatencies = latencies.toSorted();
  global.gc();
  const retainedBefore = process.memoryUsage().heapUsed;
  const snapshots = [];
  for (let index = 0; index < 256; index++) {
    snapshots.push(await readHostCpuTimes(buffer));
  }
  global.gc();
  const retainedBytesPerSnapshot =
    (process.memoryUsage().heapUsed - retainedBefore) / snapshots.length;
  assert.equal(count(snapshots.at(-1)), cpuCount);
  console.log(
    JSON.stringify({
      source: values.source,
      sourceSha256: createHash("sha256").update(source).digest("hex"),
      node: process.versions.node,
      cpuCount,
      iterations,
      allocations: values.allocations,
      cpuMs: (used.user + used.system) / 1000,
      mainCpuMs: (mainUsed.user + mainUsed.system) / 1000,
      medianMs: sortedLatencies[Math.floor(iterations / 2)],
      p95Ms: sortedLatencies[Math.ceil(iterations * 0.95) - 1],
      maxMs: sortedLatencies.at(-1),
      elapsedMs,
      allocatedBytes,
      allocatedBytesPerSample:
        allocatedBytes === undefined ? undefined : allocatedBytes / iterations,
      retainedBytesPerSnapshot,
      hostLoadBefore,
      hostLoadAfter,
      checksum,
    }),
  );
} finally {
  inspector?.disconnect();
}
