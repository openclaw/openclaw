/**
 * Warm admission cost for the shared state owner used by Gateway worker dispatch.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/sqlite-owner-dispatch-measure.mjs
 *   [--iterations 2000] [--delay-ms 20] [--baseline --owner /path/to/base-owner.ts]
 * Run unchanged on base/candidate in alternating order. One synthetic serving
 * owner represents the shared authority behind many session/plugin requests.
 * CPU and sampled host/worker allocation are separate passes. The injected delay wraps
 * host synchronous filesystem calls only; real worker-delay proof lives in tests.
 * --baseline selects the prior synchronous captured-access API. --owner can load
 * an exact baseline source snapshot with only relative import URLs adjusted.
 * This measures the admission owner, not Gateway throughput.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { syncBuiltinESMExports } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { setImmediate as immediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { readGatewayLockProcessNamespace } from "../../src/infra/gateway-lock-payload.ts";

const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    baseline: { type: "boolean", default: false },
    iterations: { type: "string", default: "2000" },
    "delay-ms": { type: "string", default: "20" },
  },
});
const moduleUrl = values.owner
  ? pathToFileURL(values.owner)
  : new URL("../../src/infra/gateway-state-owner.ts", import.meta.url);
const { acquireGatewayStateOwner, captureStateDatabaseAccess } = await import(moduleUrl.href);
assert(globalThis.gc, "Run with --expose-gc");
const iterations = Number(values.iterations);
const delayMs = Number(values["delay-ms"]);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(Number.isFinite(delayMs) && delayMs >= 0);
fs.mkdirSync(".local", { recursive: true });
const root = fs.mkdtempSync(path.resolve(".local/sqlite-owner-measure-"));
const databasePath = path.join(root, "state", "openclaw.sqlite");
fs.mkdirSync(path.dirname(databasePath), { recursive: true });
fs.writeFileSync(databasePath, "");
let heartbeat;
let readyTimer;
let observeWorker;
const detachReadiness = [];
const ready = new Promise((resolve, reject) => {
  readyTimer = setTimeout(() => reject(new Error("Heartbeat did not start")), 60_000);
  observeWorker = (worker) => {
    worker.once("error", reject);
    const onMessage = (message) => {
      if (message === null) {
        heartbeat = worker;
        resolve();
      }
    };
    worker.on("message", onMessage);
    detachReadiness.push(() => {
      worker.removeListener("message", onMessage);
      worker.removeListener("error", reject);
    });
  };
  process.on("worker", observeWorker);
});
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
const access = captureStateDatabaseAccess(databasePath);
const run = async (count) => {
  for (let i = 0; i < count; i++) {
    if (values.baseline) {
      await access.assertAccessAllowed();
    } else {
      (await access.prepareAccess())();
    }
  }
};
const inspector = new Session();
let workerAllocation;
const allocatedBytes = (profile) => {
  let bytes = 0;
  const pending = [profile.head];
  while (pending.length) {
    const node = pending.pop();
    bytes += node.selfSize;
    pending.push(...node.children);
  }
  return bytes;
};
const restores = [];
const blocked = new Int32Array(new SharedArrayBuffer(4));
let injectedDelay = 0;
let operations = 0;
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
try {
  await ready;
  heartbeat.ref();
  process.removeListener("worker", observeWorker);
  for (const detach of detachReadiness) {
    detach();
  }
  clearTimeout(readyTimer);
  await run(100);
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
  globalThis.gc();
  const hostLoad = loadavg();
  const workerBefore = await heartbeat.cpuUsage();
  const mainBefore = process.threadCpuUsage();
  const processBefore = process.cpuUsage();
  const started = performance.now();
  operations = 0;
  await run(iterations);
  const elapsedMs = performance.now() - started;
  const mainUsed = process.threadCpuUsage(mainBefore);
  const processUsed = process.cpuUsage(processBefore);
  const workerUsed = await heartbeat.cpuUsage(workerBefore);
  const hostSyncOperations = operations;
  globalThis.gc();
  inspector.connect();
  workerAllocation = await heartbeat.startHeapProfile({
    sampleInterval: 4096,
    forceGC: true,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 4096,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  await run(iterations);
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  const sampledBytes = allocatedBytes(profile);
  const sampledWorkerBytes = allocatedBytes(JSON.parse(await workerAllocation.stop()));
  workerAllocation = undefined;
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
      hostLoad,
      timing: {
        elapsedMs,
        hostSyncOperations,
        mainThreadCpuMs: (mainUsed.user + mainUsed.system) / 1000,
        workerCpuMs: (workerUsed.user + workerUsed.system) / 1000,
        processCpuMs: (processUsed.user + processUsed.system) / 1000,
      },
      allocation: {
        sampledHostBytes: sampledBytes,
        sampledWorkerBytes,
        hostBytesPerAdmission: sampledBytes / iterations,
        workerBytesPerAdmission: sampledWorkerBytes / iterations,
        totalBytesPerAdmission: (sampledBytes + sampledWorkerBytes) / iterations,
      },
      hostWriteback: { delayPerCallMs: delayMs, operations, admissionMs, beatMs },
    }),
  );
} finally {
  injectedDelay = 0;
  process.removeListener("worker", observeWorker);
  for (const detach of detachReadiness) {
    detach();
  }
  clearTimeout(readyTimer);
  await workerAllocation?.[Symbol.asyncDispose]();
  inspector.disconnect();
  for (const restore of restores.toReversed()) {
    restore();
  }
  syncBuiltinESMExports();
  owner.release();
  fs.rmSync(root, { recursive: true, force: true });
}
