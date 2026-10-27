/**
 * Shared bundled CJS exports across fresh plugin generations, including module-level arrays.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/plugin-generation-retention.ts retention 25 40
 * Repeat with timing and allocation in separate processes; counts are plugin generations.
 * Append errors to measure auth-publication failures retaining synthetic 256 KiB build graphs:
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/plugin-generation-retention.ts retention 25 40 errors
 * Uses the real bundled module binder, registry records, invocation views, and physical disposal.
 * Fixtures live under .local and are removed afterward; no Gateway or operator state is accessed.
 * Acceptance: retired-instance count stays bounded by one generation of adopted shared values.
 * Timing excludes census GC; allocation samples include collected objects. Compare matched modes.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { createRequire } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { queryObjects } from "node:v8";

const [mode = "retention", rawGenerations = "25", rawPlugins = "40", scenario = "modules"] =
  process.argv.slice(2);
const generations = Number(rawGenerations);
const pluginCount = Number(rawPlugins);
assert(["retention", "timing", "allocation"].includes(mode));
assert(["modules", "errors"].includes(scenario));
assert(Number.isSafeInteger(generations) && generations > 0);
assert(Number.isSafeInteger(pluginCount) && pluginCount > 0);
assert(global.gc, "Run with --expose-gc");
fs.mkdirSync(".local", { recursive: true });
const root = fs.mkdtempSync(path.resolve(".local/plugin-generation-retention-"));
process.env.OPENCLAW_HOME = root;
process.env.OPENCLAW_STATE_DIR = path.join(root, "state");
const { createPluginRecord } = await import("../../src/plugins/loader-records.js");
const { createPluginCache, retirePluginCache, withPluginCache } =
  await import("../../src/plugins/plugin-cache.js");
const { bindPluginInstanceModuleLoader } =
  await import("../../src/plugins/plugin-instance-module-loader.js");
const { PluginInstance } = await import("../../src/plugins/plugin-instance.js");
const { createEmptyPluginRegistry } = await import("../../src/plugins/registry-empty.js");
const require = createRequire(import.meta.url);
type FixtureExports = { names: string[]; execute(): string };
const sources = Array.from({ length: scenario === "modules" ? pluginCount : 0 }, (_, index) => {
  const id = `retention-${index}`;
  const rootDir = path.join(root, id);
  fs.mkdirSync(rootDir);
  const source = path.join(rootDir, "index.cjs");
  fs.writeFileSync(
    source,
    'const names = ["knowledge_learn"]; module.exports = { names, execute: () => names[0] };',
  );
  // Evaluate once outside instance scope, as process-retained bundled CJS code.
  const exported = require(source) as FixtureExports;
  return { id, rootDir, source, exported };
});
const instances: WeakRef<object>[] = [];
async function moduleGeneration(track: boolean) {
  const cache = createPluginCache();
  const registry = createEmptyPluginRegistry();
  try {
    for (const fixture of sources) {
      const record = createPluginRecord({
        ...fixture,
        origin: "bundled",
        enabled: true,
        configSchema: false,
      });
      registry.plugins.push(record);
      const instance = new PluginInstance(record.id, { record, registry });
      if (track) {
        instances.push(new WeakRef(instance));
      }
      try {
        withPluginCache(cache, () =>
          bindPluginInstanceModuleLoader({
            instance,
            rootDir: fixture.rootDir,
            source: fixture.source,
            origin: "bundled",
          }),
        );
        const view = instance.loadModule(fixture.source) as FixtureExports;
        assert.equal(view.execute(), "knowledge_learn");
        assert.deepEqual(Array.from(view.names), ["knowledge_learn"]);
        instance.adopt(fixture.exported.names);
      } finally {
        assert.deepEqual((await instance.dispose()).errors, []);
      }
    }
  } finally {
    await retirePluginCache(cache);
  }
}
async function createErrorWorkload() {
  const { PreparedModelRuntimeAuthPublicationOwner } =
    await import("../../src/agents/prepared-model-runtime-auth-publication.js");
  const { prepareModelRuntimeOwner, ownerKey } =
    await import("../../src/agents/prepared-model-runtime.owner.js");
  const publication = new PreparedModelRuntimeAuthPublicationOwner();
  const ownerList = Array.from({ length: pluginCount }, (_, index) =>
    prepareModelRuntimeOwner(
      { config: {}, agentDir: path.join(root, `agent-${index}`), agentId: `agent-${index}` },
      "configured",
      "static",
    ),
  );
  const owners = new Map(ownerList.map((owner) => [ownerKey(owner.input), owner]));
  return async (track: boolean) => {
    for (const owner of ownerList) {
      const build = { entries: Array.from({ length: 32768 }, (_, index) => index) };
      const failure = new Error("synthetic refresh failure", { cause: build });
      if (track) {
        instances.push(new WeakRef(build));
      }
      publication.enqueue([owner]);
      const pending = owner.pending!.catch(() => {});
      await publication.drain({
        owners,
        publish: async () => {
          throw failure;
        },
        publishOwners: () => {},
      });
      await pending;
      assert.equal(owner.refreshError?.message, failure.message);
      assert.equal(owner.catalogRecovery?.error, owner.refreshError);
    }
  };
}
const generation = scenario === "errors" ? await createErrorWorkload() : moduleGeneration;
async function census() {
  await setImmediate();
  // queryObjects performs a full GC, including ephemeron processing.
  const totalInstances = queryObjects(PluginInstance);
  return {
    liveTrackedObjects: instances.filter((reference) => reference.deref() !== undefined).length,
    totalInstances,
    memory: process.memoryUsage(),
  };
}
const inspector = new Session();
try {
  await generation(false);
  const initial = await census();
  if (mode === "allocation") {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const hostLoad = loadavg();
  let wallMs = 0;
  let threadCpuMs = 0;
  const checkpoints = [];
  for (let index = 0; index < generations; index++) {
    const started = performance.now();
    const cpu = process.threadCpuUsage();
    await generation(true);
    const used = process.threadCpuUsage(cpu);
    wallMs += performance.now() - started;
    threadCpuMs += (used.user + used.system) / 1000;
    if (mode === "retention" && ((index + 1) % 5 === 0 || index + 1 === generations)) {
      checkpoints.push({ generation: index + 1, ...(await census()) });
    }
  }
  let sampledBytes: number | undefined;
  if (mode === "allocation") {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    sampledBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
  }
  const final = await census();
  console.log(
    JSON.stringify({
      mode,
      scenario,
      generations,
      pluginCount,
      iterations: generations * pluginCount,
      hostLoad,
      wallMs,
      threadCpuMs,
      sampledBytes,
      bytesPerOperation: sampledBytes === undefined ? undefined : sampledBytes / instances.length,
      initial,
      final,
      checkpoints,
    }),
  );
  assert(
    final.liveTrackedObjects <= (scenario === "errors" ? 0 : pluginCount),
    "Retired graphs remain",
  );
} finally {
  inspector.disconnect();
  fs.rmSync(root, { recursive: true, force: true });
}
