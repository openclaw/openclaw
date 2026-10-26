// Owner microbenchmark: 40 synthetic provider plugins and a frozen runtime config.
// Run each revision with its own OPENCLAW_STATE_DIR on the approved benchmark host:
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/provider-auth-lookup-maps-measure.ts timing 4000
// Repeat with allocation, alternating revisions. Allocation sampling includes collected
// objects; timing/GC are untraced. This does not measure whole-Gateway/RPC performance.
// Paired launches may set OPENCLAW_PERF_START_AT_MS to synchronize warmed measurement windows.
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import { createPluginMetadataSnapshotFixture } from "../../src/plugins/plugin-metadata.test-support.js";
import { resolveProviderAuthLookupMaps } from "../../src/secrets/provider-env-vars.js";
import { freezeJsonSnapshot } from "../../src/shared/immutable-data.js";

const [mode = "timing", rawIterations = "4000"] = process.argv.slice(2);
const iterations = Number(rawIterations);
assert(mode === "timing" || mode === "allocation");
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(global.gc, "Run with --expose-gc");
assert(process.env.OPENCLAW_STATE_DIR, "Set an isolated OPENCLAW_STATE_DIR");
const plugins = Array.from({ length: 40 }, (_, index) => {
  const id = `synthetic-${index}`;
  return {
    id,
    providers: [id],
    providerAuthAliases: { [`alias-${index}`]: id },
    setup: {
      providers: [
        {
          id,
          envVars: [`SYNTHETIC_${index}_API_KEY`],
          authEvidence: [
            {
              type: "local-file-with-env" as const,
              fileEnvVar: `SYNTHETIC_${index}_CREDENTIALS`,
              credentialMarker: `synthetic-local-${index}`,
            },
          ],
        },
      ],
    },
  };
});
const config = freezeJsonSnapshot({
  plugins: {
    allow: plugins.map(({ id }) => id),
    entries: Object.fromEntries(plugins.map(({ id }) => [id, { enabled: true }])),
  },
});
const metadataSnapshot = createPluginMetadataSnapshotFixture({ plugins });
for (const record of metadataSnapshot.index.plugins) {
  record.contributions = {
    channels: [],
    channelConfigs: [],
    providers: [record.pluginId],
    modelCatalogProviders: [],
    modelSupportPrefixes: [],
    modelSupportPatterns: [],
    autoEnableProviderIds: [],
    commandAliases: [],
    contracts: {},
  };
}
const capturedEnv = { OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR };
function run(count: number) {
  for (let index = 0; index < count; index++) {
    const maps = resolveProviderAuthLookupMaps({
      config,
      env: { ...capturedEnv },
      metadataSnapshot,
    });
    assert.equal(maps.aliasMap["alias-39"], "synthetic-39");
    assert.equal(maps.envCandidateMap["alias-39"]?.[0], "SYNTHETIC_39_API_KEY");
    assert.equal(maps.authEvidenceMap["alias-39"]?.[0]?.credentialMarker, "synthetic-local-39");
    assert.equal(maps.setupProviderFallbackRefs.length, 80);
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
  if (process.env.OPENCLAW_PERF_START_AT_MS) {
    await delay(Math.max(0, Number(process.env.OPENCLAW_PERF_START_AT_MS) - Date.now()));
  }
  const hostLoad = loadavg();
  const before = process.memoryUsage();
  const cpu = process.cpuUsage();
  const start = performance.now();
  run(iterations);
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
      memory: { before, after, retainedHeapBytes: process.memoryUsage().heapUsed },
    }),
  );
} finally {
  observer.disconnect();
  inspector.disconnect();
}
