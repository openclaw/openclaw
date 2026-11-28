/**
 * Pricing preparation and agent tool results on a 44-plugin synthetic generation.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/plugin-config-rederivation-measure.mjs
 *   --owner CHECKOUT --fixture-root SCRATCH --iterations 1000
 * Run five serial A1/B/A2 rounds. For tool results, select --flow middleware.
 * Acceptance: unchanged output, zero warm loader and config-key calls, lower warm CPU and
 * allocations, and no >20% cold regression. Cold includes preparation and the first result.
 * Run with --counts separately for a short call-count sample without profiling the timed runs.
 * Uses Node 26 cumulative allocation (including collected objects). For attribution,
 * run a separate --cpu-prof process. This is in-memory owner proof, not Gateway latency.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
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
    flow: { type: "string", default: "all" },
    counts: { type: "boolean" },
  },
});
assert(values["fixture-root"] && globalThis.gc, "Provide scratch --fixture-root and --expose-gc");
assert(Number.isFinite(getHeapStatistics().total_allocated_bytes), "Requires Node 26");
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(["all", "pricing", "middleware"].includes(values.flow));
const owner = path.resolve(values.owner);
const load = (file) => import(pathToFileURL(path.join(owner, file)).href);
const files = [
  "src/model-catalog/pricing.ts",
  "src/plugins/config-state.ts",
  "src/plugins/loader-load-context.ts",
  "src/plugins/runtime/load-context.ts",
  "src/plugins/providers.runtime-core.ts",
  "src/agents/harness/tool-result-middleware.ts",
  "src/plugins/gateway-startup-plugin-activation.ts",
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
const { withPluginRuntimeRegistryScope } = await load(
  "src/plugins/runtime/gateway-request-scope.ts",
);
const { createAgentToolResultMiddlewareRunner } = await load(
  "src/agents/harness/tool-result-middleware.ts",
);
const { prepareGatewayPluginLoad } = await load("src/gateway/server-plugin-bootstrap.ts");
const { disposePluginRegistryInstances } = await load("src/plugins/runtime.ts");
const cache = createPluginCache();
const id = "fixture-0";
const ids = Array.from({ length: 44 }, (_, i) => `fixture-${i}`);
const pluginFiles = ids.map((pluginId, i) => {
  const dir = path.join(root, pluginId);
  fs.mkdirSync(dir);
  fs.writeFileSync(
    path.join(dir, "openclaw.plugin.json"),
    JSON.stringify({
      id: pluginId,
      configSchema: { type: "object", additionalProperties: true },
      ...(i < 2
        ? {
            activation: { onStartup: i === 1 },
            contracts: { agentToolResultMiddleware: ["codex"] },
          }
        : {}),
    }),
  );
  const source = path.join(dir, "index.cjs");
  const register =
    i === 0
      ? `api.registerAgentToolResultMiddleware((event) => ({
    result: { ...event.result, content: [{ type: "text", text: "compacted" }] },
  }), { matcher: ["exec"] });`
      : i === 1
        ? `api.registerAgentToolResultMiddleware(() => undefined, { matcher: ["read"] });`
        : "";
  fs.writeFileSync(
    source,
    `module.exports = { id: ${JSON.stringify(pluginId)}, register(api) { ${register} } };`,
  );
  return source;
});
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
    load: { paths: pluginFiles },
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
let loaded;
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
    let sequence = 0;
    const pricing = async () => {
      // A new enclosing config forces an actual build while sharing the plugin policy input.
      const context = await prepareModelPricingContext({
        ...config,
        messages: { ackReaction: String(sequence++) },
      });
      assert.equal(resolveModelPricing(context, `${id}/model`)?.input, 7);
    };
    const event = {
      toolName: "exec",
      toolCallId: "benchmark",
      args: {},
      result: { content: [{ type: "text", text: "raw output" }], details: {} },
    };
    const middleware = async () => {
      const { applyToolResultMiddleware } = createAgentToolResultMiddlewareRunner({
        runtime: "codex",
      });
      assert.equal((await applyToolResultMiddleware(event)).content[0]?.text, "compacted");
    };
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
    if (values.flow !== "middleware") {
      await withPluginMetadataSnapshotScope(
        snapshot,
        async () => {
          measurements.push(await measure("pricing", pricing, "cold", 1));
          for (let i = 0; i < 100; i++) {
            await pricing();
          }
          measurements.push(await measure("pricing", pricing, "warm", iterations));
        },
        { config, trustConfigIdentity: true },
      );
    }
    if (values.flow !== "pricing") {
      // The first result uses the registry just published by the preparation owner.
      const cold = await measure(
        "middleware",
        async () => {
          loaded = await prepareGatewayPluginLoad({
            cfg: config,
            baseMethods: [],
            log: { debug() {}, info() {}, warn() {}, error() {} },
            loadIntent: "startup",
            ambientEnvTriggers: "suppress",
          });
          await withPluginRuntimeRegistryScope(loaded.pluginRegistry, middleware);
        },
        "cold",
        1,
      );
      measurements.push(cold);
      await withPluginRuntimeRegistryScope(loaded.pluginRegistry, async () => {
        for (let i = 0; i < 100; i++) {
          await middleware();
        }
        if (!values.counts) {
          measurements.push(await measure("middleware", middleware, "warm", iterations));
          return;
        }
        const inspector = new Session();
        // A short window keeps recompiled function counters from being lost to V8 GC.
        const count = Math.min(iterations, 100);
        inspector.connect();
        try {
          await inspector.post("Profiler.enable");
          await inspector.post("Profiler.startPreciseCoverage", {
            callCount: true,
            detailed: true,
          });
          for (let i = 0; i < count; i++) {
            await middleware();
          }
          const { result } = await inspector.post("Profiler.takePreciseCoverage");
          const counts = {
            loadPluginRegistryHandle: 0,
            loadOpenClawPlugins: 0,
            resolvePluginLoadCacheContext: 0,
            resolvePreparedPluginRegistrationConfigKey: 0,
            resolvePluginRegistrationConfigKey: 0,
          };
          for (const { functions } of result) {
            for (const { functionName, ranges } of functions) {
              if (Object.hasOwn(counts, functionName)) {
                counts[functionName] += ranges[0].count;
              }
            }
          }
          measurements.push({
            flow: "middleware",
            phase: "warm-counts",
            count,
            counts,
          });
        } finally {
          inspector.disconnect();
        }
      });
    }
    return measurements;
  });
  console.log(
    JSON.stringify({ node: process.version, sourceHashes, plugins: ids.length, results }),
  );
} finally {
  if (loaded) {
    loaded.retireGatewayRuntimeBindings();
    await disposePluginRegistryInstances(loaded.pluginRegistry);
  }
  await cache[Symbol.asyncDispose]();
  fs.rmSync(root, { recursive: true, force: true });
}
