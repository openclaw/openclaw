// Run on the approved benchmark host with --expose-gc --trace-gc-nvp.
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { writeFileSync, writeSync } from "node:fs";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import path from "node:path";
import { constants, monitorEventLoopDelay, PerformanceObserver } from "node:perf_hooks";
import { mock } from "node:test";
import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { createUnavailableRuntime } from "../../src/plugins/api-builder.js";
import { getPluginInstance } from "../../src/plugins/plugin-instance-scope.js";
import { createPluginRegistry } from "../../src/plugins/registry.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../../src/plugins/runtime/gateway-request-scope.js";
import { createPluginRecord } from "../../src/plugins/status.test-helpers.js";
import { createPluginToolFactoryContext } from "../../src/plugins/tool-factory-context.js";
import {
  bindPluginToolCallbacks,
  createPluginToolFactoryResolver,
} from "../../src/plugins/tool-factory-runtime.js";
import { AsyncWorkScope } from "../../src/shared/async-work-scope.js";
import { GATEWAY_GC_TRACE_MARKER, readGatewayGcTrace } from "../lib/gateway-bench-profile.ts";
import { summarizeDurationDistribution } from "../lib/perf-duration-distribution.ts";
import { recordGcCollections } from "../lib/perf-gc-collections.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    turns: { type: "string", default: "4000" },
    calls: { type: "string", default: "16" },
    "yield-ms": { type: "string", default: "1" },
    "start-at": { type: "string", default: "0" },
    "cpu-start-at": { type: "string", default: "0" },
    "gc-log": { type: "string" },
    output: { type: "string" },
  },
});
const integer = (name: keyof typeof values, min: number) =>
  parseStrictIntegerOption({ raw: values[name], label: `--${name}`, min, fallback: min });
const turns = integer("turns", 1);
const calls = integer("calls", 1);
const yieldMs = integer("yield-ms", 0);
const startAt = integer("start-at", 0);
const cpuStartAt = integer("cpu-start-at", 0);
assert(global.gc, "Run with --expose-gc");
const profilePath = path.resolve(`${values.output ?? "plugin-gateway-scope"}.heapprofile`);
const marker = (phase: string) =>
  writeSync(
    1,
    `${GATEWAY_GC_TRACE_MARKER}${JSON.stringify({ phase, pid: process.pid, profilePath })}\n`,
  );
marker("identify-start");
global.gc();
marker("identify-stop");

const builder = createPluginRegistry({
  runtime: createUnavailableRuntime("setup-only", "scope-benchmark"),
  logger: { info() {}, warn() {}, error() {}, debug() {} },
  activateGlobalSideEffects: false,
});
const registry = builder.registry;
let factories = 0;
let prepared = 0;
let executed = 0;
let authorityChecks = 0;
const signal = new AbortController().signal;
const args = Object.freeze({ value: "synthetic" });
const result = { content: [], details: { value: "synthetic" } };
const assertInvocationCurrent = () => {
  authorityChecks++;
};
const registrations = ["scope-one", "scope-two"].map((pluginId) => {
  const record = createPluginRecord({
    id: pluginId,
    source: `/synthetic/${pluginId}/index.ts`,
    origin: "bundled",
    contracts: { tools: [pluginId] },
  });
  registry.plugins.push(record);
  const api = builder.createApi(record, { config: {}, registrationMode: "full" });
  const assertScope = () => {
    const scope = getPluginRuntimeGatewayRequestScope();
    assert.equal(scope?.pluginId, pluginId);
    assert.equal(scope?.pluginSource, record.source);
    assert.equal(scope?.pluginOrigin, "bundled");
    assert.equal(scope?.pluginRegistry, registry);
  };
  api.registerTool(
    () => {
      assertScope();
      factories++;
      return {
        name: pluginId,
        label: pluginId,
        description: "Synthetic scope benchmark",
        parameters: { type: "object", properties: {} },
        prepareArguments(input: unknown) {
          assertScope();
          prepared++;
          return input;
        },
        async execute() {
          assertScope();
          await Promise.resolve();
          assertScope();
          executed++;
          return result;
        },
      };
    },
    { name: pluginId },
  );
  const entry = registry.tools.at(-1);
  assert(entry);
  const context = createPluginToolFactoryContext({
    entry,
    registry,
    context: {},
    assertInvocationCurrent,
  });
  const instance = getPluginInstance(record);
  assert(instance);
  return { entry, context, instance };
});
// Match the request fields installed by Gateway method dispatch, including optional fields.
const gatewayScope = {
  context: undefined,
  resolveGatewayContext: () => undefined,
  client: undefined,
  signal,
  hasCurrentClientAuthority: () => true,
  isWebchatConnect: () => false,
  pluginRegistry: registry,
};

async function turn(index: number) {
  const { entry, context } = registrations[index % registrations.length]!;
  return withPluginRuntimeGatewayRequestScope(gatewayScope, async () => {
    const resolver = createPluginToolFactoryResolver((message) => assert.fail(message));
    const { resolved, failed } = resolver.resolve(entry, context, entry.names);
    assert.equal(failed, false);
    assert(resolved && !Array.isArray(resolved));
    const tool = bindPluginToolCallbacks(
      entry,
      registry,
      resolved,
      context.assertInvocationCurrent,
    );
    for (let call = 0; call < calls; call++) {
      assert.equal(tool.prepareArguments?.(args), args);
      assert.equal(await tool.execute("synthetic-call", args, signal), result);
    }
    assert.equal(getPluginRuntimeGatewayRequestScope(), gatewayScope);
  });
}

