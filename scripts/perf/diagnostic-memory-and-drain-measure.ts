// node --import ./scripts/tsx.mjs scripts/perf/diagnostic-memory-and-drain-measure.ts [counts]
// Compare five fresh-process runs per revision, interleaved, plus base/base controls.
// Require unchanged delivery/counter values and lower allocation and CPU with no wall p95 regression.
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { loadavg } from "node:os";
import v8, { getHeapStatistics } from "node:v8";
import { MessageChannel } from "node:worker_threads";
import { onTrustedInternalDiagnosticEvent } from "../../src/infra/diagnostic-events.js";
import { GatewayScheduler } from "../../src/infra/gateway-scheduler.js";
import { recordSessionRowSelection } from "../../src/infra/gateway-work-metrics.js";
import { receiveWorkerMemoryPort, trackNativeWorkerForCpu } from "../../src/infra/worker-cpu.js";
import { recordWorkerMessage } from "../../src/infra/worker-message-metrics.js";
import { emitDiagnosticMemorySample } from "../../src/logging/diagnostic-memory.js";
import { setLoggerOverride } from "../../src/logging/logger.js";
import { getAsyncWorkSignal, trackAsyncWork } from "../../src/shared/async-work-scope.js";

const counts = process.argv[2] === "counts";
const memoryUsage = {
  rss: 4 * 1024 ** 3,
  heapTotal: 1024 ** 3,
  heapUsed: 512 * 1024 ** 2,
  external: 256 * 1024 ** 2,
  arrayBuffers: 128 * 1024 ** 2,
};
const ports: MessageChannel[] = [];
setLoggerOverride({ level: "silent", consoleLevel: "silent" });
// Hold native sampling cost constant. The sampler still gets fresh rows just as it
// does from V8, and runs the real publication and dispatcher paths.
const heapSpaces = v8.getHeapSpaceStatistics();
v8.getHeapSpaceStatistics = () => heapSpaces.map((space) => ({ ...space }));
syncBuiltinESMExports();

// Populate the real metrics owners with synthetic direct-isolate telemetry and
// session counters. Neither measured path reads the session DB or workspace.
for (let threadId = 1; threadId <= 8; threadId++) {
  const worker = Object.assign(new EventEmitter(), {
    threadId,
    cpuUsage: async () => ({ user: 0, system: 0 }),
    getHeapStatistics: async () => getHeapStatistics(),
  });
  trackNativeWorkerForCpu(
    worker,
    threadId <= 4 ? "sqlite-store.worker.js" : "code-mode-node.worker.js",
  );
  const channel = new MessageChannel();
  ports.push(channel);
  receiveWorkerMemoryPort(worker, { status: "memory", port: channel.port1 });
  const delivered = once(channel.port1, "message");
  channel.port1.ref();
  channel.port2.postMessage({
    ...memoryUsage,
    heapSpaces,
    retainedData: [{ structure: "catalog-source", entries: 500, approximateBytes: 100_000 }],
  });
  await delivered;
}
for (const task of ["sessions.catalog.list", "sessions.resolve", "status", "health"]) {
  recordSessionRowSelection("broad", 6_000, `gateway:rpc:${task}`);
  recordWorkerMessage("sqlite_reply", "from_worker", 35 * 1024 ** 3, task);
}

let clones = 0;
let stacks = 0;
const clone = globalThis.structuredClone;
const prepare = Error.prepareStackTrace?.bind(Error);
if (counts) {
  globalThis.structuredClone = (value, options) => {
    if (
      value &&
      typeof value === "object" &&
      "type" in value &&
      value.type === "diagnostic.memory.sample"
    ) {
      clones++;
    }
    return clone(value, options);
  };
  Error.prepareStackTrace = (error, frames) => {
    if (error.name === "AbortError") {
      stacks++;
    }
    return prepare?.(error, frames) ?? error.toString();
  };
}

async function measure(name: string, units: number, run: () => number | Promise<number>) {
  clones = 0;
  stacks = 0;
  const load = loadavg();
  const allocated = getHeapStatistics().total_allocated_bytes;
  assert(Number.isFinite(allocated), "Use Node with V8 total allocation counters");
  const cpu = process.threadCpuUsage();
  const start = performance.now();
  const delivered = await run();
  const ms = performance.now() - start;
  const { user, system } = process.threadCpuUsage(cpu);
  const bytes = getHeapStatistics().total_allocated_bytes - allocated;
  console.log(
    JSON.stringify({
      name,
      units,
      delivered,
      counts,
      clones,
      stacks,
      load,
      wallUs: (ms * 1000) / units,
      cpuUs: (user + system) / units,
      bytes: bytes / units,
    }),
  );
}

let deliveries = 0;
const sample = () => emitDiagnosticMemorySample({ memoryUsage, heapSizeLimitBytes: 4 * 1024 ** 3 });
for (const listeners of [1, 2, 4]) {
  const stop = Array.from({ length: listeners }, () =>
    onTrustedInternalDiagnosticEvent(
      (event) => {
        if (
          event.type === "diagnostic.memory.sample" &&
          event.memory.workerHeaps?.length === 8 &&
          event.memory.heapUsedBytes === memoryUsage.heapUsed
        ) {
          deliveries++;
        }
      },
      { include: ["diagnostic.memory.sample"] },
      { includePrivateData: false },
    ),
  );
  for (let i = 0; i < 2_000; i++) {
    sample();
  }
  deliveries = 0;
  const samples = counts ? 1_000 : 20_000;
  await measure(`memory/${listeners}`, samples, () => {
    for (let i = 0; i < samples; i++) {
      sample();
    }
    assert.equal(deliveries, samples * listeners);
    return deliveries;
  });
  stop.forEach((unsubscribe) => unsubscribe());
}
for (const channel of ports) {
  channel.port1.close();
  channel.port2.close();
}

let wake: (() => void | Promise<void>) | undefined;
const scheduler = new GatewayScheduler({
  clock: {
    now: () => 0,
    monotonicNow: () => 0,
    arm: (run) => {
      wake = run;
      return () => {
        wake = undefined;
      };
    },
  },
});
for (const captureSignal of [false, true]) {
  const run = async (items: number) => {
    let completed = 0;
    const runJob = async () => {
      if (captureSignal) {
        getAsyncWorkSignal();
      }
      await trackAsyncWork(async () => {
        completed++;
      });
    };
    for (let i = 0; i < items; i++) {
      scheduler.schedule({ id: "fixture", delayMs: 0, run: runJob });
      await wake?.();
    }
    assert.equal(completed, items);
    return completed;
  };
  await run(2_000);
  const items = counts ? 1_000 : 30_000;
  await measure(captureSignal ? "drain/signal" : "drain/unobserved", items, () => run(items));
}
await scheduler.stop();
