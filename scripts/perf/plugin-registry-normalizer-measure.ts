// Owner microbench: 40 plugins, two interleaved manifest views, changing enabled policy.
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/plugin-registry-normalizer-measure.ts timing 4000
// Repeat with allocation; --normalizer-module <path> selects a saved baseline owner module.
// Compose the same normalizer + config normalization calls as normalizePluginsConfigWithRegistry.
// Warm 100 calls; compare alternating revisions in separate processes. Accept lower CPU and
// allocated bytes with identical alias/policy results. This does not measure Gateway latency.
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { normalizePluginsConfigWithResolverCore } from "../../src/plugins/config-normalization-shared.js";
import { createPluginMetadataSnapshotFixture } from "../../src/plugins/plugin-metadata.test-support.js";
import { freezeTrustedJsonSnapshot } from "../../src/shared/immutable-data.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { "normalizer-module": { type: "string" } },
});
const [mode = "timing", rawIterations = "4000"] = positionals;
const iterations = Number(rawIterations);
assert(mode === "timing" || mode === "allocation");
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(global.gc, "Run with --expose-gc");
const moduleUrl = values["normalizer-module"]
  ? pathToFileURL(path.resolve(values["normalizer-module"]))
  : new URL("../../src/plugins/plugin-registry-id-normalizer.ts", import.meta.url);
const { createPluginRegistryIdNormalizer } = (await import(
  moduleUrl.href
)) as typeof import("../../src/plugins/plugin-registry-id-normalizer.js");
const ids = Array.from({ length: 40 }, (_, index) => `synthetic-${index}`);
const aliases = ids.map((_, index) => `alias-${index}`);
const views = [0, 1].map(
  (offset) =>
    createPluginMetadataSnapshotFixture({
      plugins: ids.map((id, index) => ({
        id,
        providers: [`alias-${(index + offset) % ids.length}`],
        channels: [`channel-${index}`],
        legacyPluginIds: [`legacy-${index}`],
      })),
    }).manifestRegistry,
);
const index = createPluginMetadataSnapshotFixture({ plugins: ids.map((id) => ({ id })) }).index;
freezeTrustedJsonSnapshot(index);
const configs = [false, true].map((enabled) => ({
  allow: aliases,
  entries: Object.fromEntries(aliases.map((alias) => [alias, { enabled }])),
}));
function run(count: number) {
  for (let call = 0; call < count; call++) {
    const offset = call % 2;
    const enabled = call % 4 >= 2;
    const normalized = normalizePluginsConfigWithResolverCore(
      configs[Number(enabled)],
      createPluginRegistryIdNormalizer(index, { manifestRegistry: views[offset] }),
    );
    const owner = offset ? "synthetic-39" : "synthetic-0";
    assert.equal(normalized.allow[0], owner);
    assert.equal(normalized.allow.length, 40);
    assert.equal(normalized.entries[owner]?.enabled, enabled);
  }
}

run(100);
global.gc();
await nextTurn();
const inspector = new Session();
const gcDurations: number[] = [];
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    gcDurations.push(entry.duration);
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
  const before = process.memoryUsage();
  const cpu = process.threadCpuUsage();
  const start = performance.now();
  run(iterations);
  const wallMs = performance.now() - start;
  const used = process.threadCpuUsage(cpu);
  const after = process.memoryUsage();
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
      plugins: ids.length,
      manifestViews: views.length,
      node: process.version,
      hostLoad,
      wallMs,
      mainThreadCpuMs: (used.user + used.system) / 1000,
      sampledBytes,
      bytesPerOperation: sampledBytes === undefined ? undefined : sampledBytes / iterations,
      gc: {
        count: gcDurations.length,
        totalMs: gcDurations.reduce((sum, ms) => sum + ms, 0),
        maxMs: Math.max(0, ...gcDurations),
      },
      memory: { before, after, retainedHeapBytes: process.memoryUsage().heapUsed },
    }),
  );
} finally {
  observer.disconnect();
  inspector.disconnect();
}
