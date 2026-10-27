/**
 * Warm subagent cleanup registry acquisition through real plugin and prepared-runtime owners.
 * Run from each pinned revision (copy this unchanged script to the base if needed):
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/subagent-runtime-registry-measure.ts
 *   --mode candidate --iterations 2000 --plugins 40 --state-dir .local/lane1803
 *   --output .local/lane1803/candidate.json
 * --mode baseline calls the original synchronous loader, with the same awaited caller shape.
 * Repeat each arm with --allocations for a separate inspector-sampled allocation pass;
 * traced timings are context only. Alternate baseline/candidate launches and compare main-thread
 * CPU and allocated bytes per acquisition. Setup, publication, warmup and GC stay outside timing.
 * This is an owner microbenchmark, not a whole-Gateway load test or a model-turn measurement.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { parseArgs } from "node:util";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import type { PluginRegistry } from "../../src/plugins/registry-types.js";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.js";

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "candidate" },
    iterations: { type: "string", default: "2000" },
    plugins: { type: "string", default: "40" },
    "state-dir": { type: "string", default: ".local/lane1803" },
    output: { type: "string" },
    allocations: { type: "boolean", default: false },
  },
});
assert(values.mode === "baseline" || values.mode === "candidate", "Invalid --mode");
assert(global.gc, "Run with --expose-gc");
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  fallback: 2000,
  min: 1,
  label: "--iterations",
});
const pluginCount = parseStrictIntegerOption({
  raw: values.plugins,
  fallback: 40,
  min: 1,
  label: "--plugins",
});
const fixtureParent = path.resolve(values["state-dir"]);
await fs.mkdir(fixtureParent, { recursive: true });
const root = await fs.mkdtemp(path.join(fixtureParent, "registry-measure-"));
const stateDir = path.join(root, "state");
const workspaceDir = path.join(root, "workspace");
const agentDir = path.join(stateDir, "agents", "main", "agent");
const configPath = path.join(root, "openclaw.json");
for (const directory of [
  stateDir,
  workspaceDir,
  agentDir,
  path.join(root, "home"),
  path.join(root, "tmp"),
]) {
  await fs.mkdir(directory, { recursive: true });
}
Object.assign(process.env, {
  HOME: path.join(root, "home"),
  OPENCLAW_HOME: path.join(root, "home"),
  OPENCLAW_STATE_DIR: stateDir,
  OPENCLAW_CONFIG_PATH: configPath,
  OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
  TMPDIR: path.join(root, "tmp"),
});
delete process.env.OPENCLAW_AGENT_DIR;
delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;

const ids: string[] = [];
const paths: string[] = [];
const registrationEvent = "openclaw:perf:subagent-registry-registration";
let registrations = 0;
const onRegistration = () => registrations++;
process.on(registrationEvent, onRegistration);
for (let index = 0; index < pluginCount; index++) {
  const id = `cleanup-fixture-${index}`;
  const pluginDir = path.join(root, id);
  const entry = path.join(pluginDir, "index.cjs");
  const toolName = `cleanup_fixture_${index}`;
  await fs.mkdir(pluginDir);
  await fs.writeFile(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id,
      contracts: { tools: [toolName] },
      ...(index === 0 ? { providers: ["cleanup-fixture"] } : {}),
      configSchema: { type: "object", additionalProperties: false },
    }),
  );
  await fs.writeFile(
    entry,
    `module.exports = {
    id: ${JSON.stringify(id)},
    register(api) {
      process.emit(${JSON.stringify(registrationEvent)});
      ${index === 0 ? 'api.registerProvider({ id: "cleanup-fixture", label: "Synthetic provider", auth: [] });' : ""}
      api.registerTool({
        name: ${JSON.stringify(toolName)}, label: "Synthetic cleanup tool", description: "Fixture only",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        async execute() { throw new Error("Registry acquisition must not execute tools"); },
      });
    },
  };`,
  );
  ids.push(id);
  paths.push(entry);
}
const config: OpenClawConfig = {
  agents: {
    entries: { main: { workspace: workspaceDir } },
    defaults: { model: { primary: "cleanup-fixture/model" } },
  },
  models: {
    mode: "replace",
    providers: {
      "cleanup-fixture": {
        api: "openai-completions",
        apiKey: "synthetic-unused-key",
        baseUrl: "http://127.0.0.1:1/unused",
        models: [
          {
            id: "model",
            name: "Synthetic model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 8192,
            maxTokens: 1024,
          },
        ],
      },
    },
  },
  plugins: { allow: ids, load: { paths }, slots: { memory: "none" } },
};
await fs.writeFile(configPath, JSON.stringify(config));

const { setRuntimeConfigSnapshot } = await import("../../src/config/runtime-snapshot.js");
const { setGatewayPluginMetadataSnapshot } =
  await import("../../src/plugins/current-plugin-metadata-snapshot.js");
const { resolvePluginMetadataSnapshot } =
  await import("../../src/plugins/plugin-metadata-snapshot.js");
const { loadAndActivateRootPluginRegistry } = await import("../../src/plugins/loader.js");
const { createPluginRegistryOwner } = await import("../../src/plugins/runtime.js");
const { withPluginRuntimeRegistryScope } =
  await import("../../src/plugins/runtime/gateway-request-scope.js");
const { refreshPreparedModelRuntimeSnapshots, loadPublishedGatewayReplyDispatchRuntime } =
  await import("../../src/agents/prepared-model-runtime.js");
const { closePreparedModelRuntimeSnapshots } =
  await import("../../src/agents/prepared-model-runtime.lifecycle.js");
const { loadAgentRuntimePluginRegistryHandle } =
  await import("../../src/agents/runtime-plugins.js");
const { loadSubagentRegistryPluginRuntimeHandle } =
  await import("../../src/agents/subagents/registry/subagent-registry-deps.js");
const { drainGlobalSingletonLifecycleState } = await import("../../src/shared/global-singleton.js");
const inspector = new Session();
let owner: ReturnType<typeof createPluginRegistryOwner> | undefined;
function allocated(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((sum, child) => sum + allocated(child), 0);
}
try {
  setRuntimeConfigSnapshot(config);
  const metadataContext = { config, env: process.env, workspaceDir };
  const metadata = resolvePluginMetadataSnapshot(metadataContext);
  setGatewayPluginMetadataSnapshot(metadata, metadataContext);
  const registry = await loadAndActivateRootPluginRegistry({
    config,
    workspaceDir,
    metadataSnapshot: metadata,
    runtimeOptions: { allowGatewaySubagentBinding: true },
    throwOnLoadError: true,
  });
  owner = createPluginRegistryOwner(registry, workspaceDir);
  await withPluginRuntimeRegistryScope(owner.registry, () =>
    refreshPreparedModelRuntimeSnapshots(config, {
      gatewayLifecycle: true,
      catalogMode: "static",
      allowGatewaySubagentBinding: true,
      defaultWorkspaceDir: workspaceDir,
      pluginMetadataSnapshot: metadata,
    }),
  );
  const published = await loadPublishedGatewayReplyDispatchRuntime({ agentId: "main" });
  assert(published, "Configured runtime was not published");
  const input = {
    config,
    agentId: "main",
    agentDir,
    workspaceDir,
    allowGatewaySubagentBinding: true,
  };
  const acquire =
    values.mode === "baseline"
      ? async () => loadAgentRuntimePluginRegistryHandle(input)
      : () => loadSubagentRegistryPluginRuntimeHandle(input);
  let latest: PluginRegistry | undefined;
  for (let index = 0; index < 20; index++) {
    latest = await acquire();
  }
  assert(latest);
  assert.equal(latest.tools.length, pluginCount);
  if (values.mode === "candidate") {
    assert.equal(
      latest,
      published.inboundPluginRegistry,
      "Cleanup did not reuse its published generation",
    );
  }
  global.gc();
  await nextTurn();
  const beforeMemory = process.memoryUsage();
  const registrationsBefore = registrations;
  const hostLoadBefore = loadavg();
  if (values.allocations) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const processCpuBefore = process.cpuUsage();
  const threadCpuBefore = process.threadCpuUsage();
  const started = performance.now();
  for (let index = 0; index < iterations; index++) {
    latest = await acquire();
  }
  const elapsedMs = performance.now() - started;
  const threadCpu = process.threadCpuUsage(threadCpuBefore);
  const processCpu = process.cpuUsage(processCpuBefore);
  const profile = values.allocations
    ? (await inspector.post("HeapProfiler.stopSampling")).profile
    : undefined;
  assert(latest);
  assert.equal(latest.tools.length, pluginCount);
  const report = {
    mode: values.mode,
    instrumentation: values.allocations ? "sampled-allocation" : "untraced",
    iterations,
    pluginCount,
    elapsedMs,
    mainThreadCpuUsPerAcquisition: (threadCpu.user + threadCpu.system) / iterations,
    processCpuUsPerAcquisition: (processCpu.user + processCpu.system) / iterations,
    allocatedBytesPerAcquisition: profile ? allocated(profile.head) / iterations : undefined,
    registrationsBefore,
    registrationsDuringMeasurement: registrations - registrationsBefore,
    reusedPublishedRegistry: latest === published.inboundPluginRegistry,
    beforeMemory,
    afterMemory: process.memoryUsage(),
    hostLoadBefore,
    hostLoadAfter: loadavg(),
  };
  const json = JSON.stringify(report, null, 2);
  if (values.output) {
    const output = path.resolve(values.output);
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, `${json}\n`);
  }
  console.log(json);
} finally {
  inspector.disconnect();
  await closePreparedModelRuntimeSnapshots();
  await owner?.close();
  await drainGlobalSingletonLifecycleState();
  process.off(registrationEvent, onRegistration);
  await fs.rm(root, { recursive: true, force: true });
}
