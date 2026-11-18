/**
 * Fresh-process browser route load and registration benchmark (no browser I/O).
 * Run five times per built revision, alternating revisions when available:
 * node --expose-gc scripts/perf/browser-playwright-import.mjs \
 *   ./dist/extensions/browser/benchmark-api.js 5000
 * Add --allocate for a separate allocation pass (including collected objects).
 * Reports cold import separately from warm registrations. Retained heap is
 * measured after explicit GC; use untraced runs for CPU comparisons.
 */
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { createRequire } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

assert(globalThis.gc, "Run with --expose-gc");
const entry = pathToFileURL(path.resolve(process.argv[2]));
const iterations = Number(process.argv[3] ?? 5000);
assert(Number.isSafeInteger(iterations) && iterations > 0);
const allocate = process.argv.includes("--allocate");
const require = createRequire(entry);
const inspector = new Session();
inspector.connect();
await inspector.post("HeapProfiler.enable");

async function measure(run) {
  globalThis.gc();
  const before = process.memoryUsage();
  if (allocate) {
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const cpu = process.threadCpuUsage();
  const start = performance.now();
  await run();
  const elapsedMs = performance.now() - start;
  const usedCpu = process.threadCpuUsage(cpu);
  let allocatedBytes;
  if (allocate) {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    allocatedBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
  }
  globalThis.gc();
  const after = process.memoryUsage();
  return {
    elapsedMs,
    cpuMs: (usedCpu.user + usedCpu.system) / 1000,
    allocatedBytes,
    retainedHeapBytes: after.heapUsed - before.heapUsed,
    before,
    after,
  };
}

try {
  let browser;
  const cold = await measure(async () => {
    browser = await import(entry.href);
  });
  const loaded = () =>
    Object.keys(require.cache).filter((file) => /[/\\]playwright-core[/\\]/.test(file));
  const modulesAfterImport = loaded();
  const context = browser.createBrowserRouteContext({ getState: () => null });
  const warm = await measure(async () => {
    for (let i = 0; i < iterations; i++) {
      browser.createBrowserRouteDispatcher(context);
    }
  });
  // Quantify the remaining on-demand library cost without controlling Chrome.
  // This is a lower bound for real sessions, which also retain browser objects.
  const onDemand = await measure(async () => {
    assert.equal(require("playwright-core").chromium.name(), "chromium");
  });
  console.log(
    JSON.stringify({
      entry: entry.href,
      iterations,
      allocate,
      hostLoad: loadavg(),
      cold,
      warm,
      modulesAfterImport,
      onDemand,
      modulesAfterDemand: loaded(),
    }),
  );
} finally {
  inspector.disconnect();
}
