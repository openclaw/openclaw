/**
 * Pricing preparation and lazy agent middleware on a 44-plugin synthetic generation.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/plugin-config-rederivation-measure.mjs
 *   --owner CHECKOUT --fixture-root SCRATCH --iterations 1000
 * Run five serial A1/B/A2 rounds. Acceptance: less CPU/allocation, identical results;
 * no affected metric regresses >20%. Cold and warm are reported separately.
 * Uses Node 26 cumulative allocation (including collected objects). For attribution,
 * run a separate --cpu-prof process. This is in-memory owner proof, not Gateway latency.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";

const { values } = parseArgs({
  options: {
    owner: { type: "string", default: process.cwd() },
    "fixture-root": { type: "string" },
    iterations: { type: "string", default: "1000" },
  },
});
assert(values["fixture-root"] && globalThis.gc, "Provide scratch --fixture-root and --expose-gc");
assert(Number.isFinite(getHeapStatistics().total_allocated_bytes), "Requires Node 26");
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
const owner = path.resolve(values.owner);
const load = (file) => import(pathToFileURL(path.join(owner, file)).href);
const files = [
  "src/model-catalog/pricing.ts",
  "src/plugins/config-state.ts",
  "src/plugins/loader-load-context.ts",
  "src/plugins/runtime/load-context.ts",
  "src/plugins/providers.runtime-core.ts",
];
const sourceHashes = Object.fromEntries(
  files.map((file) => [
    file,
    createHash("sha256")
      .update(fs.readFileSync(path.join(owner, file)))
      .digest("hex"),
  ]),
);
fs.mkdirSync(values["fixture-root"], { recursive: true });
const root = fs.mkdtempSync(path.join(values["fixture-root"], "plugin-config-"));
process.env.OPENCLAW_STATE_DIR = path.join(root, "state");
process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = "1";
const { createPluginCache, withPluginCache } = await load("src/plugins/plugin-cache.ts");
const { withPluginMetadataSnapshotScope } = await load(
  "src/plugins/current-plugin-metadata-snapshot.ts",
);
const { createPluginMetadataSnapshotFixture } = await load(
  "src/plugins/plugin-metadata.test-support.ts",
);
const { finalizePluginMetadataSnapshot } = await load("src/plugins/plugin-metadata-snapshot.ts");
const { projectInstalledPluginIndexPolicy } = await load("src/plugins/installed-plugin-index.ts");
const { prepareModelPricingContext, resolveModelPricing } = await load(
  "src/model-catalog/pricing.ts",
);
const { loadPluginRegistryHandle } = await load("src/plugins/loader.ts");
const { withPluginRuntimeRegistryScope } = await load(
  "src/plugins/runtime/gateway-request-scope.ts",
);
const { loadAgentToolResultMiddlewareRegistrationsForRuntime } = await load(
  "src/plugins/agent-tool-result-middleware-loader.ts",
);
const { disposePluginRegistryInstances } = await load("src/plugins/runtime.ts");
const { freezeJsonSnapshot } = await load("src/shared/immutable-data.ts");
const cache = createPluginCache();
const id = "fixture-0";
const pluginDir = path.join(root, id);
fs.mkdirSync(pluginDir);
const pluginFile = path.join(pluginDir, "index.cjs");
fs.writeFileSync(
  pluginFile,
  `module.exports = { id: '${id}', register(api) {
  api.registerAgentToolResultMiddleware(() => undefined, { runtimes: ['openclaw'] });
} };`,
);
fs.writeFileSync(
  path.join(pluginDir, "openclaw.plugin.json"),
  JSON.stringify({
    id,
    configSchema: { type: "object", additionalProperties: true },
    contracts: { agentToolResultMiddleware: ["openclaw"] },
  }),
);
const ids = Array.from({ length: 44 }, (_, i) => `fixture-${i}`);
const config = {
  agents: {
    list: Array.from({ length: 8 }, (_, i) => ({
      id: `agent-${i}`,
      workspace: path.join(root, `workspace-${i}`),
    })),
  },
  models: { catalogRefresh: { enabled: false } },
  plugins: {
    allow: ids,
    slots: { memory: "none" },
    load: { paths: [pluginFile] },
    entries: Object.fromEntries(
      ids.map((pluginId, i) => [
        pluginId,
        {
          enabled: true,
          config: { label: pluginId, rules: Array.from({ length: 8 }, (_, j) => `rule-${i}-${j}`) },
          hooks: { allowPromptModification: false },
          llm: { allowedModels: ["fixture/model"] },
        },
      ]),
    ),
  },
};
let registry;
try {
  const results = await withPluginCache(cache, async () => {
    const snapshot = createPluginMetadataSnapshotFixture({
      plugins: ids.map((pluginId) => ({
        id: pluginId,
        origin: "global",
        modelCatalog: {
          providers: { [pluginId]: { models: [{ id: "model", cost: { input: 7, output: 9 } }] } },
        },
      })),
    });
    snapshot.index.plugins = projectInstalledPluginIndexPolicy({
      plugins: snapshot.index.plugins,
      config,
      env: process.env,
    });
    finalizePluginMetadataSnapshot(snapshot);
    registry = loadPluginRegistryHandle({
      config: freezeJsonSnapshot(structuredClone(config)),
      onlyPluginIds: [id],
      loadModules: false,
      throwOnLoadError: true,
    });
    assert.equal(registry.agentToolResultMiddlewareOwners.length, 1);
    assert.equal(registry.agentToolResultMiddlewares.length, 0);
    let sequence = 0;
    const pricing = async () => {
      // A new enclosing config forces an actual build while sharing the plugin policy input.
      const context = await prepareModelPricingContext({
        ...config,
        messages: { ackReaction: String(sequence++) },
      });
      assert.equal(resolveModelPricing(context, `${id}/model`)?.input, 7);
    };
    const middleware = () =>
      withPluginRuntimeRegistryScope(registry, async () => {
        const registrations = await loadAgentToolResultMiddlewareRegistrationsForRuntime({
          runtime: "openclaw",
        });
        assert.equal(registrations.length, 1);
        assert.equal(registrations[0].pluginId, id);
      });
    async function measure(flow, operation, phase, count) {
      globalThis.gc();
      const hostLoad = loadavg();
      const allocation = getHeapStatistics().total_allocated_bytes;
      const main = process.threadCpuUsage();
      const cpu = process.cpuUsage();
      const start = performance.now();
      for (let i = 0; i < count; i++) {
        await operation();
      }
      const wallMs = performance.now() - start;
      const mainDelta = process.threadCpuUsage(main);
      const cpuDelta = process.cpuUsage(cpu);
      return {
        flow,
        phase,
        count,
        wallMs,
        mainCpuMs: (mainDelta.user + mainDelta.system) / 1000,
        processCpuMs: (cpuDelta.user + cpuDelta.system) / 1000,
        allocatedBytes: getHeapStatistics().total_allocated_bytes - allocation,
        hostLoad,
      };
    }
    const measurements = [];
    for (const [flow, operation] of [
      ["pricing", pricing],
      ["middleware", middleware],
    ]) {
      await withPluginMetadataSnapshotScope(
        snapshot,
        async () => {
          measurements.push(await measure(flow, operation, "cold", 1));
          for (let i = 0; i < 100; i++) {
            await operation();
          }
          measurements.push(await measure(flow, operation, "warm", iterations));
        },
        { config, trustConfigIdentity: true },
      );
    }
    return measurements;
  });
  console.log(
    JSON.stringify({ node: process.version, sourceHashes, plugins: ids.length, results }),
  );
} finally {
  if (registry) {
    await disposePluginRegistryInstances(registry);
  }
  await cache[Symbol.asyncDispose]();
  fs.rmSync(root, { recursive: true, force: true });
}
