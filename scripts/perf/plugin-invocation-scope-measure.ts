// Run on the approved benchmark host with an isolated HOME and --state-dir.
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { writeSync } from "node:fs";
import fs from "node:fs/promises";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import path from "node:path";
import {
  constants,
  monitorEventLoopDelay,
  PerformanceObserver,
  type PerformanceEntry,
} from "node:perf_hooks";
import { mock } from "node:test";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { expectDefined } from "../../packages/normalization-core/src/expect.ts";
import type { ContextEngineFactoryResources } from "../../src/context-engine/registry.resources.js";
import type { ContextEngine } from "../../src/context-engine/types.js";
import { GATEWAY_GC_TRACE_MARKER, readGatewayGcTrace } from "../lib/gateway-bench-profile.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "timing" },
    operations: { type: "string", default: "4000" },
    warmup: { type: "string", default: "100" },
    plugins: { type: "string", default: "44" },
    calls: { type: "string", default: "16" },
    "yield-ms": { type: "string", default: "1" },
    gateway: { type: "boolean", default: false },
    port: { type: "string", default: "41665" },
    "state-dir": { type: "string" },
    "start-at": { type: "string", default: "0" },
    "start-file": { type: "string" },
    "ready-file": { type: "string" },
    "warm-start-file": { type: "string" },
    "warm-ready-file": { type: "string" },
    "gc-log": { type: "string" },
    output: { type: "string" },
  },
});
const integer = (
  name: "operations" | "warmup" | "plugins" | "calls" | "yield-ms" | "port" | "start-at",
  min: number,
) => parseStrictIntegerOption({ raw: values[name], label: `--${name}`, min, fallback: min });
const operations = integer("operations", 1);
const warmup = integer("warmup", 0);
const pluginCount = integer("plugins", 1);
const calls = integer("calls", 1);
const yieldMs = integer("yield-ms", 0);
const port = integer("port", 40000);
assert(port <= 65535);
assert(["count", "allocation", "timing", "promotion"].includes(values.mode!));
assert(global.gc, "Run with --expose-gc");
assert(values["state-dir"] && process.env.HOME, "Set --state-dir and an isolated HOME");
assert(
  values.mode !== "timing" || !process.execArgv.some((arg) => arg.startsWith("--trace-gc")),
  "Timing must be untraced",
);
assert(
  values.mode !== "promotion" || values["gc-log"],
  "Promotion requires --gc-log and --trace-gc-nvp",
);
const stateDir = path.resolve(values["state-dir"]);
await fs.mkdir(stateDir, { recursive: true });
const root = await fs.mkdtemp(path.join(stateDir, "invocation-scope-"));
process.env.OPENCLAW_STATE_DIR = root;
process.env.OPENCLAW_CONFIG_PATH = path.join(root, "openclaw.json");
process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = "1";
const profilePath = path.resolve(
  `${values.output ?? path.join(stateDir, "allocation")}.heapprofile`,
);
const marker = (phase: string) =>
  writeSync(
    1,
    `${GATEWAY_GC_TRACE_MARKER}${JSON.stringify({ phase, pid: process.pid, profilePath })}\n`,
  );
// Identify the main isolate before Gateway startup introduces worker isolates.
if (values.mode === "promotion") {
  marker("identify-start");
  global.gc();
  marker("identify-stop");
}

const { LegacyContextEngine } = await import("../../src/context-engine/legacy.js");
const {
  retainLogicalTurnContextEngineSources,
  resolveContextEngineFactory,
  disposeContextEngineSources,
} = await import("../../src/context-engine/registry.resources.js");
const { getPluginRuntimeGatewayRequestScope, withPluginRuntimeRegistryScope } =
  await import("../../src/plugins/runtime/gateway-request-scope.js");
const { getPluginInstance } = await import("../../src/plugins/plugin-instance-scope.js");
const { PluginInstance } = await import("../../src/plugins/plugin-instance.js");
const { withPluginRetentionOwner } =
  await import("../../src/plugins/plugin-retention-diagnostics.js");
