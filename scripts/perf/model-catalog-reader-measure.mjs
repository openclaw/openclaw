/**
 * Pending catalog reads: one initial read and four same-scope catalog events per round,
 * 40 synthetic providers,
 * and a roughly 40 KiB JSON response per actual request. No network or Gateway state.
 *
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/model-catalog-reader-measure.mjs \
 *   --iterations 3000 [--owner .local/baseline-model-catalog-reader.ts]
 *
 * Save the baseline reader source with git show before editing; --owner overlays only
 * that module while retaining its canonical import location and current dependencies.
 * Requires Node 26's cumulative V8 allocation counter; CPU is untraced.
 * Alternate baseline/candidate processes. Acceptance: five wire calls become one per
 * event burst, allocation and CPU decrease, and output stays identical. This synthetic
 * burst establishes no production frequency claim.
 * This owner microbenchmark complements browser RPC counts, not whole-Gateway stress.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import { setImmediate as nextTurn } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";
import { transformSync } from "esbuild";

const { values } = parseArgs({
  options: { owner: { type: "string" }, iterations: { type: "string", default: "3000" } },
});
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(globalThis.gc, "Run with --expose-gc");
assert(
  Number.isFinite(getHeapStatistics().total_allocated_bytes),
  "Requires Node 26 allocation counters",
);
const ownerUrl = new URL("../../ui/src/lib/model-catalog-reader.ts", import.meta.url);
const source = readFileSync(values.owner ?? fileURLToPath(ownerUrl), "utf8");
const code = transformSync(source, { loader: "ts", format: "esm", target: "esnext" }).code;
const hooks = registerHooks({
  load(url, context, next) {
    return url === ownerUrl.href
      ? { format: "module", source: code, shortCircuit: true }
      : next(url, context);
  },
});
const { ModelCatalogReader } = await import(ownerUrl.href);
const { invalidateModelCatalogCache, clearModelCatalogCache } =
  await import("../../ui/src/lib/model-catalog-cache.ts");
const { GatewayBrowserClient } = await import("../../ui/src/api/gateway.ts");
const fixture = {
  models: Array.from({ length: 320 }, (_, index) => ({
    id: `model-${index}`,
    provider: `provider-${index % 40}`,
    name: `Synthetic model ${index}`,
    contextWindow: 200_000,
    reasoning: true,
    input: ["text"],
  })),
};
const wire = JSON.stringify(fixture);
const client = new GatewayBrowserClient({ url: "ws://synthetic.invalid" });
globalThis.document = Object.assign(new EventTarget(), { visibilityState: "visible" });
let pending = [];
let requests = 0;
client.request = (method) => {
  assert.equal(method, "models.list");
  requests++;
  const deferred = Promise.withResolvers();
  pending.push(deferred);
  return deferred.promise;
};
const unused = () => {
  throw new Error("Unexpected Gateway operation in catalog reader workload");
};
const eventListeners = new Set();
const gateway = {
  snapshot: { client, phase: "connected" },
  connection: { gatewayUrl: "ws://synthetic.invalid", sessionKey: "main" },
  connectionRevision: 0,
  eventLog: [],
  eventLogRevision: 0,
  connect: unused,
  defer: unused,
  setSessionKey: unused,
  start: unused,
  stop: unused,
  subscribe: unused,
  subscribeEventLog: unused,
  subscribeEvents: (listener) => {
    eventListeners.add(listener);
    return () => eventListeners.delete(listener);
  },
  loadSelfProfile: unused,
};
const scope = { agentId: "main" };
let reads = [];
const reader = new ModelCatalogReader(() => {}, {
  timeoutMs: 30_000,
  onRead: (read) => reads.push(read),
});
reader.bind(gateway, scope);
assert.equal(eventListeners.size, 1);
const event = {
  type: "event",
  event: "chat.metadata.changed",
  payload: {
    agentId: "main",
    modelCatalogChanged: true,
    commandsChanged: false,
    authChanged: false,
  },
};
async function run(count) {
  const before = requests;
  for (let index = 0; index < count; index++) {
    invalidateModelCatalogCache(client, scope);
    reads = [];
    void reader.read();
    for (let repeat = 0; repeat < 4; repeat++) {
      // The app invalidates shared catalog state before delivering the event to views.
      invalidateModelCatalogCache(client, scope);
      for (const listener of eventListeners) {
        listener(event);
      }
    }
    let delivered;
    for (const deferred of pending) {
      delivered = JSON.parse(wire);
      deferred.resolve(delivered);
    }
    pending = [];
    const results = await Promise.all(reads);
    assert.equal(results.at(-1), delivered);
    for (const result of results) {
      if (result !== undefined) {
        assert.equal(result, delivered);
      }
    }
    assert.deepEqual(delivered, fixture);
    assert.equal(reader.snapshot.models, delivered.models);
    if (index % 100 === 99) {
      await nextTurn();
    }
  }
  await nextTurn();
  return requests - before;
}
try {
  await run(Math.min(100, iterations));
  globalThis.gc();
  await nextTurn();
  const hostLoad = { before: loadavg() };
  const allocatedBefore = getHeapStatistics().total_allocated_bytes;
  const cpuBefore = process.threadCpuUsage();
  const started = performance.now();
  const requestCount = await run(iterations);
  const elapsedMs = performance.now() - started;
  const cpu = process.threadCpuUsage(cpuBefore);
  const allocatedAfter = getHeapStatistics().total_allocated_bytes;
  hostLoad.after = loadavg();
  const allocatedBytes = allocatedAfter - allocatedBefore;
  console.log(
    JSON.stringify({
      node: process.version,
      ownerSha256: createHash("sha256").update(source).digest("hex"),
      iterations,
      initialReadsPerRound: 1,
      catalogEventsPerRound: 4,
      providers: 40,
      responseBytes: Buffer.byteLength(wire),
      requestCount,
      requestsPerRound: requestCount / iterations,
      elapsedMs,
      mainThreadCpuMs: (cpu.user + cpu.system) / 1000,
      cpuUsPerRound: (cpu.user + cpu.system) / iterations,
      allocationMethod: "v8-total-allocated-bytes",
      allocatedBytes,
      allocatedBytesPerRound: allocatedBytes / iterations,
      hostLoad,
    }),
  );
} finally {
  reader.clear();
  clearModelCatalogCache(client);
  hooks.deregister();
  delete globalThis.document;
}
