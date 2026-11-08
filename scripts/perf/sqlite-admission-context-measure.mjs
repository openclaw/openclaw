/**
 * SQLite admission context dispatch, without database I/O or model work.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/sqlite-admission-context-measure.mjs
 *   [--owner /absolute/baseline.ts] [--iterations 2000] [--batch 64] [--worker]
 * Run baseline/candidate serially in ABBA order, >=5 samples each plus A/A controls.
 * Counts, CPU, and sampled allocation use separate passes. Worker mode uses real
 * transferred MessagePorts; micro mode queues identical messages on this thread.
 */
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Worker } from "node:worker_threads";
import { createEmptyPluginRegistry } from "../../src/plugins/registry-empty.ts";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../../src/plugins/runtime/gateway-request-scope.ts";

const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    "cpu-profile": { type: "string" },
    iterations: { type: "string", default: "2000" },
    batch: { type: "string", default: "64" },
    worker: { type: "boolean", default: false },
    receipts: { type: "boolean", default: false },
  },
});
const iterations = Number(values.iterations);
const batch = Number(values.batch);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(Number.isSafeInteger(batch) && batch > 0);
assert(globalThis.gc, "Run with --expose-gc");
const owner = values.owner
  ? pathToFileURL(values.owner)
  : new URL("../../src/infra/sqlite-worker-operation-admission.ts", import.meta.url);
const { createSqliteWorkerOperationAdmission, observeSqliteWorkerCommittedFacts } = await import(
  owner.href
);
const inspector = new Session();
const transferList = [];
const registry = createEmptyPluginRegistry();
const scope = {
  isWebchatConnect: () => false,
  pluginRegistry: registry,
  signal: new AbortController().signal,
  hasCurrentClientAuthority: () => true,
};
const stores = Array.from({ length: 26 }, () => new AsyncLocalStorage());
const inOwner = (invoke) =>
  stores.reduceRight((next, store) => () => store.run(scope, next), invoke)();
