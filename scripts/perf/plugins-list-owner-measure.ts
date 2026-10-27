// Warm plugins.list inventory: 44 tracked synthetic packages, schemas and local metadata.
// OPENCLAW_STATE_DIR=$PWD/.local/plugins-list-owner node --expose-gc --import ./scripts/tsx.mjs \
//   scripts/perf/plugins-list-owner-measure.ts timing|allocation|counts 2000
// Alternate baseline/candidate runs. CPU and latency use untraced timing; allocation
// includes collected objects. Counts separately instruments filesystem realpath calls.
// This owner workload complements real Gateway RPC proof; it excludes remote catalogs.
import assert from "node:assert/strict";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { syncBuiltinESMExports } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { PluginInstallRecord } from "../../src/config/types.plugins.js";
import { prepareRuntimePluginsConfig } from "../../src/plugins/config-state.js";
import { setGatewayPluginMetadataSnapshot } from "../../src/plugins/current-plugin-metadata-snapshot.js";
import { clearCurrentPluginMetadataSnapshot } from "../../src/plugins/current-plugin-metadata-state.js";
import { recordInstalledPluginIndexInstallOwner } from "../../src/plugins/installed-plugin-index-install-owner.js";
import { resolveInstalledPluginIndexPolicyHash } from "../../src/plugins/installed-plugin-index-policy.js";
import { listManagedPlugins } from "../../src/plugins/management-service.js";
import type { PluginManifestRecord } from "../../src/plugins/manifest-registry.types.js";
import { finalizePluginMetadataSnapshot } from "../../src/plugins/plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../../src/plugins/plugin-metadata.test-support.js";

const [mode = "timing", rawIterations = "2000"] = process.argv.slice(2);
const iterations = Number(rawIterations);
assert(["timing", "allocation", "counts"].includes(mode));
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(global.gc, "Run with --expose-gc");
const stateDir = process.env.OPENCLAW_STATE_DIR;
assert(stateDir, "Set an isolated OPENCLAW_STATE_DIR");
fs.mkdirSync(stateDir, { recursive: true });
const fixtureRoot = fs.mkdtempSync(path.join(stateDir, "inventory-"));
const plugins = Array.from({ length: 44 }, (_, index) => {
  const id = `synthetic-${index}`;
  const rootDir = path.join(fixtureRoot, "node_modules", id);
  fs.mkdirSync(rootDir, { recursive: true });
  fs.writeFileSync(
    path.join(rootDir, "package.json"),
    JSON.stringify({ name: id, version: "1.0.0" }),
  );
  return {
    id,
    name: `Synthetic plugin ${index}`,
    rootDir,
    origin: "global" as const,
    categories: ["tools"],
    configSchema: { type: "object", properties: { label: { type: "string" } } },
  } satisfies Partial<PluginManifestRecord>;
});
const config = {
  plugins: {
    allow: plugins.map(({ id }) => id),
    entries: Object.fromEntries(
      plugins.map(({ id }) => [id, { enabled: true, config: { label: id } }]),
    ),
  },
};
prepareRuntimePluginsConfig(config);
const metadata = createPluginMetadataSnapshotFixture(
  { plugins },
  resolveInstalledPluginIndexPolicyHash(config),
);
const installRecords: Record<string, PluginInstallRecord> = {};
for (const record of metadata.index.plugins) {
  recordInstalledPluginIndexInstallOwner(record, record.pluginId);
  record.packageName = record.pluginId;
  installRecords[record.pluginId] = {
    source: "npm",
    spec: record.pluginId,
    installPath: record.rootDir,
    version: "1.0.0",
  };
}
metadata.index.installRecords = installRecords;
finalizePluginMetadataSnapshot(metadata);
setGatewayPluginMetadataSnapshot(metadata, { config });
const params = { config, metadata, officialCatalog: { entries: [] } };
const durations: number[] = [];
let observed = 0;
async function run(count: number, measure = false) {
  for (let index = 0; index < count; index++) {
    const started = performance.now();
    const result = await listManagedPlugins(params);
    assert.equal(result.plugins.length, plugins.length);
    observed += result.plugins.length;
    if (measure) {
      durations.push(performance.now() - started);
    }
  }
}

await run(20);
global.gc();
await nextTurn();
const inspector = new Session();
const gcDurations: number[] = [];
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    gcDurations.push(entry.duration);
  }
});
const originalRealpath = fs.realpathSync;
let realpathCalls = 0;
try {
  if (mode === "allocation") {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  } else if (mode === "counts") {
    function counted<T extends typeof fs.realpathSync.native>(fn: T): T {
      return new Proxy(fn, {
        apply(target, receiver, args) {
          realpathCalls++;
          return Reflect.apply(target, receiver, args);
        },
      });
    }
    const native = counted(originalRealpath.native);
    fs.realpathSync = counted(
      new Proxy(originalRealpath, {
        get(target, property, receiver) {
          return property === "native" ? native : Reflect.get(target, property, receiver);
        },
      }),
    );
    syncBuiltinESMExports();
  } else {
    observer.observe({ entryTypes: ["gc"] });
  }
  const hostLoad = loadavg();
  const before = process.memoryUsage();
  const cpu = process.cpuUsage();
  const start = performance.now();
  await run(iterations, mode === "timing");
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
    fs.writeFileSync(path.join(stateDir, "allocation-profile.json"), JSON.stringify(profile));
  }
  global.gc();
  durations.sort((a, b) => a - b);
  assert.equal(observed, (iterations + 20) * plugins.length);
  console.log(
    JSON.stringify({
      mode,
      iterations,
      plugins: plugins.length,
      node: process.version,
      hostLoad,
      wallMs,
      cpuMs: (used.user + used.system) / 1000,
      p50Ms: durations[Math.floor(durations.length * 0.5)],
      p99Ms: durations[Math.floor(durations.length * 0.99)],
      sampledBytes,
      bytesPerOperation: sampledBytes === undefined ? undefined : sampledBytes / iterations,
      realpathCalls: mode === "counts" ? realpathCalls : undefined,
      gc: {
        count: gcDurations.length,
        totalMs: gcDurations.reduce((sum, ms) => sum + ms, 0),
        maxMs: Math.max(0, ...gcDurations),
      },
      memory: { before, after, retainedHeapBytes: process.memoryUsage().heapUsed },
    }),
  );
} finally {
  fs.realpathSync = originalRealpath;
  syncBuiltinESMExports();
  observer.disconnect();
  inspector.disconnect();
  clearCurrentPluginMetadataSnapshot();
  prepareRuntimePluginsConfig(null);
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
