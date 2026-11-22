// Owner microbenchmark: 40 synthetic plugins, published Gateway inventory, external-auth reads.
// Run each revision in an isolated OPENCLAW_STATE_DIR on the approved benchmark host:
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/plugin-metadata-frame-measure.ts timing 4000
// Repeat with allocation, alternating revisions. Sampling includes collected objects;
// CPU/GC timing is a separate untraced pass. This does not measure Gateway/RPC latency.
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { prepareRuntimePluginsConfig } from "../../src/plugins/config-state.js";
import {
  getCurrentPluginMetadataSnapshot,
  setGatewayPluginMetadataSnapshot,
} from "../../src/plugins/current-plugin-metadata-snapshot.js";
import { clearCurrentPluginMetadataSnapshot } from "../../src/plugins/current-plugin-metadata-state.js";
import { resolveInstalledPluginIndexPolicyHash } from "../../src/plugins/installed-plugin-index-policy.js";
import { finalizePluginMetadataSnapshot } from "../../src/plugins/plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../../src/plugins/plugin-metadata.test-support.js";
import { createProviderExternalAuthResolver } from "../../src/plugins/provider-external-auth-core.js";

const [mode = "timing", rawIterations = "4000"] = process.argv.slice(2);
const iterations = Number(rawIterations);
assert(mode === "timing" || mode === "allocation");
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(global.gc, "Run with --expose-gc");
assert(process.env.OPENCLAW_STATE_DIR, "Set an isolated OPENCLAW_STATE_DIR");
const plugins = Array.from({ length: 40 }, (_, index) => ({ id: `synthetic-${index}` }));
const config = {
  plugins: {
    allow: plugins.map(({ id }) => id),
    entries: Object.fromEntries(plugins.map(({ id }) => [id, { enabled: true }])),
  },
};
prepareRuntimePluginsConfig(config);
const snapshot = finalizePluginMetadataSnapshot(
  createPluginMetadataSnapshotFixture({ plugins }, resolveInstalledPluginIndexPolicyHash(config)),
);
setGatewayPluginMetadataSnapshot(snapshot, { config });
const resolver = createProviderExternalAuthResolver({ resolveProviderPluginsForHooks: () => [] });
let observed = 0;
async function run(count: number) {
  for (let index = 0; index < count; index++) {
    await resolver.withPreparedExternalAuthProfiles({ config }, async () => {
      assert.equal(getCurrentPluginMetadataSnapshot({ config }), snapshot);
      observed++;
    });
  }
}

await run(100);
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
  const cpu = process.cpuUsage();
  const start = performance.now();
  await run(iterations);
  const wallMs = performance.now() - start;
  const used = process.cpuUsage(cpu);
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
  const retainedHeapBytes = process.memoryUsage().heapUsed;
  assert.equal(observed, iterations + 100);
  console.log(
    JSON.stringify({
      mode,
      iterations,
      plugins: plugins.length,
      node: process.version,
      hostLoad,
      wallMs,
      cpuMs: (used.user + used.system) / 1000,
      sampledBytes,
      bytesPerOperation: sampledBytes === undefined ? undefined : sampledBytes / iterations,
      gc: {
        count: gcDurations.length,
        totalMs: gcDurations.reduce((sum, ms) => sum + ms, 0),
        maxMs: Math.max(0, ...gcDurations),
      },
      memory: { before, after, retainedHeapBytes },
    }),
  );
} finally {
  observer.disconnect();
  inspector.disconnect();
  clearCurrentPluginMetadataSnapshot();
  prepareRuntimePluginsConfig(null);
}
