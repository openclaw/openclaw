// Warm session-action dispatch with 44 loaded synthetic plugins and a 10,000-entry
// session-identity pool. Each batch visits its first iterations/5 identities; each
// response has a 40-row knowledge-style activity page.
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/plugin-session-action-measure.ts timing 3000
// Use allocation instead of timing for a separate 4 KiB sampled-allocation pass.
// An optional third argument sets warmup calls (default 200).
// Run unchanged on base/candidate in AB/BA order. Accept lower allocation without adverse CPU
// with unchanged replies and JSON limits. This measures the actual RPC handler,
// excluding router admission, transport and plugin storage (no worker requests).
// It is an owner microbenchmark, not a live Gateway or a 10k-row database test.
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pluginHostHookHandlers } from "../../src/gateway/server-methods/plugin-host-hooks.js";
import type { GatewayRequestHandlerOptions } from "../../src/gateway/server-methods/types.js";
import { createEmptyPluginRegistry } from "../../src/plugins/registry-empty.js";
import { withPluginRuntimeGatewayRequestScope } from "../../src/plugins/runtime/gateway-request-scope.js";
import { createPluginRecord } from "../../src/plugins/status.test-helpers.js";

const [mode = "timing", rawIterations = "3000", rawWarmup = "200"] = process.argv.slice(2);
const iterations = Number(rawIterations);
const warmup = Number(rawWarmup);
assert(["timing", "allocation"].includes(mode));
assert(Number.isSafeInteger(iterations) && iterations >= 5 && iterations % 5 === 0);
assert(Number.isSafeInteger(warmup) && warmup >= 0);
assert(global.gc, "Run with --expose-gc");
const registry = createEmptyPluginRegistry();
const result = {
  items: Array.from({ length: 40 }, (_, index) => ({
    id: `synthetic-record-${index}`,
    title: `Synthetic activity ${index}`,
    at: "2026-01-01T00:00:00.000Z",
    action: "read",
    operation: "record",
    summary: "Synthetic knowledge activity for allocation measurement.",
  })),
  upper: 40,
  nextBefore: null,
};
for (let index = 0; index < 44; index++) {
  const pluginId = `synthetic-plugin-${index}`;
  registry.plugins.push(createPluginRecord({ id: pluginId }));
  registry.sessionActions.push({
    pluginId,
    pluginName: pluginId,
    source: "synthetic",
    action: {
      id: "session_activity",
      requiredScopes: ["operator.read"],
      schema: {
        type: "object",
        required: ["sessionKey"],
        properties: { sessionKey: { type: "string" } },
      },
      handler: () => ({ ok: true, result }),
    },
  });
}
const payloads = Array.from({ length: 10_000 }, (_, index) => ({
  sessionKey: `agent:synthetic:task-${index}`,
  limit: 40,
}));
let responses = 0;
const options = {
  req: { id: "synthetic", type: "req", method: "plugins.sessionAction" },
  params: { pluginId: "synthetic-plugin-43", actionId: "session_activity", payload: payloads[0] },
  client: { connect: { role: "operator", scopes: ["operator.read"] } },
  context: { getRuntimeConfig: () => ({}) },
  isWebchatConnect: () => false,
  respond: (ok, payload, error) => {
    assert(ok && !error);
    assert(payload && typeof payload === "object" && "result" in payload);
    assert.equal(payload.result, result);
    responses++;
  },
} satisfies Pick<
  GatewayRequestHandlerOptions,
  "req" | "params" | "respond" | "isWebchatConnect"
> & {
  client: unknown;
  context: unknown;
};
const handler = pluginHostHookHandlers["plugins.sessionAction"];
assert(handler);
async function run(count: number) {
  for (let index = 0; index < count; index++) {
    options.params.payload = payloads[index % payloads.length];
    // Only these fields are consumed by this read-only action fixture.
    await handler!(options as GatewayRequestHandlerOptions);
  }
}
await withPluginRuntimeGatewayRequestScope(
  { pluginRegistry: registry, isWebchatConnect: () => false },
  async () => {
    await run(warmup);
    global.gc!();
    await nextTurn();
    const inspector = new Session();
    const gcMs: number[] = [];
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        gcMs.push(entry.duration);
      }
    });
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
    const batches = [];
    for (let index = 0; index < 5; index++) {
      const cpu = process.threadCpuUsage();
      const started = performance.now();
      await run(iterations / 5);
      const used = process.threadCpuUsage(cpu);
      batches.push({
        wallMs: performance.now() - started,
        cpuMs: (used.user + used.system) / 1000,
      });
    }
    await nextTurn();
    await nextTurn();
    observer.disconnect();
    let bytesPerCall: number | undefined;
    if (mode === "allocation") {
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      bytesPerCall = profile.samples.reduce((sum, sample) => sum + sample.size, 0) / iterations;
      inspector.disconnect();
    }
    assert.equal(responses, iterations + warmup);
    console.log(
      JSON.stringify({
        mode,
        iterations,
        warmup,
        hostLoad,
        batches,
        bytesPerCall,
        gc: {
          count: gcMs.length,
          totalMs: gcMs.reduce((a, b) => a + b, 0),
          maxMs: Math.max(0, ...gcMs),
        },
        memory: process.memoryUsage(),
      }),
    );
  },
);
