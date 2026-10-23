// Run with node --import ./scripts/tsx.mjs on the approved Node 26 benchmark host.
import { AsyncLocalStorage } from "node:async_hooks";
import { Session } from "node:inspector/promises";
import { performance } from "node:perf_hooks";
import {
  createMainThreadStallMonitor,
  getMainThreadTaskName,
  runWithMainThreadTask,
} from "../../src/infra/main-thread-stall.ts";

const [mode = "phase", countText = "21", iterationsText = "200000"] = process.argv.slice(2);
const count = Number(countText);
const iterations = Number(iterationsText);
if (
  !["entry", "same-name", "phase"].includes(mode) ||
  !Number.isSafeInteger(count) ||
  count < 0 ||
  !Number.isSafeInteger(iterations) ||
  iterations < 1
) {
  throw new Error(
    "Usage: main-thread-stall-measure.mjs <entry|same-name|phase> <stores> <iterations>",
  );
}
const name = "gateway:rpc:sessions.list";
let calls = 0;
const work = () => {
  if (getMainThreadTaskName() !== name) {
    throw new Error("Lost task attribution");
  }
  calls++;
};
const scope = () =>
  runWithMainThreadTask(name, work, mode === "phase" ? "session-rows:select" : undefined);
const monitor = createMainThreadStallMonitor();
const stores = Array.from({ length: count }, () => new AsyncLocalStorage());
const withinStores = (run) =>
  stores.reduceRight((inner, storage) => () => storage.run(true, inner), run)();

await withinStores(async () => {
  const inspector = new Session();
  inspector.connect();
  const measure = async () => {
    for (let index = 0; index < 20000; index++) {
      scope();
    }
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 512,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    const before = calls;
    for (let index = 0; index < iterations; index++) {
      scope();
    }
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const bytes = profile.samples.reduce((total, sample) => total + sample.size, 0);
    const sampledCalls = calls - before;
    const started = performance.now();
    for (let index = 0; index < iterations; index++) {
      scope();
    }
    const elapsedMs = performance.now() - started;
    console.log(
      JSON.stringify({
        node: process.version,
        mode,
        stores: count,
        sampledCalls,
        sampledBytes: bytes,
        allocationSamples: profile.samples.length,
        bytesPerCall: bytes / sampledCalls,
        timedCalls: iterations,
        elapsedMs,
        callsPerSecond: (iterations * 1000) / elapsedMs,
      }),
    );
  };
  try {
    await inspector.post("HeapProfiler.enable");
    if (mode === "same-name") {
      await runWithMainThreadTask(name, measure);
    } else {
      await measure();
    }
  } finally {
    inspector.disconnect();
    monitor.stop();
  }
});
