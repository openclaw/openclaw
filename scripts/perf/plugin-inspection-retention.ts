// Run with an isolated HOME/OPENCLAW_STATE_DIR and node --expose-gc --import ./scripts/tsx.mjs.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    generations: { type: "string", default: "20" },
    plugins: { type: "string", default: "44" },
    gateway: { type: "boolean", default: false },
    port: { type: "string", default: "41660" },
  },
});
const generations = Number(values.generations);
const pluginCount = Number(values.plugins);
assert(Number.isSafeInteger(generations) && generations > 0);
assert(Number.isSafeInteger(pluginCount) && pluginCount > 0);
const port = Number(values.port);
assert(Number.isSafeInteger(port) && port >= 40000 && port <= 65535);
assert(global.gc, "Run with --expose-gc");
const stateDir = process.env.OPENCLAW_STATE_DIR;
assert(stateDir && process.env.HOME, "Set isolated HOME and OPENCLAW_STATE_DIR");
process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = "1";
const root = await fs.mkdtemp(path.join(stateDir, "inspection-retention-"));
process.env.OPENCLAW_CONFIG_PATH = path.join(root, "openclaw.json");
const key = Symbol.for("openclaw.perf.inspectionRetention");
const { acquirePluginRegistryForInspection } = await import("../../src/plugins/loader.js");
const { getPluginCache } = await import("../../src/plugins/plugin-cache.js");
const { getPluginRegistryInspectionResources } =
  await import("../../src/plugins/registry-inspection-resources.js");
type Inspection = Awaited<ReturnType<typeof acquirePluginRegistryForInspection>>;
type Cache = ReturnType<typeof getPluginCache>;
const caches: WeakRef<Cache>[] = [];
let registrations = 0;
let disposals = 0;
let pendingDisposal: Promise<void> | undefined;
let disposalStarted: (() => void) | undefined;
Object.defineProperty(globalThis, key, {
  configurable: true,
  value: {
    register(index: number) {
      registrations++;
      if (index === 0) {
        caches.push(new WeakRef(getPluginCache()));
      }
    },
    async dispose(index: number) {
      if (index === 0 && pendingDisposal) {
        disposalStarted?.();
        await pendingDisposal;
      }
      disposals++;
    },
  },
});
const paths: string[] = [];
const ids: string[] = [];
for (let index = 0; index < pluginCount; index++) {
  const id = `retention-${index}`;
  const pluginRoot = path.join(root, id);
  await fs.mkdir(pluginRoot);
  const entry = path.join(pluginRoot, "index.cjs");
  await fs.writeFile(
    path.join(pluginRoot, "openclaw.plugin.json"),
    JSON.stringify({ id, configSchema: { type: "object", additionalProperties: false } }),
  );
  await fs.writeFile(
    entry,
    `module.exports = { id: ${JSON.stringify(id)}, register(api) {
      const probe = globalThis[Symbol.for("openclaw.perf.inspectionRetention")];
      probe.register(${index});
      api.registerRuntimeLifecycle({ id: "retention", dispose: () => probe.dispose(${index}) });
    } };`,
  );
  paths.push(entry);
  ids.push(id);
}
const config = { plugins: { allow: ids, load: { paths }, slots: { memory: "none" } } };
async function acquire() {
  const previous = caches.length;
  const inspection = await acquirePluginRegistryForInspection({ config, throwOnLoadError: true });
  assert.equal(
    inspection.registry.plugins.filter((plugin) => plugin.status === "loaded").length,
    pluginCount,
  );
  assert.equal(caches.length, previous + 1, "Each generation must register a fresh inspection");
  return inspection;
}
async function collect() {
  for (let pass = 0; pass < 4; pass++) {
    await nextTurn();
    global.gc!();
  }
  return process.memoryUsage().heapUsed;
}
function alive(references: WeakRef<Cache>[]) {
  return references.filter((reference) => reference.deref()).length;
}
const held: Inspection[] = [];
let gateway: { close: () => Promise<void> } | undefined;
try {
  if (values.gateway) {
    const { BASE_GATEWAY_BENCH_CONFIG } = await import("../lib/gateway-bench-runtime.js");
    await fs.writeFile(
      process.env.OPENCLAW_CONFIG_PATH,
      JSON.stringify({
        ...BASE_GATEWAY_BENCH_CONFIG,
        ...config,
        agents: { entries: { main: { workspace: path.join(root, "workspace") } } },
        cron: { enabled: false },
      }),
    );
    const { startGatewayServer } = await import("../../src/gateway/server.js");
    gateway = await startGatewayServer(port, { bind: "loopback", controlUiEnabled: false });
  }
  // Warm the loader independently of the generations whose handles remain reachable.
  await (await acquire()).release();
  caches.length = 0;
  const heapBefore = await collect();
  const started = performance.now();
  for (let generation = 0; generation < generations; generation++) {
    const inspection = await acquire();
    held.push(inspection);
    await inspection.release();
  }
  const heapAfter = await collect();
  const retainedCaches = alive(caches);
  const borrowed = await acquire();
  held.push(borrowed);
  const borrower = getPluginRegistryInspectionResources(borrowed.registry)!.retain();
  const borrowedCache = caches.at(-1)!;
  await borrowed.release();
  await collect();
  assert(borrowedCache.deref(), "Borrower lost its inspection cache before physical disposal");
  await borrower.release();
  await collect();
  const borrowedCacheAfterRelease = Boolean(borrowedCache.deref());
  const paused = await acquire();
  held.push(paused);
  const pausedCache = caches.at(-1)!;
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  pendingDisposal = gate.promise;
  disposalStarted = entered.resolve;
  const release = paused.release();
  await entered.promise;
  await collect();
  assert(pausedCache.deref(), "Pending disposal lost its inspection cache");
  gate.resolve();
  await release;
  pendingDisposal = undefined;
  disposalStarted = undefined;
  await collect();
  const pausedCacheAfterRelease = Boolean(pausedCache.deref());
  console.log(
    JSON.stringify(
      {
        generations,
        pluginCount,
        gateway: values.gateway,
        heldHandles: held.length,
        registrations,
        disposals,
        durationMs: performance.now() - started,
        heapBefore,
        heapAfter,
        retainedHeapDelta: heapAfter - heapBefore,
        retainedCaches,
        borrowedCacheAfterRelease,
        pausedCacheAfterRelease,
      },
      null,
      2,
    ),
  );
  // Keep handles alive through the final collection and observations.
  assert.equal(held.length, generations + 2);
} finally {
  await gateway?.close();
  Reflect.deleteProperty(globalThis, key);
  await fs.rm(root, { recursive: true, force: true });
}
