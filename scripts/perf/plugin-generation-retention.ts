/**
 * Shared bundled CJS exports across fresh plugin generations, including module-level arrays.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/plugin-generation-retention.ts retention 25 40
 * Repeat with timing and allocation in separate processes; counts are plugin generations.
 * Append errors to measure auth-publication failures retaining synthetic 256 KiB build graphs:
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/plugin-generation-retention.ts retention 25 40 errors
 * Append decisions to retain a decision provider across sibling plugin replacements:
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/plugin-generation-retention.ts retention 20 40 decisions
 * Append retirement to retain native exports and closed reader scopes across registry disposal:
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/plugin-generation-retention.ts retention 20 40 retirement
 * Uses the real bundled module binder, registry records, invocation views, and physical disposal.
 * Fixtures live under .local and are removed afterward; no Gateway or operator state is accessed.
 * Acceptance: modules retain at most one adopted generation; other scenarios retain no payloads.
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
assert(["modules", "errors", "decisions", "retirement"].includes(scenario));
if (scenario === "retirement") {
  // Unbundled disposal has more frames than the production bundle.
  Reflect.set(Error, "stackTraceLimit", 50);
}
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
async function createDecisionWorkload() {
  const { createPluginRegistry } = await import("../../src/plugins/registry.js");
  const { createPluginRuntime } = await import("../../src/plugins/runtime/index.js");
  const { runPluginRegisterSyncInRegistry } =
    await import("../../src/plugins/loader-module-runtime.js");
  const { projectPluginContributions } =
    await import("../../src/plugins/registry-contributions.js");
  const { markPluginRegistryActive } = await import("../../src/plugins/registry-lifecycle.js");
  const { getPluginInstance } = await import("../../src/plugins/plugin-instance-scope.js");
  const { disposePluginRegistryInstances } = await import("../../src/plugins/runtime.js");
  const runtime = createPluginRuntime();
  class SiblingService {
    readonly id: string;
    constructor(id: string) {
      this.id = id;
    }
    start() {}
  }
  const decisionProvider = {
    id: "retained-decision",
    contractVersion: 2 as const,
    provider: { label: "Retention fixture", auth: [] },
    evaluate: async () => ({ status: "unavailable" as const, reason: "transport" as const }),
  };
  let current: ReturnType<typeof createEmptyPluginRegistry> | undefined;
  return async (track: boolean) => {
    const builder = createPluginRegistry({
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      runtime,
      activateGlobalSideEffects: false,
    });
    const retained = current?.plugins[0];
    if (current && retained) {
      builder.registry.plugins.push(retained);
      projectPluginContributions(current, retained, builder.registry);
    }
    for (let index = retained ? 0 : -1; index < pluginCount; index++) {
      const record = createPluginRecord({
        id: index < 0 ? "decision-owner" : `sibling-${index}`,
        source: path.join(root, `plugin-${index}.js`),
        origin: "bundled",
        enabled: true,
        configSchema: false,
        ...(index < 0 ? { contracts: { decisionProviders: [decisionProvider.id] } } : {}),
      });
      const api = builder.createApi(record, { config: {} });
      runPluginRegisterSyncInRegistry(
        () => {
          if (index < 0) {
            api.registerDecisionProvider(decisionProvider);
          } else {
            api.registerService(new SiblingService(record.id));
          }
        },
        api,
        builder.registry,
        record.id,
      );
      builder.registry.plugins.push(record);
    }
    assert.deepEqual(builder.registry.diagnostics, []);
    markPluginRegistryActive(builder.registry);
    if (current) {
      if (track) {
        instances.push(
          ...current.plugins.slice(1).map((record) => new WeakRef(getPluginInstance(record)!)),
        );
      }
      const result = await disposePluginRegistryInstances(current, builder.registry, { cfg: {} });
      assert.deepEqual(result.failures, []);
    }
    current = builder.registry;
  };
}
async function createRetirementWorkload() {
  const { disposePluginRegistryInstances } = await import("../../src/plugins/runtime.js");
  const { createSqliteReadOnlyWorkerScope } =
    await import("../../src/infra/sqlite-readonly-worker-context.js");
  // Native module values and inherited reader scopes can outlive retired generations.
  const nativeExports: string[][] = [];
  const readScopes: ReturnType<typeof createSqliteReadOnlyWorkerScope>[] = [];
  class GenerationService {
    readonly entries = Array.from({ length: 32768 }, (_, index) => index);
    readonly id: string;
    constructor(id: string) {
      this.id = id;
    }
    start() {}
  }
  return async (track: boolean) => {
    const registry = createEmptyPluginRegistry();
    const readers = createSqliteReadOnlyWorkerScope();
    readScopes.push(readers);
    for (let index = 0; index < pluginCount; index++) {
      const record = createPluginRecord({
        id: `retirement-${index}`,
        source: path.join(root, `retirement-${index}.js`),
        origin: "bundled",
        enabled: true,
        configSchema: false,
      });
      registry.plugins.push(record);
      const instance = new PluginInstance(record.id, { record, registry });
      const names = ["knowledge_learn"];
      instance.adopt(names);
      nativeExports.push(names);
      const service = new GenerationService(record.id);
      registry.services.push({
        id: record.id,
        pluginId: record.id,
        source: record.source,
        origin: "bundled",
        service,
      });
      if (track) {
        instances.push(new WeakRef(service));
      }
    }
    const beforeDispose = () => {
      assert.equal(registry.plugins.length, pluginCount);
      return readers.close();
    };
    const result = await disposePluginRegistryInstances(registry, undefined, {
      cfg: {},
      beforeDispose,
    });
    assert.deepEqual(result.failures, []);
    assert.equal(nativeExports.length, readScopes.length * pluginCount);
  };
}
const generation =
  scenario === "errors"
    ? await createErrorWorkload()
    : scenario === "decisions"
      ? await createDecisionWorkload()
      : scenario === "retirement"
        ? await createRetirementWorkload()
        : moduleGeneration;
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
  const totalStarted = performance.now();
  const totalCpuStarted = process.threadCpuUsage();
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
  const totalCpu = process.threadCpuUsage(totalCpuStarted);
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
      totalWallMs: performance.now() - totalStarted,
      totalThreadCpuMs: (totalCpu.user + totalCpu.system) / 1000,
      maxRssKiB: process.resourceUsage().maxRSS,
      sampledBytes,
      bytesPerOperation: sampledBytes === undefined ? undefined : sampledBytes / instances.length,
      initial,
      final,
      checkpoints,
    }),
  );
  assert(
    final.liveTrackedObjects <= (scenario === "modules" ? pluginCount : 0),
    "Retired graphs remain",
  );
  if ((scenario === "decisions" || scenario === "retirement") && mode === "retention") {
    assert(
      final.memory.heapUsed - initial.memory.heapUsed <= 32 * 1024 * 1024,
      "Post-GC reload heap grew beyond the 32 MiB budget",
    );
  }
} finally {
  inspector.disconnect();
  fs.rmSync(root, { recursive: true, force: true });
}
