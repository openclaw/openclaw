/**
 * Real retained-native-worker control transport, including the supervisor relay.
 * Run unchanged on both revisions, alternating launches:
 * node --import ./scripts/tsx.mjs scripts/perf/native-control-port-measure.ts timing
 * node --import ./scripts/tsx.mjs scripts/perf/native-control-port-measure.ts allocation
 * Add `direct` after the mode for the retained worker's direct task port, cycling
 * 4 KiB command buffers through eight synthetic session actors without copying.
 * Five 5k-message passes after warmup; heap sampling includes collected objects
 * and is separate from untraced main-thread CPU/GC timing. This measures the
 * transport owner, not whole-Gateway performance.
 */
import assert from "node:assert/strict";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import { MessageChannel } from "node:worker_threads";
import {
  closeDefaultRetainedNativeWorkerSource,
  createRetainedNativeWorker,
} from "../../src/infra/worker-native-lifecycle.ts";

const mode = process.argv[2] ?? "timing";
assert(mode === "timing" || mode === "allocation");
const direct = process.argv[3] === "direct";
const iterations = 5_000;
const ports = direct ? new MessageChannel() : undefined;
const buffers = direct ? Array.from({ length: iterations }, () => new Uint8Array(4096)) : [];
const worker = createRetainedNativeWorker(
  `const {parentPort}=require("node:worker_threads");
  parentPort.on("message", value => {
    if (value?.type === "openclaw.worker-task-port") {
      const port = value.port;
      port.on("message", value => port.postMessage(value, [value.input.buffer]));
    } else {
      parentPort.postMessage(value);
    }
  });`,
  { eval: true },
  undefined,
  undefined,
  ports ? { host: ports.port1, worker: ports.port2 } : undefined,
);
let received = 0;
let target = 0;
let complete: (() => void) | undefined;
let fail: ((error: Error) => void) | undefined;
worker.on("error", (error) => fail?.(error));
worker.on("message", (message) => {
  if (direct) {
    assert.equal(message.id, received);
    assert.equal(message.actor, received % 8);
    assert.equal(message.input.byteLength, 4096);
    buffers[received % iterations] = message.input;
  } else {
    assert.equal(message, received);
  }
  received++;
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
    if (direct) {
      const input = buffers[index % iterations]!;
      worker.postMessage({ type: "execute", id: index, actor: index % 8, input }, [input.buffer]);
    } else {
      worker.postMessage(index, []);
    }
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
      transport: direct ? "direct" : "control",
      inputBytes: direct ? 4096 : 0,
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