async function run(count: number, latencies?: number[]) {
  const before = { factories, prepared, executed };
  for (let index = 0; index < count; index++) {
    const started = performance.now();
    await turn(index);
    latencies?.push(performance.now() - started);
    await (yieldMs ? delay(yieldMs) : nextTurn());
  }
  assert.equal(factories - before.factories, count);
  assert.equal(prepared - before.prepared, count * calls);
  assert.equal(executed - before.executed, count * calls);
  assert.equal(getPluginRuntimeGatewayRequestScope(), undefined);
}

async function countEntries(invoke: () => unknown) {
  // Instrument only this probe; the allocation and CPU passes use native methods.
  const probe = mock.method(AsyncLocalStorage.prototype, "enterWith");
  try {
    await invoke();
    return probe.mock.callCount();
  } finally {
    probe.mock.restore();
    probe.mock.resetCalls();
  }
}

async function waitUntil(deadline: number) {
  if (deadline) {
    assert(Date.now() < deadline, "Preparation missed the shared start deadline");
    await delay(deadline - Date.now());
  }
}

const inspector = new Session();
const observer = new PerformanceObserver((list) =>
  recordGcCollections(list.getEntries(), collections, measuredStart, measuredEnd),
);
const loop = monitorEventLoopDelay({ resolution: 1 });
const collections: { kind: number; ms: number }[] = [];
let measuredStart = Infinity;
let measuredEnd = Infinity;

try {
  const control = registrations[0]!.instance;
  const tracked = new AsyncWorkScope();
  const entries = {
    syntheticTurn: await countEntries(() => turn(0)),
    trackedSyntheticTurn: await countEntries(() => tracked.track(() => turn(0))),
    directInstance: await countEntries(() => control.run(() => undefined)),
    nestedSameInstance: await countEntries(() => control.run(() => control.run(() => undefined))),
  };
  await tracked.drain();
  await run(50);
  inspector.connect();
  global.gc();
  await nextTurn();
  writeSync(1, `SCOPE_READY ${JSON.stringify({ pid: process.pid, startAt, cpuStartAt })}\n`);
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 32_768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  await waitUntil(startAt);
  const allocationStartedAt = Date.now();
  await run(turns);
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  let totalBytes = 0;
  const visit = (node: HeapProfiler.SamplingHeapProfileNode) => {
    totalBytes += node.selfSize;
    node.children.forEach(visit);
  };
  visit(profile.head);
  writeFileSync(profilePath, JSON.stringify(profile));
  global.gc();
  await nextTurn();
  loop.enable();
  await delay(10);
  await waitUntil(cpuStartAt);
  const cpuStartedAt = Date.now();
  const latencies: number[] = [];
  observer.observe({ entryTypes: ["gc"] });
  const before = process.memoryUsage();
  const cpu = process.cpuUsage();
  loop.reset();
  marker("diagnostics-start");
  measuredStart = performance.now();
  await run(turns, latencies);
  measuredEnd = performance.now();
  const usedCpu = process.cpuUsage(cpu);
  const after = process.memoryUsage();
  marker("diagnostics-stop");
  loop.disable();
  await nextTurn();
  recordGcCollections(observer.takeRecords(), collections, measuredStart, measuredEnd);
  observer.disconnect();
  const gc = (kind?: number) =>
    summarizeDurationDistribution(
      collections
        .filter((entry) => kind === undefined || entry.kind === kind)
        .map((entry) => entry.ms),
    );
  const totalGc = gc();
  const invocationCount = turns * (1 + calls * 2);
  const promotion = values["gc-log"]
    ? readGatewayGcTrace(path.resolve(values["gc-log"]), profilePath, "diagnostics")
    : undefined;
  const report = {
    scope:
      "registered plugin factory + prepare/execute owner; synthetic turns, no Gateway/model latency claim",
    node: process.version,
    turns,
    callsPerTurn: calls,
    invocationsPerTurn: 1 + calls * 2,
    invocationCount,
    yieldMs,
    entries,
    allocation: {
      startedAt: allocationStartedAt,
      totalBytes,
      bytesPerInvocation: totalBytes / invocationCount,
      bytesPerTurn: totalBytes / turns,
      profilePath,
    },
    cpu: {
      startedAt: cpuStartedAt,
      elapsedMs: measuredEnd - measuredStart,
      totalMs: (usedCpu.user + usedCpu.system) / 1000,
      msPerTurn: (usedCpu.user + usedCpu.system) / 1000 / turns,
      turnLatency: summarizeDurationDistribution(latencies),
    },
    gc: {
      total: totalGc,
      msPerTurn: totalGc.totalMs / turns,
      minor: gc(constants.NODE_PERFORMANCE_GC_MINOR),
      major: gc(constants.NODE_PERFORMANCE_GC_MAJOR),
    },
    promotion: promotion ? { ...promotion, bytesPerTurn: promotion.promotedBytes / turns } : null,
    eventLoop: {
      samples: loop.count,
      maxMs: loop.max / 1e6,
      p95: { samples: loop.count, ms: loop.percentile(95) / 1e6 },
      p99: { samples: loop.count, ms: loop.percentile(99) / 1e6 },
    },
    memory: { before, after, peakRssBytesIncludingSetup: process.resourceUsage().maxRSS * 1024 },
    verified: { factories, prepared, executed, authorityChecks },
  };
  const output = `${JSON.stringify(report, null, 2)}\n`;
  if (values.output) {
    writeFileSync(values.output, output);
  }
  writeSync(1, output);
} finally {
  observer.disconnect();
  loop.disable();
  inspector.disconnect();
}
