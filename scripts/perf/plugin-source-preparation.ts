// Real loader acquisition: 44 external plugins, fresh inventory per iteration.
// Run on each revision with separate timing/allocation passes (allocation samples main only):
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/plugin-source-preparation.ts timing 5
// Repeat with allocation. Reports CPU, wall, GC, sampled bytes, RSS and registered order.
// Use built-Gateway bench-gateway-startup.ts --case teamBoot for readiness/peak-tree RSS.
// Append bundled-operations for 40 bundled plugins, one with four operation entrypoints
// sharing a createRequire helper. This measures capture without evaluating operation code.
// Example: node --expose-gc --import ./scripts/tsx.mjs scripts/perf/plugin-source-preparation.ts timing 5 bundled-operations
// Append built to measure the already-built dist owners and their compiled workers.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { createRequire } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import type { PluginRegistry } from "../../src/plugins/registry-types.js";

const [mode = "timing", rawIterations = "5", shape = "external", runtime = "source"] =
  process.argv.slice(2);
const iterations = Number(rawIterations);
assert(mode === "timing" || mode === "allocation");
assert(shape === "external" || shape === "bundled-operations");
assert(runtime === "source" || runtime === "built");
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(global.gc, "Run with --expose-gc");
await fs.mkdir(".local", { recursive: true });
const root = await fs.mkdtemp(path.resolve(".local/plugin-source-preparation-"));
const pluginRoot = shape === "external" ? root : path.join(root, "dist", "extensions");
process.env.OPENCLAW_STATE_DIR = path.join(root, "state");
process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = "1";
if (shape === "bundled-operations") {
  delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
  await fs.mkdir(pluginRoot, { recursive: true });
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "openclaw", version: "0.0.0", bin: { openclaw: "openclaw.mjs" } }),
  );
  await fs.writeFile(path.join(root, "openclaw.mjs"), "export {};\n");
  process.argv[1] = path.join(root, "openclaw.mjs");
  delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
}
const ids = Array.from(
  { length: shape === "external" ? 44 : 40 },
  (_, index) => `synthetic-${String(index).padStart(2, "0")}`,
);
const paths: string[] = [];
for (const id of ids) {
  const dir = path.join(pluginRoot, id);
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
if (shape === "bundled-operations") {
  const dir = path.join(pluginRoot, ids[0]!);
  await fs.writeFile(
    path.join(dir, "runtime.mjs"),
    "import { createRequire } from 'node:module'; export const load = createRequire(import.meta.url);",
  );
  for (const name of ["state", "audit", "outbound-state", "trust-state"]) {
    await fs.writeFile(
      path.join(dir, `${name}-operation-api.cjs`),
      "module.exports = require('./runtime.mjs');",
    );
  }
}
async function importOwner(name: string): Promise<Record<string, unknown>> {
  if (runtime === "source") {
    return await import(`../../src/plugins/${name}.js`);
  }
  // Rolldown shortens export labels while preserving the owners' function names.
  const exports: Record<string, unknown> = {};
  const chunks = (await fs.readdir("dist")).filter(
    (file) => file.startsWith(`${name}-`) && file.endsWith(".mjs"),
  );
  assert(chunks.length > 0, `Build dist before measuring ${name}`);
  for (const chunk of chunks) {
    for (const value of Object.values(
      await import(pathToFileURL(path.resolve("dist", chunk)).href),
    )) {
      if (typeof value === "function") {
        exports[value.name] = value;
      }
    }
  }
  return exports;
}
// These benchmark-only imports select the same owner modules from source or their built graph.
const { loadOpenClawPluginsAsync } = (await importOwner(
  "loader-runtime-load",
)) as typeof import("../../src/plugins/loader-runtime-load.js");
const { createPluginCache, withPluginCache } = (await importOwner(
  "plugin-cache",
)) as typeof import("../../src/plugins/plugin-cache.js");
const { withPluginSourceCaptureStorage } = (await importOwner(
  "plugin-source-capture-context",
)) as typeof import("../../src/plugins/plugin-source-capture-context.js");
for (const owner of [
  loadOpenClawPluginsAsync,
  createPluginCache,
  withPluginCache,
  withPluginSourceCaptureStorage,
]) {
  assert.equal(typeof owner, "function");
}
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
  const heapBefore = process.memoryUsage().heapUsed;
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
            config: {
              plugins: {
                allow: ids,
                ...(shape === "external" ? { load: { paths } } : {}),
                entries: Object.fromEntries(ids.map((id) => [id, { enabled: true }])),
                slots: { memory: "none" },
              },
            },
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
  await nextTurn();
  global.gc();
  const heapAfter = process.memoryUsage().heapUsed;
  console.log(
    JSON.stringify({
      mode,
      shape,
      runtime,
      iterations,
      loadedPlugins: iterations * ids.length,
      captures: iterations * (shape === "external" ? ids.length : 1),
      hostLoad,
      hostLoadAfter: loadavg(),
      samples,
      sampledBytes,
      heapBefore,
      heapAfter,
      retainedBytes: heapAfter - heapBefore,
      babelLoaded: Object.keys(createRequire(import.meta.url).cache).some((filename) =>
        /jiti[/\\]dist[/\\]babel\.cjs$/u.test(filename),
      ),
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