// eslint-disable-next-line @typescript-eslint/unbound-method -- Restore the exact native method; the probe calls it with its original receiver.
const originalSnapshot = AsyncLocalStorage.snapshot;
// eslint-disable-next-line @typescript-eslint/unbound-method -- Each invocation supplies its AsyncLocalStorage receiver with call().
const originalEnter = AsyncLocalStorage.prototype.enterWith;
const originalKeys = Object.keys;
let counting = false;
let snapshots = 0;
let entries = 0;
let copies = 0;
// Instrument only the count pass. Recreate the admission for uninstrumented timings.
function instrument() {
  AsyncLocalStorage.snapshot = function () {
    const captured = originalSnapshot.call(this);
    return (invoke, ...args) => {
      if (counting) {
        snapshots++;
      }
      return captured(invoke, ...args);
    };
  };
  AsyncLocalStorage.prototype.enterWith = function (value) {
    if (counting) {
      entries++;
    }
    return originalEnter.call(this, value);
  };
  Object.keys = function (value) {
    if (counting && new Error().stack?.includes("copyGatewayScope")) {
      copies++;
    }
    return originalKeys(value);
  };
}
function restore() {
  AsyncLocalStorage.snapshot = originalSnapshot;
  AsyncLocalStorage.prototype.enterWith = originalEnter;
  Object.keys = originalKeys;
}
const workerSource = `
  const { parentPort } = require('node:worker_threads');
  parentPort.on('message', ({ port, ready, decision, batch, iterations, receipts }) => {
    const sync = new Int32Array(ready);
    for (let iteration = 0; iteration < iterations; iteration++) {
      for (let i = 0; i < batch; i++) {
        const sequence = iteration * batch + i + 1;
        const facts = { sessionKey: 'agent:synthetic:session:' + (sequence % 4096), revision: sequence };
        port.postMessage(receipts
          ? { kind: 'native-commit', committed: { version: 1, sequence, facts } }
          : { stage: 'transaction', decision, facts });
      }
      Atomics.store(sync, 0, iteration + 1);
      Atomics.notify(sync, 0);
      while (Atomics.load(sync, 1) <= iteration) Atomics.wait(sync, 1, iteration);
    }
    port.close();
  });
`;
let effects = 0;
let checks = 0;
function createAdmission() {
  const admission = inOwner(() =>
    withPluginRuntimeGatewayRequestScope(scope, () =>
      createSqliteWorkerOperationAdmission((_request, grant) => {
        assert.equal(getPluginRuntimeGatewayRequestScope(), scope);
        assert.equal(scope.pluginRegistry, registry);
        assert(grant(() => effects++));
      }),
    ),
  );
  admission.bindDatabaseAuthority({
    databasePath: "/synthetic/admitted.sqlite",
    assertRequest: () => checks++,
    assertAccess: () => checks++,
    acquireSchema: () => assert.fail("No schema operation in this workload"),
  });
  observeSqliteWorkerCommittedFacts(admission, () => {
    assert.equal(getPluginRuntimeGatewayRequestScope(), scope);
    effects++;
  });
  return admission;
}
async function run(count, measure) {
  const countWork = counting;
  counting = false;
  const admission = createAdmission();
  counting = countWork;
  const decision = new Int32Array(new SharedArrayBuffer(4));
  const ready = new Int32Array(new SharedArrayBuffer(8));
  const worker = values.worker ? new Worker(workerSource, { eval: true, execArgv: [] }) : undefined;
  const durations = [];
  let elapsedMs = 0;
  let mainCpuUs = 0;
  try {
    if (worker) {
      await new Promise((resolve, reject) => {
        worker.once("online", resolve);
        worker.once("error", reject);
      });
      worker.postMessage(
        {
          port: admission.port,
          ready: ready.buffer,
          decision: decision.buffer,
          batch,
          iterations: count,
          receipts: values.receipts,
        },
        [admission.port],
      );
    }
    for (let iteration = 0; iteration < count; iteration++) {
      if (worker) {
        while (Atomics.load(ready, 0) <= iteration) {
          assert.notEqual(Atomics.wait(ready, 0, iteration, 10000), "timed-out");
        }
      } else {
        for (let i = 0; i < batch; i++) {
          const sequence = iteration * batch + i + 1;
          const facts = {
            sessionKey: `agent:synthetic:session:${sequence % 4096}`,
            revision: sequence,
          };
          admission.port.postMessage(
            values.receipts
              ? { kind: "native-commit", committed: { version: 1, sequence, facts } }
              : { stage: "transaction", decision: decision.buffer, facts },
            transferList,
          );
        }
      }
      Atomics.store(decision, 0, 0);
      const before = measure ? process.threadCpuUsage() : undefined;
      const started = measure ? performance.now() : 0;
      admission.service();
      if (measure) {
        const duration = performance.now() - started;
        durations.push(duration);
        elapsedMs += duration;
        const used = process.threadCpuUsage(before);
        mainCpuUs += used.user + used.system;
      }
      assert.equal(admission.failure, undefined);
      if (worker) {
        Atomics.store(ready, 1, iteration + 1);
        Atomics.notify(ready, 1);
      }
    }
    durations.sort((a, b) => a - b);
    return {
      elapsedMs,
      mainCpuUs,
      batchP50Ms: durations[Math.floor(durations.length / 2)],
      batchP95Ms: durations[Math.floor(durations.length * 0.95)],
    };
  } finally {
    counting = false;
    await worker?.terminate();
    admission.finish();
  }
}

try {
  // Receipt delivery measures the drain alone; admission requests need distinct
  // decision words, so use --batch 1 for their single-message microbenchmark.
  assert(values.receipts || batch === 1, "Use --receipts for multi-message batches");
  instrument();
  counting = true;
  await run(1, false);
  counting = false;
  restore();
  const counts = { snapshots, entries, copies };
  await run(100, false);
  globalThis.gc();
  const hostLoad = loadavg();
  inspector.connect();
  if (values["cpu-profile"]) {
    await inspector.post("Profiler.enable");
    await inspector.post("Profiler.start");
  }
  const cpu = await run(iterations, true);
  if (values["cpu-profile"]) {
    const { profile } = await inspector.post("Profiler.stop");
    writeFileSync(values["cpu-profile"], JSON.stringify(profile));
  }
  globalThis.gc();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 4096,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  const before = effects;
  await run(iterations, false);
  assert.equal(effects - before, iterations * batch);
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  let bytes = 0;
  const visit = (node) => {
    bytes += node.selfSize;
    node.children.forEach(visit);
  };
  visit(profile.head);
  console.log(
    JSON.stringify({
      node: process.version,
      owner: owner.href,
      iterations,
      batch,
      worker: values.worker,
      receipts: values.receipts,
      hostLoad,
      counts,
      cpu,
      allocation: { sampledBytes: bytes, bytesPerMessage: bytes / (iterations * batch) },
      effects,
      checks,
    }),
  );
} finally {
  restore();
  inspector.disconnect();
  for (const store of stores) {
    store.disable();
  }
}
