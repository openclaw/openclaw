// Config-wide metadata owner: eight agents and forty synthetic plugins.
// Set an isolated OPENCLAW_STATE_DIR, then run each revision with:
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/config-wide-metadata-measure.ts cold timing 1000
// Repeat with warm and allocation, counterbalancing revision order. Cold means a metadata
// cache miss with admitted file facts retained; full process/Gateway startup is separate proof.
// Add --owner /absolute/saved-io.plugin-metadata.ts to compare source in the same import graph.
// Allocation uses 32 KiB sampling including objects collected by minor and major GC.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { constants, PerformanceObserver, type PerformanceNodeEntry } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createPluginCache, withPluginCache } from "../../src/plugins/plugin-cache.js";

const { values, positionals } = parseArgs({
  options: { owner: { type: "string" } },
  allowPositionals: true,
});
const [temperature = "cold", mode = "timing", rawIterations = "1000"] = positionals;
const iterations = Number(rawIterations);
assert(temperature === "cold" || temperature === "warm");
assert(mode === "timing" || mode === "allocation");
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(global.gc, "Run with --expose-gc");
const ownerUrl = new URL("../../src/config/io.plugin-metadata.ts", import.meta.url).href;
const replacement = values.owner ? pathToFileURL(path.resolve(values.owner)).href : undefined;
let replaced = false;
registerHooks({
  load(url, context, nextLoad) {
    if (url !== ownerUrl || !replacement) {
      return nextLoad(url, context);
    }
    replaced = true;
    const result = nextLoad(replacement, context);
    return { format: result.format, source: result.source, shortCircuit: true };
  },
});
const { resolveConfigWidePluginMetadataSnapshotAsync } =
  await import("../../src/config/io.plugin-metadata.js");
assert(!replacement || replaced, "Requested baseline source was not loaded");
const stateDir = process.env.OPENCLAW_STATE_DIR;
assert(stateDir && path.isAbsolute(stateDir), "Set an isolated absolute OPENCLAW_STATE_DIR");
await fs.mkdir(stateDir, { recursive: true });
const fixture = await fs.mkdtemp(path.join(stateDir, "config-metadata-"));
const ids = Array.from({ length: 40 }, (_, index) => `synthetic-${index}`);
const roots = ids.map((id) => path.join(fixture, id));
for (const [index, id] of ids.entries()) {
  const root = roots[index]!;
  await fs.mkdir(root);
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      name: id,
      version: "1.0.0",
      openclaw: { extensions: ["./index.js"] },
    }),
  );
  await fs.writeFile(path.join(root, "index.js"), "export default {};\n");
  await fs.writeFile(
    path.join(root, "openclaw.plugin.json"),
    JSON.stringify({
      id,
      configSchema: {
        type: "object",
        properties: Object.fromEntries(
          Array.from({ length: 12 }, (_, field) => [
            `field${field}`,
            { type: "string", description: `Synthetic setting ${field}` },
          ]),
        ),
      },
    }),
  );
}
const params = {
  config: {
    agents: {
      ownership: "explicit" as const,
      entries: Object.fromEntries(
        Array.from({ length: 8 }, (_, index) => [
          `agent-${index}`,
          { workspace: path.join(fixture, `workspace-${index}`) },
        ]),
      ),
    },
    plugins: {
      allow: ids,
      load: { paths: roots },
      entries: Object.fromEntries(ids.map((id) => [id, { enabled: true }])),
    },
  },
  env: { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
  allowCurrent: false,
};
const inspector = new Session();
const gcEntries: PerformanceNodeEntry[] = [];
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    gcEntries.push(entry as PerformanceNodeEntry);
  }
});
try {
  await using cache = createPluginCache();
  await withPluginCache(cache, async () => {
    const initial = await resolveConfigWidePluginMetadataSnapshotAsync(params);
    assert.equal(initial.plugins.length, ids.length);
    let observed = 0;
    async function run(count: number) {
      for (let index = 0; index < count; index++) {
        if (temperature === "cold") {
          cache.metadata.snapshots.clear();
        }
        const snapshot = await resolveConfigWidePluginMetadataSnapshotAsync(params);
        assert.equal(snapshot.plugins.length, ids.length);
        observed += snapshot.plugins.length;
      }
    }
    await run(20);
    global.gc!();
    await nextTurn();
    if (mode === "allocation") {
      inspector.connect();
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 32768,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    } else {
      observer.observe({ entryTypes: ["gc"] });
    }
    const hostLoad = loadavg();
    const before = process.memoryUsage();
    const cpu = process.threadCpuUsage();
    const started = performance.now();
    await run(iterations);
    const ended = performance.now();
    const wallMs = ended - started;
    const used = process.threadCpuUsage(cpu);
    const after = process.memoryUsage();
    await nextTurn();
    await nextTurn();
    observer.disconnect();
    const measuredGc = gcEntries.filter(
      (entry) => entry.startTime >= started && entry.startTime < ended,
    );
    const gcByKind = Object.fromEntries(
      [
        ["minor", constants.NODE_PERFORMANCE_GC_MINOR],
        ["major", constants.NODE_PERFORMANCE_GC_MAJOR],
        ["incremental", constants.NODE_PERFORMANCE_GC_INCREMENTAL],
        ["weakCallbacks", constants.NODE_PERFORMANCE_GC_WEAKCB],
      ].map(([name, kind]) => {
        const entries = measuredGc.filter((entry) => entry.detail.kind === kind);
        return [
          name,
          {
            count: entries.length,
            totalMs: entries.reduce((sum, entry) => sum + entry.duration, 0),
          },
        ];
      }),
    );
    let sampledBytes: number | undefined;
    if (mode === "allocation") {
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      sampledBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
    }
    assert.equal(observed, (iterations + 20) * ids.length);
    console.log(
      JSON.stringify({
        temperature,
        mode,
        owner: values.owner ?? ownerUrl,
        iterations,
        agents: 8,
        plugins: ids.length,
        node: process.version,
        hostLoad,
        wallMs: mode === "timing" ? wallMs : undefined,
        mainThreadCpuMs: mode === "timing" ? (used.user + used.system) / 1000 : undefined,
        sampledBytes,
        samplingInterval: mode === "allocation" ? 32768 : undefined,
        bytesPerOperation: sampledBytes === undefined ? undefined : sampledBytes / iterations,
        gc:
          mode === "timing"
            ? {
                count: measuredGc.length,
                totalMs: measuredGc.reduce((sum, entry) => sum + entry.duration, 0),
                maxMs: Math.max(0, ...measuredGc.map((entry) => entry.duration)),
                byKind: gcByKind,
              }
            : undefined,
        memory: { before, after },
      }),
    );
  });
} finally {
  observer.disconnect();
  inspector.disconnect();
  await fs.rm(fixture, { recursive: true, force: true });
}
