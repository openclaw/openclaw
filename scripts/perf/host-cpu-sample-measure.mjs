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
const start = source.indexOf("function readHostCpuTimes(");
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
const ownerModule = `import { cpus } from "node:os";\nimport { openSync, readSync, closeSync, readFileSync } from "node:fs";\n${code}\nexport { readHostCpuTimes, hostCpuUtilization };`;
const { readHostCpuTimes, hostCpuUtilization } = await import(
  `data:text/javascript;base64,${Buffer.from(ownerModule).toString("base64")}`
);
const count = (snapshot) => snapshot?.count ?? snapshot?.length;
let previous = readHostCpuTimes();
assert(count(previous), "Native host CPU counters unavailable");
const cpuCount = count(previous);
let checksum = 0;
const sample = () => {
  const current = readHostCpuTimes();
  assert.equal(count(current), cpuCount, "CPU topology changed during measurement");
  checksum += hostCpuUtilization(current, previous) ?? 0;
  previous = current;
};
for (let index = 0; index < 100; index++) {
  sample();
}
const inspector = values.allocations ? new Session() : undefined;
let allocatedBytes;
try {
  if (inspector) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const hostLoadBefore = loadavg();
  const started = performance.now();
  const cpuStarted = process.cpuUsage();
  for (let index = 0; index < iterations; index++) {
    sample();
  }
  const used = process.cpuUsage(cpuStarted);
  const elapsedMs = performance.now() - started;
  if (inspector) {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    allocatedBytes = 0;
    const pending = [profile.head];
    for (const node of pending) {
      allocatedBytes += node.selfSize;
      pending.push(...node.children);
    }
  }
  global.gc();
  const retainedBefore = process.memoryUsage().heapUsed;
  const snapshots = [];
  for (let index = 0; index < 256; index++) {
    snapshots.push(readHostCpuTimes());
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
      elapsedMs,
      allocatedBytes,
      allocatedBytesPerSample:
        allocatedBytes === undefined ? undefined : allocatedBytes / iterations,
      retainedBytesPerSnapshot,
      hostLoadBefore,
      hostLoadAfter: loadavg(),
      checksum,
    }),
  );
} finally {
  inspector?.disconnect();
}
