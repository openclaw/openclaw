/**
 * Measure 10,000 native admission finishes, excluding owner/channel construction.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/sqlite-operation-finish-measure.ts
 *   [--owner /path/to/owner.ts] [--mode timing|allocation] [--receipts]
 * Run five alternating base/candidate trials in each mode. Keep a baseline owner
 * beside its original imports. Synthetic receipts model committed job replies;
 * without --receipts this isolates empty pending-decision cleanup. No SQL or
 * Gateway load is claimed. Allocation includes collected objects; CPU is measured
 * only in timing mode, with fixture construction and explicit GC outside the arm.
 */
import assert from "node:assert/strict";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { loadavg } from "node:os";
import { setImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createSqliteWorkerOperationAdmission } from "../../src/infra/sqlite-worker-operation-admission.js";

const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    mode: { type: "string", default: "timing" },
    receipts: { type: "boolean", default: false },
  },
});
assert(values.mode === "timing" || values.mode === "allocation");
assert(globalThis.gc, "Run with --expose-gc");
const create: typeof createSqliteWorkerOperationAdmission = values.owner
  ? (await import(pathToFileURL(values.owner).href)).createSqliteWorkerOperationAdmission
  : createSqliteWorkerOperationAdmission;
const operations = 10_000;
const warmup = 1_000;
function prepare() {
  return create((_request, grant) => grant());
}
function queueReceipt(admission: ReturnType<typeof create>) {
  if (values.receipts) {
    admission.port.postMessage(
      {
        kind: "native-settlement",
        settlement: {
          kind: "completed",
          committed: { version: 1, sequence: 1, facts: { sessionKey: "synthetic", revision: 1 } },
        },
      },
      [],
    );
  }
}
for (let i = 0; i < warmup; i++) {
  const admission = prepare();
  queueReceipt(admission);
  admission.finish();
}
await setImmediate();
const admissions = Array.from({ length: operations }, prepare);
globalThis.gc();
const inspector = values.mode === "allocation" ? new Session() : undefined;
if (inspector) {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 128,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
// Queue after sampler setup so no awaited work can deliver receipts before finish.
for (const admission of admissions) {
  queueReceipt(admission);
}
const hostLoad = loadavg();
const cpu = process.threadCpuUsage();
const started = performance.now();
for (const admission of admissions) {
  admission.finish();
}
const elapsedMs = performance.now() - started;
const usage = process.threadCpuUsage(cpu);
const profile = inspector ? await inspector.post("HeapProfiler.stopSampling") : undefined;
inspector?.disconnect();
function allocated(node: HeapProfiler.SamplingHeapProfileNode, withinFinish = false): number {
  const included = withinFinish || node.callFrame.functionName === "finish";
  return (
    (included ? node.selfSize : 0) +
    node.children.reduce((total, child) => total + allocated(child, included), 0)
  );
}
for (const admission of admissions) {
  assert.equal(admission.failure, undefined);
  if (values.receipts) {
    assert.deepEqual(admission.settlement, {
      kind: "completed",
      committed: { facts: { sessionKey: "synthetic", revision: 1 } },
    });
  }
}
console.log(
  JSON.stringify({
    owner: values.owner ?? "candidate",
    mode: values.mode,
    receipts: values.receipts,
    operations,
    warmup,
    elapsedMs,
    cpuMs: values.mode === "timing" ? (usage.user + usage.system) / 1000 : undefined,
    finishAllocatedBytes: profile ? allocated(profile.profile.head) : undefined,
    hostLoad,
    memory: process.memoryUsage(),
  }),
);
await setImmediate();
