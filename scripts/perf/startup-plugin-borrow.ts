// Forty real no-op plugins: global Gateway startup followed by first-workspace preparation.
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/startup-plugin-borrow.ts timing 5000
// Repeat with allocation in separate processes, alternating base/candidate. --owner-module
// selects a saved inbound-registry owner with relative imports resolved to this checkout.
// Root metadata belongs to the first workspace, while the root load has no workspace, as at
// Gateway startup. Use the production lifecycle-batch loader, including its identity cache.
// Initial preparation and 100-warmup/5000-call acquisition are separate; warm calls may be
// neutral. Sampled allocation includes collected main-isolate objects;
// worker allocation and whole-Gateway peak RSS/readiness require the startup measurement.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import type { PluginRegistry } from "../../src/plugins/registry-types.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { "owner-module": { type: "string" } },
});
const [mode = "timing", rawIterations = "5000"] = positionals;
const iterations = Number(rawIterations);
assert(mode === "timing" || mode === "allocation");
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(global.gc, "Run with --expose-gc");
const parent = path.resolve(".local/startup-plugin-borrow");
await fs.mkdir(parent, { recursive: true });
const fixture = await fs.mkdtemp(path.join(parent, "run-"));
const workspaceDir = path.join(fixture, "workspace");
const configPath = path.join(fixture, "openclaw.json");
for (const dir of ["workspace", "state", "home", "tmp"]) {
  await fs.mkdir(path.join(fixture, dir));
}
Object.assign(process.env, {
  HOME: path.join(fixture, "home"),
  OPENCLAW_HOME: path.join(fixture, "home"),
  OPENCLAW_STATE_DIR: path.join(fixture, "state"),
  OPENCLAW_CONFIG_PATH: configPath,
  OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
  TMPDIR: path.join(fixture, "tmp"),
});
delete process.env.OPENCLAW_AGENT_DIR;
delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
const ids = Array.from({ length: 40 }, (_, index) => `startup-borrow-${index}`);
const paths: string[] = [];
const event = "openclaw:perf:startup-plugin-borrow";
let registrations = 0;
const onRegistration = () => registrations++;
process.on(event, onRegistration);
for (const id of ids) {
  const directory = path.join(fixture, id);
  await fs.mkdir(directory);
  await fs.writeFile(
    path.join(directory, "openclaw.plugin.json"),
    JSON.stringify({
      id,
      activation: { onStartup: true },
      configSchema: { type: "object", additionalProperties: false },
    }),
  );
  const entry = path.join(directory, "index.cjs");
  await fs.writeFile(
    entry,
    `module.exports = { id: ${JSON.stringify(id)}, register() { process.emit(${JSON.stringify(event)}); } };`,
  );
  paths.push(entry);
}
const config: OpenClawConfig = {
  plugins: {
    allow: ids,
    load: { paths },
    slots: { memory: "none" },
    entries: Object.fromEntries(ids.map((id) => [id, { enabled: true }])),
  },
};
await fs.writeFile(configPath, JSON.stringify(config));

// Import runtime owners after installing the isolated environment.
const { loadAndActivateRootPluginRegistry } = await import("../../src/plugins/loader.js");
const { createPluginCache, withPluginCache } = await import("../../src/plugins/plugin-cache.js");
const { loadPluginMetadataSnapshot } =
  await import("../../src/plugins/plugin-metadata-snapshot.js");
const { createPluginRegistryOwner, disposePluginRegistryInstances } =
  await import("../../src/plugins/runtime.js");
const { withPluginRuntimeRegistryScope } =
  await import("../../src/plugins/runtime/gateway-request-scope.js");
const { getPluginRuntimeLoadContext } = await import("../../src/plugins/runtime/load-context.js");
const { drainGlobalSingletonLifecycleState } = await import("../../src/shared/global-singleton.js");
const moduleUrl = values["owner-module"]
  ? pathToFileURL(path.resolve(values["owner-module"]))
  : new URL("../../src/agents/prepared-model-runtime.inbound-registry.ts", import.meta.url);
