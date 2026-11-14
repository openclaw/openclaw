/**
 * Run on each revision with node --import ./scripts/tsx.mjs
 * scripts/perf/model-stream-scheduler-measure.ts --streams 8 --events 2000.
 * Add --allocations for a separate sampled-allocation pass; its GC/CPU is diagnostic.
 * Eight concurrent provider iterators exercise readiness and the shared event budget.
 * No model service is contacted. Use --events 20000 for the counterbalanced
 * timing and allocation comparisons.
 */
import assert from "node:assert/strict";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { loadavg } from "node:os";
import { performance, PerformanceObserver } from "node:perf_hooks";
import { setImmediate, setTimeout } from "node:timers/promises";
import { parseArgs } from "node:util";
import {
  iterateModelStream,
  withProviderResponseHook,
} from "../../packages/ai/src/transports/transport-stream-shared.js";

const { values } = parseArgs({
  options: {
    streams: { type: "string", default: "8" },
    events: { type: "string", default: "2000" },
    allocations: { type: "boolean", default: false },
  },
});
const streams = Number(values.streams);
const events = Number(values.events);
assert(Number.isSafeInteger(streams) && streams > 0);
assert(Number.isSafeInteger(events) && events > 0);
async function consume(count: number) {
  let received = 0;
  await Promise.all(
    Array.from({ length: streams }, async () => {
      const controller = new AbortController();
      const source = withProviderResponseHook({
        stream: (async function* () {
          for (let index = 0; index < count; index++) {
            yield { type: "text_delta", delta: "Synthetic streamed text.", index };
          }
        })(),
        signal: controller.signal,
        abort: (error) => controller.abort(error),
      });
      let expected = 0;
      for await (const event of iterateModelStream(source, controller.signal)) {
        assert.equal(event.index, expected++);
        received++;
      }
    }),
  );
  assert.equal(received, streams * count);
}
await consume(100);
await setTimeout(2);
const gc: Array<{ start: number; duration: number; kind: unknown }> = [];
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    const detail = "detail" in entry ? entry.detail : undefined;
    const kind = detail && typeof detail === "object" && "kind" in detail ? detail.kind : null;
    gc.push({ start: entry.startTime, duration: entry.duration, kind });
  }
});
observer.observe({ entryTypes: ["gc"] });
const inspector = values.allocations ? new Session() : undefined;
if (inspector) {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 4096,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const before = process.memoryUsage();
const cpu = process.threadCpuUsage();
const start = performance.now();
await consume(events);
const end = performance.now();
const usedCpu = process.threadCpuUsage(cpu);
const after = process.memoryUsage();
await setImmediate();
await setImmediate();
observer.disconnect();
let sampledBytes: number | undefined;
if (inspector) {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  const total = (node: HeapProfiler.SamplingHeapProfileNode): number =>
    node.selfSize + node.children.reduce((sum, child) => sum + total(child), 0);
  sampledBytes = total(profile.head);
  inspector.disconnect();
}
const collections = gc.filter((entry) => entry.start >= start && entry.start < end);
console.log(
  JSON.stringify({
    streams,
    events,
    delivered: streams * events,
    mode: values.allocations ? "allocation" : "timing",
    node: process.version,
    hostLoad: loadavg(),
    wallMs: end - start,
    mainThreadCpuMs: (usedCpu.user + usedCpu.system) / 1000,
    sampledBytes,
    allocatedBytesPerEvent:
      sampledBytes === undefined ? undefined : sampledBytes / (streams * events),
    gcMs: collections.reduce((sum, entry) => sum + entry.duration, 0),
    gcCount: collections.length,
    gcMaxMs: Math.max(0, ...collections.map((entry) => entry.duration)),
    gcSamples: collections,
    before,
    after,
  }),
);
