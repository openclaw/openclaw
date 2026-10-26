/**
 * Real retained-native-worker control transport, including the supervisor relay.
 * Run unchanged on both revisions, alternating launches:
 * node --import ./scripts/tsx.mjs scripts/perf/native-control-port-measure.ts timing
 * node --import ./scripts/tsx.mjs scripts/perf/native-control-port-measure.ts allocation
 * Five 5k-message passes after warmup; heap sampling includes collected objects
 * and is separate from untraced main-thread CPU/GC timing. This measures the
 * control owner, not whole-Gateway performance or the direct task-port path.
 */
import assert from "node:assert/strict";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import {
  closeDefaultRetainedNativeWorkerSource,
  createRetainedNativeWorker,
} from "../../src/infra/worker-native-lifecycle.ts";

const mode = process.argv[2] ?? "timing";
assert(mode === "timing" || mode === "allocation");
const iterations = 5_000;
const worker = createRetainedNativeWorker(
  'const {parentPort}=require("node:worker_threads"); parentPort.on("message", value => parentPort.postMessage(value));',
  { eval: true },
);
let received = 0;
let target = 0;
let complete: (() => void) | undefined;
let fail: ((error: Error) => void) | undefined;
worker.on("error", (error) => fail?.(error));
worker.on("message", (message) => {
  assert.equal(message, received++);
  if (received === target) {
    complete?.();
  }
});
async function batch() {
  const from = received;
  target = from + iterations;
  const done = new Promise<void>((resolve, reject) => {
    complete = resolve;
    fail = reject;
  });
  for (let index = from; index < target; index++) {
    worker.postMessage(index, []);
  }
  await done;
  complete = undefined;
  fail = undefined;
}
function allocated(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((total, child) => total + allocated(child), 0);
}
const inspector = new Session();
const pauses: number[] = [];
const observer = new PerformanceObserver((entries) => {
  for (const entry of entries.getEntries()) {
    pauses.push(entry.duration);
  }
});
try {
  if (!worker.started) {
    await new Promise<void>((resolve, reject) => {
      fail = reject;
      worker.on("started", resolve);
    });
  }
  for (let warmup = 0; warmup < 3; warmup++) {
    await batch();
  }
  await setImmediate();
  if (mode === "allocation") {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  observer.observe({ entryTypes: ["gc"] });
  const runs = [];
  for (let pass = 0; pass < 5; pass++) {
    const cpu = process.threadCpuUsage();
    const started = performance.now();
    await batch();
    const used = process.threadCpuUsage(cpu);
    runs.push({
      iterations,
      elapsedMs: performance.now() - started,
      cpuMs: (used.user + used.system) / 1000,
    });
    await setImmediate();
  }
  const profile =
    mode === "allocation" ? await inspector.post("HeapProfiler.stopSampling") : undefined;
  console.log(
    JSON.stringify({
      mode,
      runs,
      iterations: iterations * runs.length,
      sampledAllocatedBytes: profile ? allocated(profile.profile.head) : undefined,
      gc: {
        count: pauses.length,
        totalMs: pauses.reduce((sum, value) => sum + value, 0),
        maxMs: Math.max(0, ...pauses),
      },
      hostLoad: loadavg(),
      memory: process.memoryUsage(),
    }),
  );
} finally {
  observer.disconnect();
  inspector.disconnect();
  await worker.terminate();
  await closeDefaultRetainedNativeWorkerSource();
}
