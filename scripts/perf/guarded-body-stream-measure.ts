/**
 * Guarded response-body owner benchmark: 10 MiB in 640 preallocated 16 KiB chunks per stream.
 * Run from each revision with Node and the repo loader:
 *   node --import ./scripts/tsx.mjs scripts/perf/guarded-body-stream-measure.ts cpu
 *   node --import ./scripts/tsx.mjs scripts/perf/guarded-body-stream-measure.ts allocation
 *   node --import ./scripts/tsx.mjs scripts/perf/guarded-body-stream-measure.ts promises
 * Optional second argument: owner module URL (for isolated compiled source comparisons).
 * Optional third argument: measured stream count (default 2,000; promise mode 10).
 * CPU runs are untraced; allocation sampling and promise counts are separate passes.
 * Compare at least five counterbalanced base/candidate runs, with identical Node versions.
 */
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import { promiseHooks } from "node:v8";
import type { wrapGuardedBodyStream as Wrap } from "../../src/infra/net/guarded-body-stream.js";

const mode = process.argv[2] ?? "cpu";
assert(["cpu", "allocation", "promises"].includes(mode));
const { wrapGuardedBodyStream }: { wrapGuardedBodyStream: typeof Wrap } = await import(
  process.argv[3] ?? "../../src/infra/net/guarded-body-stream.js"
);
const chunksPerStream = 640;
const streams = Number(process.argv[4] ?? (mode === "promises" ? 10 : 2_000));
assert(Number.isSafeInteger(streams) && streams > 0);
const chunk = new Uint8Array(16 * 1024).fill(42);

async function run(count: number) {
  let received = 0;
  let refreshed = 0;
  let released = 0;
  for (let stream = 0; stream < count; stream++) {
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ < chunksPerStream) {
          controller.enqueue(chunk);
        } else {
          controller.close();
        }
      },
    });
    const reader = wrapGuardedBodyStream({
      body,
      refreshTimeout() {
        refreshed++;
      },
      cleanup() {
        released++;
      },
    }).getReader();
    for (;;) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      assert.equal(next.value, chunk);
      received++;
    }
    reader.releaseLock();
  }
  await setImmediate();
  assert.equal(received, count * chunksPerStream);
  assert.equal(refreshed, received);
  assert.equal(released, count);
}

await run(100);
const inspector = new Session();
let promises = 0;
if (mode === "allocation") {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 32_768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const stopCounting =
  mode === "promises" ? promiseHooks.createHook({ init: () => promises++ }) : undefined;
let gcMs = 0;
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    gcMs += entry.duration;
  }
});
observer.observe({ entryTypes: ["gc"] });
const hostLoad = loadavg();
const cpu = process.cpuUsage();
const started = performance.now();
await run(streams);
const wallMs = performance.now() - started;
const usedCpu = process.cpuUsage(cpu);
stopCounting?.();
await setImmediate();
observer.disconnect();
let allocatedBytes: number | undefined;
if (mode === "allocation") {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  allocatedBytes = profile.samples.reduce((total, sample) => total + sample.size, 0);
  inspector.disconnect();
}
console.log(
  JSON.stringify({
    mode,
    streams,
    chunksPerStream,
    cpuMs: (usedCpu.user + usedCpu.system) / 1_000,
    wallMs,
    allocatedBytes,
    promises: mode === "promises" ? promises : undefined,
    gcMs,
    hostLoad,
    memory: process.memoryUsage(),
  }),
);
