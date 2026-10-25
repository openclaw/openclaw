// Owner-only streamed delivery benchmark; run on each source revision with:
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/async-work-scope-measure.ts
// Add --allocations for a separate sampled-allocation pass (never gate its timing).
// --events 1000000 --stores 24 models long streams inside a populated async frame.
// Use a future --start-at epoch (ms) for concurrent, swapped-CPU pairs. Require identical deliveries, detached
// work ownership and inherited context. Gateway load proof remains separate:
// use the ten-minute workload in scripts/bench-gateway-concurrency.ts.
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import {
  AsyncWorkScope,
  getAsyncWorkSignal,
  isAsyncWorkScopeActiveHere,
  runOutsideAsyncWorkScope,
} from "../../src/shared/async-work-scope.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    events: { type: "string", default: "1000000" },
    stores: { type: "string", default: "24" },
    "start-at": { type: "string", default: "0" },
    allocations: { type: "boolean", default: false },
  },
});
const events = parseStrictIntegerOption({
  raw: values.events,
  label: "--events",
  min: 1,
  fallback: 1,
});
const stores = parseStrictIntegerOption({
  raw: values.stores,
  label: "--stores",
  min: 1,
  fallback: 1,
});
const startAt = parseStrictIntegerOption({
  raw: values["start-at"],
  label: "--start-at",
  min: 0,
  fallback: 0,
});
assert(global.gc, "Run with --expose-gc");
const emitter = new AsyncWorkScope();
const contexts = Array.from({ length: stores }, () => new AsyncLocalStorage<number>());
const ready = Promise.resolve();
let deliveries = 0;
const deliver = () => {
  assert.equal(getAsyncWorkSignal(), undefined);
  assert.equal(isAsyncWorkScopeActiveHere(emitter), false);
  for (const [index, context] of contexts.entries()) {
    assert.equal(context.getStore(), index);
  }
  deliveries++;
};
const dispatch = () => ready.then(deliver);
async function stream(count: number) {
  for (let offset = 0; offset < count; offset += 1000) {
    const pending: Promise<void>[] = [];
    for (let index = offset; index < Math.min(count, offset + 1000); index++) {
      pending.push(runOutsideAsyncWorkScope(dispatch));
    }
    await Promise.all(pending);
  }
}
function enter(index: number, run: () => Promise<void>): Promise<void> {
  return index === contexts.length
    ? emitter.run(run)
    : contexts[index]!.run(index, () => enter(index + 1, run));
}
function allocated(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((total, child) => total + allocated(child), 0);
}
const inspector = new Session();
try {
  await enter(0, () => stream(10_000));
  global.gc();
  await nextTurn();
  deliveries = 0;
  if (startAt) {
    assert(startAt > Date.now(), "Warmup missed the paired start time");
    await delay(startAt - Date.now());
  }
  if (values.allocations) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const before = process.threadCpuUsage();
  const started = performance.now();
  await enter(0, () => stream(events));
  const elapsedMs = performance.now() - started;
  const cpu = process.threadCpuUsage(before);
  assert.equal(deliveries, events);
  const profile = values.allocations
    ? (await inspector.post("HeapProfiler.stopSampling")).profile
    : undefined;
  console.log(
    JSON.stringify({
      events,
      stores,
      deliveries,
      elapsedMs,
      mainThreadCpuUsPerEvent: (cpu.user + cpu.system) / events,
      allocatedBytesPerEvent: profile ? allocated(profile.head) / events : undefined,
      rss: process.memoryUsage().rss,
      heapUsed: process.memoryUsage().heapUsed,
    }),
  );
} finally {
  inspector.disconnect();
  await emitter.drain();
  for (const context of contexts) {
    context.disable();
  }
}
