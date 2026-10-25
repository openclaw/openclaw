// Stream subscription scope workload (Node 26):
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/stream-dispatch-scope-measure.ts
// Use --allocations for a separate collected-object sampling pass, or --trace-gc-nvp
// on Node for a separate promotion pass; neither pass supplies timing gates.
// Compare >=5 alternating pairs, --events 240000, on identical Node and source snapshots.
// Models the observer's queued track() plus detached chat delivery under 24 ambient
// stores. 48 interleaved streams each emit 10 deltas per batch. This is owner proof,
// not a WebSocket/Gateway throughput benchmark. Output equality and settled drains
// are required; apply the campaign's absolute GC/tail materiality rules to timings.
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { monitorEventLoopDelay, PerformanceObserver } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { parseArgs } from "node:util";
import {
  AsyncWorkScope,
  getAsyncWorkSignal,
  runOutsideAsyncWorkScope,
} from "../../src/shared/async-work-scope.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    events: { type: "string", default: "240000" },
    allocations: { type: "boolean", default: false },
  },
});
const events = parseStrictIntegerOption({
  raw: values.events,
  label: "--events",
  min: 1,
  fallback: 1,
});
assert(global.gc, "Run with --expose-gc");
const stores = Array.from({ length: 24 }, () => new AsyncLocalStorage<number>());
const emitter = new AsyncWorkScope();
const observer = new AsyncWorkScope();
let tail = Promise.resolve();
const ready = Promise.resolve();
const observed = new Uint32Array(48);
const delivered = new Uint32Array(48);
const latencies: number[] = [];
const collections: { kind: number; duration: number }[] = [];
let measuring = false;
const gc = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    if ("detail" in entry) {
      const detail = entry.detail as { kind: number };
      collections.push({ kind: detail.kind, duration: entry.duration });
    }
  }
});
const loop = monitorEventLoopDelay({ resolution: 1 });
async function stream(count: number) {
  for (let offset = 0; offset < count; offset += 480) {
    for (let index = offset; index < Math.min(count, offset + 480); index++) {
      const session = index % 48;
      const result = observer.track(() => tail.then(() => observed[session]!++));
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      const started = performance.now();
      void runOutsideAsyncWorkScope(() =>
        ready.then(() => {
          assert.equal(getAsyncWorkSignal(), undefined);
          delivered[session]!++;
          if (measuring && !values.allocations) {
            latencies.push(performance.now() - started);
          }
        }),
      );
    }
    await tail;
    await nextTurn();
  }
}
function enter(index: number, run: () => Promise<void>): Promise<void> {
  return index === stores.length
    ? emitter.run(run)
    : stores[index]!.run(index, () => enter(index + 1, run));
}
function allocated(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((sum, child) => sum + allocated(child), 0);
}
const inspector = new Session();
try {
  await enter(0, () => stream(4800));
  global.gc();
  await nextTurn();
  observed.fill(0);
  delivered.fill(0);
  if (values.allocations) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 16384,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  gc.observe({ entryTypes: ["gc"] });
  loop.enable();
  measuring = true;
  if (process.execArgv.includes("--trace-gc-nvp")) {
    console.log("MEASURE_START");
  }
  const cpu = process.threadCpuUsage();
  const started = performance.now();
  await enter(0, () => stream(events));
  const elapsedMs = performance.now() - started;
  const used = process.threadCpuUsage(cpu);
  if (process.execArgv.includes("--trace-gc-nvp")) {
    console.log("MEASURE_END");
  }
  measuring = false;
  loop.disable();
  await nextTurn();
  gc.disconnect();
  const profile = values.allocations
    ? (await inspector.post("HeapProfiler.stopSampling")).profile
    : undefined;
  for (let session = 0; session < 48; session++) {
    const expected = Math.floor(events / 48) + (session < events % 48 ? 1 : 0);
    assert.equal(observed[session], expected);
    assert.equal(delivered[session], expected);
  }
  latencies.sort((left, right) => left - right);
  const byKind: Record<number, { count: number; totalMs: number; maxMs: number }> = {};
  for (const entry of collections) {
    const value = (byKind[entry.kind] ??= { count: 0, totalMs: 0, maxMs: 0 });
    value.count++;
    value.totalMs += entry.duration;
    value.maxMs = Math.max(value.maxMs, entry.duration);
  }
  const gcTails = Object.fromEntries(
    Object.entries(byKind).map(([kind, summary]) => {
      const durations = collections
        .filter((entry) => entry.kind === Number(kind))
        .map((entry) => entry.duration)
        .toSorted((a, b) => a - b);
      return [
        kind,
        {
          ...summary,
          p95Ms: durations[Math.floor(durations.length * 0.95)],
          p99Ms: durations[Math.floor(durations.length * 0.99)],
        },
      ];
    }),
  );
  console.log(
    JSON.stringify({
      node: process.version,
      events,
      deliveries: delivered.reduce((sum, count) => sum + count, 0),
      elapsedMs,
      cpuUsPerEvent: (used.user + used.system) / events,
      allocatedBytesPerEvent: profile ? allocated(profile.head) / events : undefined,
      allocationSamples: profile?.samples.length,
      gc: gcTails,
      gcMsPerEvent: collections.reduce((sum, entry) => sum + entry.duration, 0) / events,
      latency: {
        count: latencies.length,
        p95Ms: latencies[Math.floor(latencies.length * 0.95)],
        p99Ms: latencies[Math.floor(latencies.length * 0.99)],
        maxMs: latencies.at(-1),
      },
      loop: {
        count: loop.count,
        p95Ms: loop.percentile(95) / 1e6,
        p99Ms: loop.percentile(99) / 1e6,
        maxMs: loop.max / 1e6,
      },
    }),
  );
} finally {
  inspector.disconnect();
  gc.disconnect();
  loop.disable();
  await observer.drain();
  await emitter.drain();
  for (const store of stores) {
    store.disable();
  }
}
