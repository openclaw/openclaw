/**
 * Native versus worker-owned runtime lease verification with real synthetic SQLite.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/sqlite-native-lease-measure.mjs
 *   [--baseline] [--iterations 2000] [--delay-ms 20]
 *
 * --baseline uses the retained native lease API; candidate uses its existing async
 * counterpart. Seed 10,000 retained lease keys across 40 scopes, then warm one
 * held lease before measuring repeated effect admission.
 * CPU, sampled allocation, and filesystem counts use separate passes. Counting
 * wrappers are absent from CPU/allocation measurement. A final operation
 * injects latency into host synchronous filesystem calls only. This is an owner
 * benchmark, not Gateway load. State stays under .local and is removed on exit.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { syncBuiltinESMExports } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { setImmediate as immediate } from "node:timers/promises";
import { parseArgs } from "node:util";
import { readGatewayLockProcessNamespace } from "../../src/infra/gateway-lock-payload.ts";
import { acquireGatewayStateOwner } from "../../src/infra/gateway-state-owner.ts";
import {
  openOpenClawStateDatabase,
  closeOpenClawStateDatabaseAsync,
  runOpenClawStateWriteTransaction,
} from "../../src/state/openclaw-state-db.ts";
import {
  withOpenClawStateLease,
  withOpenClawStateLeaseAsync,
} from "../../src/state/openclaw-state-lease.ts";
import { captureOpenClawStateWorkerContext } from "../../src/state/openclaw-state-worker-context.ts";

const { values } = parseArgs({
  options: {
    baseline: { type: "boolean", default: false },
    iterations: { type: "string", default: "2000" },
    "delay-ms": { type: "string", default: "20" },
  },
});
assert(globalThis.gc, "Run with --expose-gc");
const iterations = Number(values.iterations);
const delayMs = Number(values["delay-ms"]);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(Number.isFinite(delayMs) && delayMs >= 0);
fs.mkdirSync(".local", { recursive: true });
const root = fs.mkdtempSync(path.resolve(".local/sqlite-lease-measure-"));
const env = { OPENCLAW_STATE_DIR: root };
const databasePath = path.join(root, "state", "openclaw.sqlite");
fs.mkdirSync(path.dirname(databasePath), { recursive: true });
const workers = new Set();
const observeWorker = (worker) => workers.add(worker);
process.on("worker", observeWorker);
const owner = acquireGatewayStateOwner({
  databasePath,
  payload: {
    pid: process.pid,
    role: "gateway",
    createdAt: new Date().toISOString(),
    configPath: path.join(root, "openclaw.json"),
    processNamespace: readGatewayLockProcessNamespace(),
  },
});
const inspector = new Session();
const profiles = [];
const restores = [];
let injectedDelay = 0;
let operations = 0;
const blocked = new Int32Array(new SharedArrayBuffer(4));
const wrap = (object, key) => {
  const original = object[key];
  const wrapped = function (...args) {
    operations++;
    if (injectedDelay) {
      Atomics.wait(blocked, 0, 0, injectedDelay);
    }
    return original.apply(this, args);
  };
  Object.assign(wrapped, original);
  object[key] = wrapped;
  restores.push(() => {
    object[key] = original;
  });
};
const bytes = (profile) => {
  let total = 0;
  const pending = [profile.head];
  while (pending.length) {
    const node = pending.pop();
    total += node.selfSize;
    pending.push(...node.children);
  }
  return total;
};
const cpuMs = (usage) => (usage.user + usage.system) / 1000;
try {
  openOpenClawStateDatabase({ env });
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      db.exec(`
      WITH RECURSIVE fixture(i) AS (
        SELECT 0 UNION ALL SELECT i + 1 FROM fixture WHERE i < 9999
      )
      INSERT INTO state_leases (scope, lease_key, owner, expires_at, created_at, updated_at)
      SELECT 'perf:scope-' || (i % 40), 'retained-' || i, 'synthetic-owner', 0, 1, 1
      FROM fixture
    `);
    },
    { env },
  );
  const context = captureOpenClawStateWorkerContext({ env });
  const options = {
    scope: "perf:sqlite-lease",
    key: "effect",
    leaseMs: 600_000,
    waitMs: 0,
    heartbeat: "worker",
  };
  const measure = async (lease) => {
    const run = async (count) => {
      for (let index = 0; index < count; index++) {
        await lease.assertOwned();
        lease.assertCurrent();
      }
    };
    await run(100);
    const measuredWorkers = [...workers].filter((worker) => worker.threadId !== -1);
    for (const worker of measuredWorkers) {
      worker.ref();
    }
    globalThis.gc();
    const hostLoad = loadavg();
    const beforeWorkers = await Promise.all(measuredWorkers.map((worker) => worker.cpuUsage()));
    const beforeMain = process.threadCpuUsage();
    const beforeProcess = process.cpuUsage();
    const started = performance.now();
    await run(iterations);
    const elapsedMs = performance.now() - started;
    const mainThreadCpuMs = cpuMs(process.threadCpuUsage(beforeMain));
    const processCpuMs = cpuMs(process.cpuUsage(beforeProcess));
    const workerUsed = await Promise.all(
      measuredWorkers.map((worker, index) => worker.cpuUsage(beforeWorkers[index])),
    );
    globalThis.gc();
    inspector.connect();
    for (const worker of measuredWorkers) {
      profiles.push(
        await worker.startHeapProfile({
          sampleInterval: 4096,
          forceGC: true,
          includeObjectsCollectedByMajorGC: true,
          includeObjectsCollectedByMinorGC: true,
        }),
      );
    }
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    await run(iterations);
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const sampledHostBytes = bytes(profile);
    let sampledWorkerBytes = 0;
    while (profiles.length) {
      sampledWorkerBytes += bytes(JSON.parse(await profiles.pop().stop()));
    }
    for (const key of [
      "statSync",
      "lstatSync",
      "fstatSync",
      "openSync",
      "readSync",
      "readFileSync",
      "realpathSync",
      "closeSync",
      "futimesSync",
    ]) {
      wrap(fs, key);
    }
    wrap(fs.realpathSync, "native");
    syncBuiltinESMExports();
    operations = 0;
    await run(iterations);
    const hostSyncOperations = operations;
    await immediate();
    injectedDelay = delayMs;
    operations = 0;
    const delayedStart = performance.now();
    const beat = immediate().then(() => performance.now() - delayedStart);
    await run(1);
    const admissionMs = performance.now() - delayedStart;
    const beatMs = await beat;
    injectedDelay = 0;
    console.log(
      JSON.stringify({
        iterations,
        retainedLeaseKeys: 10000,
        leaseScopes: 40,
        hostLoad,
        measuredWorkers: measuredWorkers.length,
        timing: {
          elapsedMs,
          hostSyncOperations,
          mainThreadCpuMs,
          workerCpuMs: workerUsed.reduce((sum, value) => sum + cpuMs(value), 0),
          processCpuMs,
        },
        allocation: {
          hostBytesPerAdmission: sampledHostBytes / iterations,
          workerBytesPerAdmission: sampledWorkerBytes / iterations,
          totalBytesPerAdmission: (sampledHostBytes + sampledWorkerBytes) / iterations,
        },
        hostWriteback: { delayPerCallMs: delayMs, operations, admissionMs, beatMs },
      }),
    );
    for (const restore of restores.splice(0).toReversed()) {
      restore();
    }
    syncBuiltinESMExports();
  };
  if (values.baseline) {
    await withOpenClawStateLease(
      { ...options, database: { scope: "shared", options: { path: databasePath, env } } },
      measure,
    );
  } else {
    await withOpenClawStateLeaseAsync(options, context, measure);
  }
} finally {
  injectedDelay = 0;
  for (const profile of profiles) {
    await profile[Symbol.asyncDispose]();
  }
  inspector.disconnect();
  for (const restore of restores.toReversed()) {
    restore();
  }
  syncBuiltinESMExports();
  process.removeListener("worker", observeWorker);
  await closeOpenClawStateDatabaseAsync();
  owner.release();
  for (const worker of workers) {
    worker.unref();
  }
  fs.rmSync(root, { recursive: true, force: true });
}
