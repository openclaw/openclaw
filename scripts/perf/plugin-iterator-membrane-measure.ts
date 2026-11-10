/**
 * Isolated plugin iterator owner benchmark; no Gateway, network, or model calls.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/plugin-iterator-membrane-measure.ts timing 20000
 * Repeat with allocation and promises; alternate base/candidate for five samples.
 * The verify mode asserts one membrane continuation Promise per event per layer.
 * Promise instrumentation also counts reaction jobs; it is separate from timing/allocation.
 * Optional final argument: path to a frozen PluginInstance source module.
 * Acceptance: identical events and source call counts, lower allocation or CPU,
 * with no reproducible adverse CPU change. Promise counts are a separate pass.
 * Measures zero, one, and three independently revocable membrane layers.
 */
import assert from "node:assert/strict";
import { createHook } from "node:async_hooks";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// An optional source module permits alternating frozen base/candidate owners.
const { PluginInstance } = (await import(
  process.argv[4]
    ? pathToFileURL(resolve(process.argv[4])).href
    : new URL("../../src/plugins/plugin-instance.js", import.meta.url).href
)) as typeof import("../../src/plugins/plugin-instance.js");

const mode = process.argv[2] ?? "timing";
const iterations = Number(process.argv[3] ?? 20000);
assert(["timing", "allocation", "promises", "verify"].includes(mode));
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(global.gc, "Run with --expose-gc");

for (const layers of [0, 1, 3]) {
  const instance = new PluginInstance("synthetic-stream");
  const consumers = Array.from({ length: layers }, () => instance.retainConsumer());
  let calls = 0;
  const event = Object.freeze({ type: "text_delta", delta: "synthetic" });
  const source = {
    [Symbol.asyncIterator]() {
      return this;
    },
    async next() {
      calls++;
      return { done: false, value: event };
    },
    async return() {
      return { done: true, value: event };
    },
  };
  const stream = consumers.reduce((value, consumer) => consumer.wrap(value), source);
  const iterator = stream[Symbol.asyncIterator]();
  const run = async (count: number) => {
    const before = calls;
    for (let index = 0; index < count; index++) {
      const result = await iterator.next();
      assert.equal(result.done, false);
      assert.equal(result.value, event);
    }
    assert.equal(calls - before, count);
  };
  await run(iterations);
  global.gc();
  const inspector = new Session();
  let promises = 0;
  let reactions = 0;
  const promiseIds = new Set<number>();
  const hook = createHook({
    init(id, type) {
      if (type === "PROMISE") {
        promises++;
        promiseIds.add(id);
      }
    },
    before(id) {
      if (promiseIds.has(id)) {
        reactions++;
      }
    },
  });
  if (mode === "allocation") {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 1024,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  if (mode === "promises" || mode === "verify") {
    hook.enable();
  }
  const hostLoad = loadavg();
  const start = process.threadCpuUsage();
  const wallStart = performance.now();
  await run(iterations);
  const wallMs = performance.now() - wallStart;
  const cpu = process.threadCpuUsage(start);
  hook.disable();
  if (mode === "verify") {
    // The async run() call and its consumer contribute two Promises and one reaction.
    assert.equal(promises, iterations * (layers + 2) + 2);
    assert.equal(reactions, iterations * (layers + 1) + 1);
  }
  let allocatedBytes: number | undefined;
  if (mode === "allocation") {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
      node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
    allocatedBytes = sum(profile.head);
    inspector.disconnect();
  }
  await iterator.return();
  for (const consumer of consumers) {
    consumer.release();
  }
  await instance.dispose();
  console.log(
    JSON.stringify({
      mode,
      layers,
      iterations,
      node: process.version,
      hostLoad,
      mainThreadCpuMs: (cpu.user + cpu.system) / 1000,
      wallMs,
      allocatedBytes,
      bytesPerEvent: allocatedBytes === undefined ? undefined : allocatedBytes / iterations,
      promises: mode === "promises" || mode === "verify" ? promises : undefined,
      reactionsPerEvent:
        mode === "promises" || mode === "verify" ? (reactions - 1) / iterations : undefined,
      promisesPerEvent:
        mode === "promises" || mode === "verify" ? (promises - 2) / iterations : undefined,
    }),
  );
}
