// Startup loader context: 40 installed plugins with prepared metadata + install records.
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/plugin-startup-install-records.ts timing 5000
// Repeat with allocation, alternating base/candidate in separate processes; --owner-module
// may select a saved owner module with its relative imports resolved to the same checkout.
// Warm 100 calls; accept identical records/metadata, fewer extraction calls, lower CPU and
// allocated bytes. Separate sampled allocation includes collected objects. This measures
// context preparation, not the whole plugin runtime load or Gateway readiness latency.
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { extractPluginInstallRecordsFromInstalledPluginIndex } from "../../src/plugins/installed-plugin-index-install-records.js";
import { restorePluginMetadataSnapshot } from "../../src/plugins/plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../../src/plugins/plugin-metadata.test-support.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { "owner-module": { type: "string" } },
});
const [mode = "timing", rawIterations = "5000"] = positionals;
const iterations = Number(rawIterations);
assert(mode === "timing" || mode === "allocation");
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(global.gc, "Run with --expose-gc");
const moduleUrl = values["owner-module"]
  ? pathToFileURL(path.resolve(values["owner-module"]))
  : new URL("../../src/plugins/loader-load-context.ts", import.meta.url);
const { resolvePluginLoadCacheContext } = (await import(
  moduleUrl.href
)) as typeof import("../../src/plugins/loader-load-context.js");
const ids = Array.from({ length: 40 }, (_, index) => `synthetic-${index}`);
const snapshot = createPluginMetadataSnapshotFixture({
  plugins: ids.map((id) => ({ id, origin: "global" })),
});
snapshot.index.installRecords = Object.fromEntries(
  ids.map((id) => [
    id,
    {
      source: "npm" as const,
      spec: `@synthetic/${id}@1.0.0`,
      installPath: `/synthetic/plugins/${id}`,
      version: "1.0.0",
      clawhubTrustReasons: ["synthetic-reviewed"],
      acceptedSurface: {
        channels: [],
        providers: [id],
        tools: [`${id}-lookup`],
        contracts: [],
        hooks: [],
        mcpServers: [],
        cliCommands: [],
        cliBackends: [],
        skills: [],
        dangerousConfigFlags: [],
      },
    },
  ]),
);
const metadataSnapshot = restorePluginMetadataSnapshot(snapshot);
const installRecords = extractPluginInstallRecordsFromInstalledPluginIndex(metadataSnapshot.index);
const expectedRecords = { ...installRecords };
const options = {
  metadataSnapshot,
  installRecords,
  config: {
    plugins: { allow: ids, entries: Object.fromEntries(ids.map((id) => [id, { enabled: true }])) },
  },
  env: { HOME: "/synthetic/home", OPENCLAW_STATE_DIR: "/synthetic/state" },
};
let last: ReturnType<typeof resolvePluginLoadCacheContext>;
function run(count: number) {
  for (let call = 0; call < count; call++) {
    last = resolvePluginLoadCacheContext(options);
  }
  assert.deepEqual(last!.installRecords, expectedRecords);
  assert.equal(last!.metadataSnapshot, metadataSnapshot);
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
      recordsPerCall: ids.length,
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