const { acquirePluginRegistryForInspection } = await import("../../src/plugins/loader.js");
type Registry = Awaited<ReturnType<typeof acquirePluginRegistryForInspection>>["registry"];
let registry: Registry;
let factories = 0;
let assemblies = 0;
let disposals = 0;
let nested = () => {};
function assertOwner() {
  const scope = getPluginRuntimeGatewayRequestScope();
  assert.equal(scope?.pluginId, "invocation-0");
  assert.equal(scope?.pluginRegistry, registry);
}
class ProbeEngine extends LegacyContextEngine {
  override readonly info = { id: "invocation-0", name: "Synthetic invocation engine" };
  override async assemble(params: Parameters<ContextEngine["assemble"]>[0]) {
    assertOwner();
    nested();
    await Promise.resolve();
    assertOwner();
    assemblies++;
    return { messages: params.messages, estimatedTokens: 0 };
  }
  async dispose() {
    assertOwner();
    nested();
    disposals++;
  }
}
const key = Symbol.for("openclaw.perf.pluginInvocationScope");
Object.defineProperty(globalThis, key, {
  configurable: true,
  value: {
    create() {
      assertOwner();
      factories++;
      return new ProbeEngine();
    },
  },
});
const ids: string[] = [];
const paths: string[] = [];
for (let index = 0; index < pluginCount; index++) {
  const id = `invocation-${index}`;
  const directory = path.join(root, id);
  await fs.mkdir(directory);
  const entry = path.join(directory, "index.cjs");
  await fs.writeFile(
    path.join(directory, "openclaw.plugin.json"),
    JSON.stringify({
      id,
      ...(index === 0 ? { kind: "context-engine", contextEngineIds: [id] } : {}),
      configSchema: { type: "object", additionalProperties: false },
    }),
  );
  await fs.writeFile(
    entry,
    `module.exports = { id: ${JSON.stringify(id)}, register(api) {
    ${index === 0 ? 'api.registerContextEngine("invocation-0", () => globalThis[Symbol.for("openclaw.perf.pluginInvocationScope")].create());' : ""}
    api.registerTool(() => ({ name: ${JSON.stringify(id)}, label: "Synthetic", description: "Synthetic unused sibling", parameters: { type: "object", properties: {} }, execute: async () => ({ content: [] }) }), { name: ${JSON.stringify(id)} });
  } };`,
  );
  ids.push(id);
  paths.push(entry);
}
const config = {
  plugins: {
    allow: ids,
    load: { paths },
    slots: { memory: "none", contextEngine: "invocation-0" },
  },
};
let inspection: Awaited<ReturnType<typeof acquirePluginRegistryForInspection>> | undefined;
let gateway: { close: () => Promise<void> } | undefined;
const inspector = new Session();
const loop = monitorEventLoopDelay({ resolution: 1 });
const collections: { kind: number; ms: number }[] = [];
let measuredStart = Infinity;
let measuredEnd = Infinity;
function recordGc(entries: PerformanceEntry[]) {
  for (const entry of entries) {
    if (entry.startTime >= measuredStart && entry.startTime < measuredEnd) {
      collections.push({
        kind: (entry as PerformanceEntry & { detail: { kind: number } }).detail.kind,
        ms: entry.duration,
      });
    }
  }
}
const observer = new PerformanceObserver((list) => recordGc(list.getEntries()));
function distribution(samples: number[]) {
  const sorted = samples.toSorted((a, b) => a - b);
  const count = sorted.length;
  const totalMs = sorted.reduce((sum, value) => sum + value, 0);
  return {
    count,
    totalMs,
    meanMs: count ? totalMs / count : 0,
    maxMs: sorted.at(-1) ?? 0,
    p95: { samples: count, ms: sorted[Math.ceil(count * 0.95) - 1] ?? null },
    p99: { samples: count, ms: sorted[Math.ceil(count * 0.99) - 1] ?? null },
  };
}
async function waitForStart(warming = false) {
  const readyFile = values[warming ? "warm-ready-file" : "ready-file"];
  const startFile = values[warming ? "warm-start-file" : "start-file"];
  const ready = JSON.stringify({
    pid: process.pid,
    mode: values.mode,
    warming,
    readyAt: Date.now(),
  });
  if (readyFile) {
    await fs.writeFile(readyFile, ready);
  }
  writeSync(1, `INVOCATION_READY ${ready}\n`);
  let startAt = warming ? 0 : integer("start-at", 0);
  if (startFile) {
    const deadline = Date.now() + 600_000;
    for (;;) {
      try {
        startAt = Number(await fs.readFile(startFile, "utf8"));
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
      assert(Date.now() < deadline, "Shared start barrier timed out");
      await delay(50);
    }
    assert(
      Number.isSafeInteger(startAt) && startAt > 0,
      "Start file must contain an epoch timestamp in milliseconds",
    );
  }
  if (startAt) {
    assert(Date.now() < startAt, "Preparation missed the shared start deadline");
    await delay(startAt - Date.now());
  }
}
try {
  if (values.gateway) {
    const { BASE_GATEWAY_BENCH_CONFIG } = await import("../lib/gateway-bench-runtime.js");
    await fs.writeFile(
      process.env.OPENCLAW_CONFIG_PATH,
      JSON.stringify({
        ...BASE_GATEWAY_BENCH_CONFIG,
        ...config,
        agents: { entries: { main: { workspace: path.join(root, "workspace") } } },
      }),
    );
    const { startGatewayServer } = await import("../../src/gateway/server.js");
    gateway = await startGatewayServer(port, { bind: "loopback", controlUiEnabled: false });
  }
  // Startup can defer unrelated tools; explicitly acquire the complete fixture inventory.
  inspection = await acquirePluginRegistryForInspection({ config, throwOnLoadError: true });
  registry = inspection.registry;
  assert.equal(registry.plugins.filter((record) => record.status === "loaded").length, pluginCount);
  const registration = expectDefined(registry.contextEngines.get("invocation-0"), "fixture engine");
  const selectedRecord = registry.plugins.find((record) => record.id === "invocation-0");
  assert(selectedRecord);
  const instance = getPluginInstance(selectedRecord);
  assert(instance);
  nested = instance.wrap(assertOwner);
  async function turn(verifyClosed = false) {
    return withPluginRuntimeRegistryScope(registry, async () => {
      const source = retainLogicalTurnContextEngineSources(registry, registration, undefined, () =>
        assert.fail("Unexpected failed source"),
      ).fallback;
      assert(source);
      const owners = new Map<ContextEngine, ContextEngineFactoryResources[]>();
      const ref = await resolveContextEngineFactory(source, owners, async () => ({
        engine: await registration.factory({}),
      }));
      const engine = source.wrap(ref.engine);
      let completed = false;
      try {
        for (let call = 0; call < calls; call++) {
          await engine.assemble({ sessionId: "synthetic-turn", messages: [] });
        }
        await disposeContextEngineSources(ref.engine, [source]);
        completed = true;
        if (verifyClosed) {
          await assert.rejects(
            async () => engine.assemble({ sessionId: "closed-turn", messages: [] }),
            /closed|unavailable|retiring/,
          );
        }
      } finally {
        if (!completed) {
          await disposeContextEngineSources(ref.engine, [source]);
        }
      }
    });
  }
  async function run(count: number, latencies?: number[]) {
    const before = { factories, assemblies, disposals };
    for (let index = 0; index < count; index++) {
      const started = performance.now();
      await withPluginRetentionOwner(
        { agentId: "main", sessionKey: "synthetic-turn", runId: "synthetic-run" },
        () => turn(),
      );
      latencies?.push(performance.now() - started);
      await (yieldMs ? delay(yieldMs) : nextTurn());
    }
    assert.equal(factories - before.factories, count);
    assert.equal(assemblies - before.assemblies, count * calls);
    assert.equal(disposals - before.disposals, count);
  }
  await turn(true);
  if (values["warm-start-file"]) {
    await waitForStart(true);
  }
  await run(warmup);
  global.gc();
  await nextTurn();
  let counts: object | undefined;
  let allocation: object | undefined;
  let timing: object | undefined;
  if (values.mode === "count") {
    await waitForStart();
    let weakMaps = 0;
    let weakSets = 0;
    const NativeWeakMap = globalThis.WeakMap;
    const NativeWeakSet = globalThis.WeakSet;
    globalThis.WeakMap = new Proxy(NativeWeakMap, {
      construct(target, args, newTarget) {
        weakMaps++;
        return Reflect.construct(target, args, newTarget);
      },
    });
    globalThis.WeakSet = new Proxy(NativeWeakSet, {
      construct(target, args, newTarget) {
        weakSets++;
        return Reflect.construct(target, args, newTarget);
      },
    });
    const entries = mock.method(AsyncLocalStorage.prototype, "enterWith");
    const views = mock.method(PluginInstance.prototype, "createRegistryView");
    try {
      await run(operations);
      counts = {
        weakMaps,
        weakSets,
        registryViews: views.mock.callCount(),
        asyncStoreEntries: entries.mock.callCount(),
        perTurn: {
          weakMaps: weakMaps / operations,
          weakSets: weakSets / operations,
          registryViews: views.mock.callCount() / operations,
          asyncStoreEntries: entries.mock.callCount() / operations,
        },
      };
    } finally {
      entries.mock.restore();
      views.mock.restore();
      globalThis.WeakMap = NativeWeakMap;
      globalThis.WeakSet = NativeWeakSet;
    }
  } else if (values.mode === "allocation") {
    inspector.connect();
    await waitForStart();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    const startedAt = Date.now();
    const started = performance.now();
    await run(operations);
    const elapsedMs = performance.now() - started;
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    let bytes = 0;
    const visit = (node: HeapProfiler.SamplingHeapProfileNode) => {
      bytes += node.selfSize;
      node.children.forEach(visit);
    };
    visit(profile.head);
    await fs.writeFile(profilePath, JSON.stringify(profile));
    allocation = {
      startedAt,
      elapsedMs,
      sampledBytes: bytes,
      bytesPerTurn: bytes / operations,
      bytesPerSecond: (bytes * 1000) / elapsedMs,
      profilePath,
      samplingInterval: 32768,
      includesCollectedObjects: true,
    };
  } else {
    loop.enable();
    await delay(10);
    observer.observe({ entryTypes: ["gc"] });
    await waitForStart();
    const latencies: number[] = [];
    const startedAt = Date.now();
    const cpu = process.cpuUsage();
    const memoryBefore = process.memoryUsage();
    loop.reset();
    marker("diagnostics-start");
    measuredStart = performance.now();
    await run(operations, latencies);
    measuredEnd = performance.now();
    const usedCpu = process.cpuUsage(cpu);
    marker("diagnostics-stop");
    loop.disable();
    await nextTurn();
    recordGc(observer.takeRecords());
    observer.disconnect();
    const gc = (kind?: number) =>
      distribution(
        collections
          .filter((entry) => kind === undefined || entry.kind === kind)
          .map((entry) => entry.ms),
      );
    const elapsedMs = measuredEnd - measuredStart;
    const total = gc();
    timing = {
      traced: values.mode === "promotion",
      startedAt,
      elapsedMs,
      cpu: {
        totalMs: (usedCpu.user + usedCpu.system) / 1000,
        msPerTurn: (usedCpu.user + usedCpu.system) / 1000 / operations,
      },
      latency: distribution(latencies),
      gc: {
        total,
        msPerTurn: total.totalMs / operations,
        msPerMinute: (total.totalMs * 60000) / elapsedMs,
        minor: gc(constants.NODE_PERFORMANCE_GC_MINOR),
        major: gc(constants.NODE_PERFORMANCE_GC_MAJOR),
        incremental: gc(constants.NODE_PERFORMANCE_GC_INCREMENTAL),
        weakCallbacks: gc(constants.NODE_PERFORMANCE_GC_WEAKCB),
      },
      loop: {
        samples: loop.count,
        maxMs: loop.max / 1e6,
        p95: { samples: loop.count, ms: loop.percentile(95) / 1e6 },
        p99: { samples: loop.count, ms: loop.percentile(99) / 1e6 },
      },
      memoryBefore,
      memoryAfter: process.memoryUsage(),
      promotion: values["gc-log"]
        ? readGatewayGcTrace(path.resolve(values["gc-log"]), profilePath, "diagnostics")
        : null,
    };
  }
  const report = {
    scope:
      "Production context-engine resource lifetime with one selected engine and synthetic sibling plugins; no model or transport latency claim",
    gateway: values.gateway,
    mode: values.mode,
    node: process.version,
    operations,
    warmup,
    pluginCount,
    callsPerTurn: calls,
    yieldMs,
    counts,
    allocation,
    timing,
    verified: { factories, assemblies, disposals, closedCallbackRejected: true },
  };
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (values.output) {
    await fs.writeFile(values.output, output);
  }
  writeSync(1, output);
} finally {
  observer.disconnect();
  loop.disable();
  inspector.disconnect();
  await inspection?.release();
  await gateway?.close();
  Reflect.deleteProperty(globalThis, key);
  await fs.rm(root, { recursive: true, force: true });
}
