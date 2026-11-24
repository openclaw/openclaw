/**
 * Synthetic registered-plugin dispatch, no Gateway/DB/network or real data.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/plugin-agent-event-dispatch-measure.mjs <output>
 * Acceptance: identical delivered callbacks; zero scope entries for rejected events;
 * five A/A/B rounds, lower sampled allocation and CPU beyond A/A spread.
 * 40 loaded plugins, 10k text deltas, bundled filters and a mixed subscriber stress case.
 * CPU/wall and allocation passes are separate; setup/warmup are excluded.
 */
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { mock } from "node:test";
import { setImmediate } from "node:timers/promises";
import { createUnavailableRuntime } from "../../src/plugins/api-builder.ts";
import {
  clearPluginHostRuntimeState,
  dispatchPluginAgentEventSubscriptions,
} from "../../src/plugins/host-hook-runtime.ts";
import { getPluginInstance } from "../../src/plugins/plugin-instance-scope.ts";
import { createPluginRegistry } from "../../src/plugins/registry.ts";
import { getPluginRuntimeGatewayRequestScope } from "../../src/plugins/runtime/gateway-request-scope.ts";
import { createPluginRecord } from "../../src/plugins/status.test-helpers.ts";

assert(globalThis.gc, "requires --expose-gc");
const output = process.argv[2];
assert(output, "output path required");
const events = Array.from({ length: 10_000 }, (_, i) => ({
  runId: `synthetic-run-${i % 1000}`,
  sessionKey: `agent:synthetic:session-${i % 1000}`,
  stream: "assistant",
  seq: i + 1,
  ts: i,
  data: { phase: "delta", delta: "Synthetic text delta." },
}));
const isLive = () => true;
const report = {
  node: process.version,
  events: events.length,
  plugins: 40,
  load: loadavg(),
  modes: {},
};
for (const mode of ["bundled", "mixed"]) {
  const builder = createPluginRegistry({
    runtime: createUnavailableRuntime("setup-only", "event-dispatch-benchmark"),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    activateGlobalSideEffects: false,
  });
  const registry = builder.registry;
  let delivered = 0;
  const instances = [];
  for (let index = 0; index < 40; index++) {
    const id = `synthetic-${index}`;
    const record = createPluginRecord({
      id,
      origin: "bundled",
      source: `/synthetic/${id}/index.ts`,
    });
    registry.plugins.push(record);
    const api = builder.createApi(record, { config: {}, registrationMode: "full" });
    const instance = getPluginInstance(record);
    assert(instance);
    instances.push(instance);
    // Bundled source has two subscribers; mixed adds 10 matches, 10 phase
    // rejects, 10 stream rejects, and leaves 10 plugins unsubscribed.
    if (mode === "bundled" && index >= 2) {
      continue;
    }
    if (mode === "mixed" && index >= 30) {
      continue;
    }
    const streams =
      mode === "bundled"
        ? index === 0
          ? ["lifecycle"]
          : ["tool", "lifecycle", "codex_app_server.item"]
        : index < 20
          ? ["assistant"]
          : ["lifecycle"];
    const phases =
      mode === "bundled"
        ? index === 0
          ? ["end", "error"]
          : ["start", "result", "end", "error", "started", "completed"]
        : index < 10
          ? ["delta"]
          : ["end"];
    api.agent.events.registerAgentEventSubscription({
      id: "synthetic-events",
      streams,
      phases,
      payload: "metadata",
      handle() {
        const scope = getPluginRuntimeGatewayRequestScope();
        assert.equal(scope?.pluginId, id);
        assert.equal(scope?.pluginRegistry, registry);
        delivered++;
      },
    });
  }
  async function run(count) {
    const before = delivered;
    for (let i = 0; i < count; i++) {
      dispatchPluginAgentEventSubscriptions({ registry, event: events[i], isLive });
      if (i % 100 === 99) {
        await setImmediate();
      }
    }
    await setImmediate();
    assert.equal(delivered - before, mode === "bundled" ? 0 : count * 10);
    assert.equal(getPluginRuntimeGatewayRequestScope(), undefined);
  }
  await run(1000);
  let entries = 0;
  const probe = mock.method(AsyncLocalStorage.prototype, "enterWith");
  try {
    await run(10);
    entries = probe.mock.callCount();
  } finally {
    probe.mock.restore();
    probe.mock.resetCalls();
  }
  globalThis.gc();
  const cpu = process.cpuUsage();
  const start = performance.now();
  await run(events.length);
  const wallMs = performance.now() - start;
  const used = process.cpuUsage(cpu);
  globalThis.gc();
  const inspector = new Session();
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 4096,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  await run(events.length);
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  await inspector.post("Profiler.enable");
  await inspector.post("Profiler.start");
  await run(events.length);
  const { profile: cpuProfile } = await inspector.post("Profiler.stop");
  inspector.disconnect();
  let bytes = 0;
  function visit(node) {
    bytes += node.selfSize;
    for (const child of node.children) {
      visit(child);
    }
  }
  visit(profile.head);
  writeFileSync(`${output}.${mode}.heapprofile`, JSON.stringify(profile));
  writeFileSync(`${output}.${mode}.cpuprofile`, JSON.stringify(cpuProfile));
  report.modes[mode] = {
    subscriptions: registry.agentEventSubscriptions.length,
    deliveriesPerEvent: mode === "bundled" ? 0 : 10,
    entriesPerEvent: entries / 10,
    cpuMs: (used.user + used.system) / 1000,
    wallMs,
    sampledBytes: bytes,
  };
  await Promise.all(instances.map((instance) => instance.dispose()));
  clearPluginHostRuntimeState();
}
report.loadAfter = loadavg();
writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report));