const { createPreparedInboundRegistryLoader } = (await import(
  moduleUrl.href
)) as typeof import("../../src/agents/prepared-model-runtime.inbound-registry.js");

function checkRegistry(registry: PluginRegistry) {
  assert.deepEqual(
    registry.plugins
      .filter((plugin) => plugin.status === "loaded")
      .map((plugin) => plugin.id)
      .toSorted(),
    ids.toSorted(),
  );
}

async function measure(count: number, acquire: () => PluginRegistry) {
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
    const registrationsBefore = registrations;
    const threadCpu = process.threadCpuUsage();
    const processCpu = process.cpuUsage();
    const start = performance.now();
    let registry: PluginRegistry | undefined;
    for (let call = 0; call < count; call++) {
      registry = acquire();
    }
    const wallMs = performance.now() - start;
    const threadUsed = process.threadCpuUsage(threadCpu);
    const processUsed = process.cpuUsage(processCpu);
    const after = process.memoryUsage();
    let sampledBytes: number | undefined;
    if (mode === "allocation") {
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      sampledBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
    }
    await nextTurn();
    await nextTurn();
    observer.disconnect();
    assert(registry);
    checkRegistry(registry);
    return {
      iterations: count,
      hostLoad,
      wallMs,
      mainThreadCpuMs: (threadUsed.user + threadUsed.system) / 1000,
      processCpuMs: (processUsed.user + processUsed.system) / 1000,
      sampledBytes,
      bytesPerOperation: sampledBytes === undefined ? undefined : sampledBytes / count,
      registrations: registrations - registrationsBefore,
      gc:
        mode === "timing"
          ? {
              count: gcDurations.length,
              totalMs: gcDurations.reduce((sum, ms) => sum + ms, 0),
              maxMs: Math.max(0, ...gcDurations),
            }
          : undefined,
      memory: { before, after },
    };
  } finally {
    observer.disconnect();
    inspector.disconnect();
  }
}

try {
  await using cache = createPluginCache();
  await withPluginCache(cache, async () => {
    const metadata = loadPluginMetadataSnapshot({ config, workspaceDir });
    const root = await loadAndActivateRootPluginRegistry({
      config,
      metadataSnapshot: metadata,
      onlyPluginIds: ids,
      runtimeOptions: { allowGatewaySubagentBinding: true },
      cache: false,
      throwOnLoadError: true,
    });
    const owner = createPluginRegistryOwner(root);
    let prepared: PluginRegistry | undefined;
    try {
      checkRegistry(root);
      assert.equal(metadata.workspaceDir, workspaceDir);
      assert.equal(getPluginRuntimeLoadContext(root)?.workspaceDir, undefined);
      const input = { config, workspaceDir, allowGatewaySubagentBinding: true };
      await withPluginRuntimeRegistryScope(root, async () => {
        const loadInbound = createPreparedInboundRegistryLoader();
        const acquire = () => (prepared = loadInbound(input, metadata, []));
        global.gc!();
        await nextTurn();
        const initial = await measure(1, acquire);
        assert(prepared);
        const firstPrepared = prepared;
        const borrowedRecords = prepared.plugins.filter((plugin) =>
          root.plugins.includes(plugin),
        ).length;
        for (let call = 0; call < 100; call++) {
          acquire();
        }
        global.gc!();
        await nextTurn();
        const warm = await measure(iterations, acquire);
        assert.equal(prepared, firstPrepared, "Exact batch identity must retain its registry");
        assert.equal(warm.registrations, 0);
        global.gc!();
        console.log(
          JSON.stringify({
            mode,
            node: process.version,
            plugins: ids.length,
            warmup: 100,
            borrowedRecords,
            rootRecords: root.plugins.length,
            initial,
            warm,
            retainedHeapBytes: process.memoryUsage().heapUsed,
          }),
        );
      });
    } finally {
      if (prepared) {
        await disposePluginRegistryInstances(prepared, root);
      }
      await owner.close();
    }
  });
} finally {
  process.off(event, onRegistration);
  await drainGlobalSingletonLifecycleState();
  await fs.rm(fixture, { recursive: true, force: true });
}
