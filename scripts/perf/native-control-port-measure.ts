/**
 * Real retained-native-worker control transport, including the supervisor relay.
 * Run unchanged on both revisions, alternating launches:
 * node --import ./scripts/tsx.mjs scripts/perf/native-control-port-measure.ts timing
 * node --import ./scripts/tsx.mjs scripts/perf/native-control-port-measure.ts allocation
 * Add `direct` after the mode for the retained worker's direct task port, cycling
 * 4 KiB command buffers through eight synthetic session actors without copying.
 * Add `references` instead for 42 real retained workers: each pass performs 5k
 * ref/unref cycles, then echoes through each worker as an ordered control barrier.
 * Message deltas include those 42 barrier requests/replies; startup is excluded.
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
import { getWorkerMessageMetrics } from "../../src/infra/worker-message-metrics.ts";
import {
  closeDefaultRetainedNativeWorkerSource,
  createRetainedNativeWorker,
} from "../../src/infra/worker-native-lifecycle.ts";

const mode = process.argv[2] ?? "timing";
assert(mode === "timing" || mode === "allocation");
const direct = process.argv[3] === "direct";
const references = process.argv[3] === "references";
const iterations = 5_000;
const ports = direct ? new MessageChannel() : undefined;
const buffers: Uint8Array[] = direct
  ? Array.from({ length: iterations }, () => new Uint8Array(4096))
  : [];
const createWorker = () =>
  createRetainedNativeWorker(
    `const {parentPort}=require("node:worker_threads");
  parentPort.on("message", value => {
    if (value?.type === "openclaw.worker-task-port") {
      const port = value.port;
      port.on("message", value => port.postMessage(value, [value.input.buffer]));
    } else {
      parentPort.postMessage(value);
    }
  });`,
    { eval: true, execArgv: [] },
    undefined,
    undefined,
    ports ? { host: ports.port1, worker: ports.port2 } : undefined,
  );
const workers = Array.from({ length: references ? 42 : 1 }, createWorker);
const worker = workers[0]!;
// The fixture must await its barrier even when every measured handle is idle.
const fixtureReference = references ? setInterval(() => {}, 60_000) : undefined;
const ready = workers.map((entry) =>
  entry.started
    ? Promise.resolve()
    : new Promise<void>((resolve, reject) => {
        entry.on("started", resolve);
        entry.on("error", reject);
      }),
);
let received = 0;
let target = 0;
let referencePass = 0;
let complete: (() => void) | undefined;
let fail: ((error: Error) => void) | undefined;
for (const entry of workers) {
  entry.on("error", (error) => fail?.(error));
  entry.on("message", (message) => {
    if (references) {
      assert.equal(message, referencePass);
    } else if (direct) {
      assert(message !== null && typeof message === "object");
      assert("id" in message && "actor" in message && "input" in message);
      assert(message.input instanceof Uint8Array);
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
}
async function referenceBatch() {
  for (let index = 0; index < iterations; index++) {
    const entry = workers[index % workers.length]!;
    entry.ref();
    entry.unref();
  }
  // Post shares the supervisor FIFO with reference commands. Receiving all
  // echoes proves the base processed its messages before the pass ends.
  referencePass++;
  target = received + workers.length;
  const done = new Promise<void>((resolve, reject) => {
    complete = resolve;
    fail = reject;
  });
  for (const entry of workers) {
    entry.postMessage(referencePass, []);
  }
  await done;
  complete = undefined;
  fail = undefined;
}
async function batch() {
  if (references) {
    return referenceBatch();
  }
  const from = received;
  target = from + iterations;
  const done = new Promise<void>((resolve, reject) => {
    complete = resolve;
    fail = reject;
  });
  for (let index = from; index < target; index++) {
    if (direct) {
      const input = buffers[index % iterations]!;
      const buffer = input.buffer;
      assert(buffer instanceof ArrayBuffer);
      worker.postMessage({ type: "execute", id: index, actor: index % 8, input }, [buffer]);
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
  await Promise.all(ready);
  if (references) {
    workers.forEach((entry) => entry.unref());
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
  const beforeMessages = getWorkerMessageMetrics();
  const runs = [];
  for (let pass = 0; pass < 5; pass++) {
    const cpu = process.threadCpuUsage();
    const processCpu = process.cpuUsage();
    const started = performance.now();
    await batch();
    const used = process.threadCpuUsage(cpu);
    const processUsed = process.cpuUsage(processCpu);
    runs.push({
      iterations,
      elapsedMs: performance.now() - started,
      cpuMs: (used.user + used.system) / 1000,
      processCpuMs: (processUsed.user + processUsed.system) / 1000,
    });
    await setImmediate();
  }
  const profile =
    mode === "allocation" ? await inspector.post("HeapProfiler.stopSampling") : undefined;
  console.log(
    JSON.stringify({
      mode,
      transport: references ? "references" : direct ? "direct" : "control",
      workerCount: workers.length,
      inputBytes: direct ? 4096 : 0,
      runs,
      iterations: iterations * runs.length,
      messages: getWorkerMessageMetrics()
        .map((entry) => {
          const previous = beforeMessages.find(
            (before) => before.kind === entry.kind && before.direction === entry.direction,
          );
          return {
            kind: entry.kind,
            direction: entry.direction,
            messages: entry.messages - (previous?.messages ?? 0),
            payloadBytes: entry.payloadBytes - (previous?.payloadBytes ?? 0),
          };
        })
        .filter((entry) => entry.messages > 0),
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
  await Promise.all(workers.map((entry) => entry.terminate()));
  await closeDefaultRetainedNativeWorkerSource();
  clearInterval(fixtureReference);
}
