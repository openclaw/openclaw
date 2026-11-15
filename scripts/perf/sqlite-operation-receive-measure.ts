// Owner-only receipt delivery screen; no native SQLite or Gateway claims.
// node --import ./scripts/tsx.mjs scripts/perf/sqlite-operation-receive-measure.ts [timing|allocation]
// Run the same script on base and candidate, alternating launch order. Allocation
// sampling includes collected objects; use separate untraced runs for timing/GC.
import assert from "node:assert/strict";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { performance, PerformanceObserver } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import {
  createSqliteWorkerOperationAdmission,
  observeSqliteWorkerCommittedFacts,
} from "../../src/infra/sqlite-worker-operation-admission.ts";

const mode = process.argv[2] ?? "timing";
assert(mode === "timing" || mode === "allocation");
const count = 100_000;
const admission = createSqliteWorkerOperationAdmission(() => {
  throw new Error("A commit receipt must not request new authority");
});
let sequence = 0;
let publications = 0;
observeSqliteWorkerCommittedFacts(admission, () => publications++);
function batch() {
  for (let i = 0; i < count; i++) {
    admission.port.postMessage(
      {
        kind: "native-commit",
        committed: { version: 1, sequence: ++sequence, facts: { revision: sequence } },
        payloadBytes: 20,
      },
      [],
    );
    admission.service();
  }
  assert.equal(publications, sequence);
  assert.equal(admission.failure, undefined);
  assert.deepEqual(admission.committed, { facts: { revision: sequence } });
}
function allocatedBytes(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((total, child) => total + allocatedBytes(child), 0);
}
const inspector = new Session();
const gcDurations: number[] = [];
const gc = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    gcDurations.push(entry.duration);
  }
});
try {
  batch();
  await setImmediate();
  if (mode === "allocation") {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  gc.observe({ entryTypes: ["gc"] });
  const results = [];
  for (let repeat = 0; repeat < 5; repeat++) {
    const cpu = process.threadCpuUsage();
    const at = performance.now();
    batch();
    const after = process.threadCpuUsage(cpu);
    results.push({ wallMs: performance.now() - at, cpuMs: (after.user + after.system) / 1000 });
    await setImmediate();
  }
  const profile =
    mode === "allocation" ? await inspector.post("HeapProfiler.stopSampling") : undefined;
  console.log(
    JSON.stringify({
      mode,
      operations: count * results.length,
      publications,
      results,
      gcMs: gcDurations.reduce((total, duration) => total + duration, 0),
      gcCount: gcDurations.length,
      sampledAllocatedBytes: profile ? allocatedBytes(profile.profile.head) : undefined,
      memory: process.memoryUsage(),
    }),
  );
} finally {
  inspector.disconnect();
  gc.disconnect();
  admission.finish();
}
