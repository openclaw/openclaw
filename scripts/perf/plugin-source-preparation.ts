// Real loader acquisition: 44 external plugins, fresh inventory per iteration.
// Run on each revision with separate timing/allocation passes (allocation samples main only):
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/plugin-source-preparation.ts timing 5
// Repeat with allocation. Reports CPU, wall, GC, sampled bytes, RSS and registered order.
// Use built-Gateway bench-gateway-startup.ts --case teamBoot for readiness/peak-tree RSS.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { PluginRegistry } from "../../src/plugins/registry-types.js";

const [mode = "timing", rawIterations = "5"] = process.argv.slice(2);
const iterations = Number(rawIterations);
assert(mode === "timing" || mode === "allocation");
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(global.gc, "Run with --expose-gc");
await fs.mkdir(".local", { recursive: true });
const root = await fs.mkdtemp(path.resolve(".local/plugin-source-preparation-"));
process.env.OPENCLAW_STATE_DIR = path.join(root, "state");
process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = "1";
const ids = Array.from({ length: 44 }, (_, index) => `synthetic-${String(index).padStart(2, "0")}`);
const paths: string[] = [];
for (const id of ids) {
  const dir = path.join(root, id);
  await fs.mkdir(dir);
  await fs.writeFile(
    path.join(dir, "openclaw.plugin.json"),
    JSON.stringify({
      id,
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    }),
  );
  const file = path.join(dir, "index.cjs");
  await fs.writeFile(
    file,
    `module.exports = { id: ${JSON.stringify(id)}, register(api) { api.registerProvider({ id: ${JSON.stringify(id)}, label: ${JSON.stringify(id)}, auth: [] }); } };`,
  );
  paths.push(file);
}
const { loadOpenClawPluginsAsync } = await import("../../src/plugins/loader-runtime-load.js");
const { createPluginCache, withPluginCache } = await import("../../src/plugins/plugin-cache.js");
const { withPluginSourceCaptureStorage } =
  await import("../../src/plugins/plugin-source-capture-context.js");
const inspector = new Session();
const gcMs: number[] = [];
const observer = new PerformanceObserver((list) => {
  gcMs.push(...list.getEntries().map(({ duration }) => duration));
});
const samples: {
  wallMs: number;
  mainThreadCpuMs: number;
  processCpuMs: number;
  rss: number;
  heapUsed: number;
}[] = [];
try {
  global.gc();
  await nextTurn();
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
  for (let iteration = 0; iteration < iterations; iteration++) {
    await using cache = createPluginCache();
    const cpu = process.threadCpuUsage();
    const totalCpu = process.cpuUsage();
    const started = performance.now();
    const registry: PluginRegistry = await withPluginSourceCaptureStorage(
      { stateDir: process.env.OPENCLAW_STATE_DIR, placement: "state" },
      () =>
        withPluginCache(cache, () =>
          loadOpenClawPluginsAsync({
            activate: false,
            config: { plugins: { allow: ids, load: { paths }, slots: { memory: "none" } } },
            logger: { debug() {}, info() {}, warn() {}, error() {} },
          }),
        ),
    );
    const elapsedCpu = process.threadCpuUsage(cpu);
    const elapsedTotalCpu = process.cpuUsage(totalCpu);
    const memory = process.memoryUsage();
    samples.push({
      wallMs: performance.now() - started,
      mainThreadCpuMs: (elapsedCpu.user + elapsedCpu.system) / 1000,
      processCpuMs: (elapsedTotalCpu.user + elapsedTotalCpu.system) / 1000,
      rss: memory.rss,
      heapUsed: memory.heapUsed,
    });
    assert.deepEqual(
      registry.plugins.map(({ id, status }) => [id, status]),
      ids.map((id) => [id, "loaded"]),
    );
    assert.deepEqual(
      registry.providers.map(({ provider }) => provider.id),
      ids,
    );
    assert.deepEqual(
      registry.diagnostics.filter(({ level }) => level === "error"),
      [],
    );
  }
  await nextTurn();
  observer.disconnect();
  const sampledBytes =
    mode === "allocation"
      ? (await inspector.post("HeapProfiler.stopSampling")).profile.samples.reduce(
          (sum, sample) => sum + sample.size,
          0,
        )
      : undefined;
  console.log(
    JSON.stringify({
      mode,
      iterations,
      captures: iterations * ids.length,
      hostLoad,
      hostLoadAfter: loadavg(),
      samples,
      sampledBytes,
      gc: {
        count: gcMs.length,
        totalMs: gcMs.reduce((sum, ms) => sum + ms, 0),
        maxMs: Math.max(0, ...gcMs),
      },
    }),
  );
} finally {
  observer.disconnect();
  inspector.disconnect();
  await fs.rm(root, { recursive: true, force: true });
}
