/**
 * Recovery resolver transport: 40 plugins with 250 captured path aliases each.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/plugin-recovery-transport-measure.ts timing 4000
 * Repeat with allocation; run alternating baseline/candidate processes on the same host.
 * Measures the real resolver codec, excluding filesystem capture and Gateway latency.
 * Acceptance: identical resolution/isolation, lower allocation, no material CPU regression.
 * Sampling includes collected objects; CPU/GC results come from separate untraced timing runs.
 */
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { restorePluginRecoverySourceResolver } from "../../src/plugins/plugin-generation-source-lookup.js";
import { GenerationCodec } from "../../src/plugins/plugin-generation-worker-codec.js";

const [mode = "timing", rawIterations = "4000"] = process.argv.slice(2);
const iterations = Number(rawIterations);
assert(mode === "timing" || mode === "allocation");
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(global.gc, "Run with --expose-gc");
const unexpected = (): never => {
  throw new Error("Immutable recovery lookup must not call its producer");
};
const roots = { exportRoot: unexpected, importRoot: unexpected };
const sender = new GenerationCodec(unexpected, roots);
const receiver = new GenerationCodec(unexpected, roots);
const fixtures = Array.from({ length: 40 }, (_, plugin) => {
  const root = path.resolve(`synthetic-plugin-${plugin}`);
  const entries = Array.from({ length: 250 }, (_entry, file): [string, string] => [
    path.join(root, `source-${file}.js`),
    path.resolve(`synthetic-capture-${plugin}`, `source-${file}.js`),
  ]);
  return {
    entries,
    resolve: restorePluginRecoverySourceResolver({
      rootDir: root,
      sourceRoot: root,
      sources: new Map(entries),
    }),
  };
});
function run(count: number) {
  for (let index = 0; index < count; index++) {
    const fixture = fixtures[index % fixtures.length]!;
    const resolve = receiver.decode(sender.encode(fixture.resolve));
    assert.equal(typeof resolve, "function");
    // SAFETY: the encoded source resolver is callable and returns a captured path.
    const restored = resolve as (source: string) => string;
    const [source, captured] = fixture.entries[index % fixture.entries.length]!;
    assert.equal(restored(source), captured);
  }
}
run(200);
await nextTurn();
global.gc();
const inspector = new Session();
const gc: number[] = [];
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    gc.push(entry.duration);
  }
});
try {
  if (mode === "allocation") {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  } else {
    observer.observe({ entryTypes: ["gc"] });
  }
  const hostLoad = loadavg();
  const initialMemory = process.memoryUsage();
  const started = performance.now();
  const cpu = process.threadCpuUsage();
  run(iterations);
  const used = process.threadCpuUsage(cpu);
  const wallMs = performance.now() - started;
  const finalMemory = process.memoryUsage();
  await nextTurn();
  await nextTurn();
  observer.disconnect();
  let sampledBytes: number | undefined;
  if (mode === "allocation") {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    sampledBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
  }
  global.gc();
  console.log(
    JSON.stringify({
      mode,
      iterations,
      plugins: 40,
      pathsPerPlugin: 250,
      hostLoad,
      wallMs,
      threadCpuMs: (used.user + used.system) / 1000,
      sampledBytes,
      bytesPerOperation: sampledBytes === undefined ? undefined : sampledBytes / iterations,
      gc: {
        count: gc.length,
        totalMs: gc.reduce((sum, ms) => sum + ms, 0),
        maxMs: Math.max(0, ...gc),
      },
      initialMemory,
      finalMemory,
      retainedHeapBytes: process.memoryUsage().heapUsed,
    }),
  );
} finally {
  observer.disconnect();
  inspector.disconnect();
}
