/**
 * Factory settlement allocation/CPU and retained-controller probe.
 * Run on each revision: node --import ./scripts/tsx.mjs scripts/perf/context-engine-factory-retention.ts
 * Optional first argument selects an owner module for a frozen baseline; default is current source.
 * Five passes each settle 2,000 factories with 40 synthetic plugin cancellation signals per run.
 * Retention keeps 20 settled owners alive, as engine metadata can, and forces GC outside timing.
 * This isolates owner cost; it is not a Gateway load measurement.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { Session } from "node:inspector/promises";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { queryObjects } from "node:v8";
import { AsyncWorkScope } from "../../src/shared/async-work-scope.js";

const { ContextEngineFactoryResources, disposeContextEngineSources } = await import(
  process.argv[2]
    ? pathToFileURL(process.argv[2]).href
    : new URL("../../src/context-engine/registry.resources.ts", import.meta.url).href
);
class RunState {
  controllers = Array.from({ length: 40 }, () => new AbortController());
  signals = this.controllers.map((controller) => controller.signal);
}
const carrier = new AsyncLocalStorage<RunState>();
async function settle() {
  const parent = new AsyncWorkScope();
  const owner = carrier.run(new RunState(), () =>
    parent.run(() => new ContextEngineFactoryResources([])),
  );
  await owner.run(() => Promise.resolve());
  await disposeContextEngineSources(undefined, [owner]);
  await parent.drain();
  return owner;
}
const inspector = new Session();
inspector.connect();
try {
  for (let i = 0; i < 100; i++) {
    await settle();
  }
  for (let pass = 0; pass < 5; pass++) {
    await nextTurn();
    await inspector.post("HeapProfiler.collectGarbage");
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    const cpu = process.cpuUsage();
    for (let i = 0; i < 2000; i++) {
      await settle();
    }
    const used = process.cpuUsage(cpu);
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    console.log(
      JSON.stringify({
        pass,
        iterations: 2000,
        cpuMs: (used.user + used.system) / 1000,
        allocatedBytes: profile.samples.reduce((sum, sample) => sum + sample.size, 0),
      }),
    );
  }
  await nextTurn();
  await inspector.post("HeapProfiler.collectGarbage");
  const before = {
    controllers: queryObjects(AbortController),
    signals: queryObjects(AbortSignal),
    heap: process.memoryUsage().heapUsed,
  };
  const owners = [];
  for (let i = 0; i < 20; i++) {
    owners.push(await settle());
  }
  await nextTurn();
  console.log(
    JSON.stringify({
      retainedOwners: owners.length,
      before,
      after: {
        runStates: queryObjects(RunState),
        controllers: queryObjects(AbortController),
        signals: queryObjects(AbortSignal),
        heap: process.memoryUsage().heapUsed,
      },
    }),
  );
} finally {
  inspector.disconnect();
  carrier.disable();
}
