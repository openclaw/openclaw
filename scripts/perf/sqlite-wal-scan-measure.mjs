/**
 * WAL sidecar scan responsiveness under synthetic metadata writeback latency.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/sqlite-wal-scan-measure.mjs
 *   [--owner /path/to/sqlite-wal-split-brain.ts] [--iterations 2000] [--delay-ms 5]
 *
 * Run unchanged on base/candidate in alternating order. A synthetic Linux proc
 * table models 128 process descriptors, including a database's WAL and SHM.
 * Timing/CPU and sampled allocation passes exclude injected latency; a separate
 * delayed scan reports how long a queued main-thread heartbeat is held up.
 * These are owner costs and a fault-injection reproduction, not Gateway load.
 * No actual database, process descriptor, or operator state is modified.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { syncBuiltinESMExports } from "node:module";
import { loadavg } from "node:os";
import { setImmediate as immediate, setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    iterations: { type: "string", default: "2000" },
    "delay-ms": { type: "string", default: "5" },
  },
});
assert(globalThis.gc, "Run with --expose-gc");
const iterations = Number(values.iterations);
const latencyMs = Number(values["delay-ms"]);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(Number.isFinite(latencyMs) && latencyMs >= 0);
const databasePath = "/synthetic/team/state.sqlite";
const names = Array.from({ length: 128 }, (_, index) => String(index));
const links = new Map(
  names.map((name) => [
    `/proc/self/fd/${name}`,
    name === "126" ? `${databasePath}-wal` : name === "127" ? `${databasePath}-shm` : "/dev/null",
  ]),
);
const physical = { nlink: 1n, dev: 1n, ino: 42n };
const blocked = new Int32Array(new SharedArrayBuffer(4));
let delayMs = 0;
let operations = 0;
const sync = (result) => {
  operations++;
  if (delayMs) {
    Atomics.wait(blocked, 0, 0, delayMs);
  }
  return result;
};
const asyncResult = async (result) => {
  operations++;
  if (delayMs) {
    await sleep(delayMs);
  }
  return result;
};
const originals = {
  readdirSync: fs.readdirSync,
  readlinkSync: fs.readlinkSync,
  fstatSync: fs.fstatSync,
  statSync: fs.statSync,
  fstat: fs.fstat,
  readdir: fs.promises.readdir,
  readlink: fs.promises.readlink,
  stat: fs.promises.stat,
};
// Import the owner after instrumentation so its promisified fstat uses this layer.
fs.readdirSync = (pathname, ...args) =>
  pathname === "/proc/self/fd" ? sync([...names]) : originals.readdirSync(pathname, ...args);
fs.readlinkSync = (pathname, ...args) =>
  links.has(pathname) ? sync(links.get(pathname)) : originals.readlinkSync(pathname, ...args);
fs.fstatSync = (fd, ...args) =>
  fd === 126 || fd === 127 ? sync(physical) : originals.fstatSync(fd, ...args);
fs.statSync = (pathname, ...args) =>
  pathname === `${databasePath}-wal` || pathname === `${databasePath}-shm`
    ? sync(physical)
    : originals.statSync(pathname, ...args);
fs.fstat = (fd, options, callback) => {
  if (fd !== 126 && fd !== 127) {
    originals.fstat(fd, options, callback);
    return;
  }
  void asyncResult(physical).then((result) => callback(null, result));
};
fs.promises.readdir = (pathname, ...args) =>
  pathname === "/proc/self/fd" ? asyncResult([...names]) : originals.readdir(pathname, ...args);
fs.promises.readlink = (pathname, ...args) =>
  links.has(pathname) ? asyncResult(links.get(pathname)) : originals.readlink(pathname, ...args);
fs.promises.stat = (pathname, ...args) =>
  pathname === `${databasePath}-wal` || pathname === `${databasePath}-shm`
    ? asyncResult(physical)
    : originals.stat(pathname, ...args);
syncBuiltinESMExports();

const owner = values.owner
  ? pathToFileURL(values.owner)
  : new URL("../../src/infra/sqlite-wal-split-brain.ts", import.meta.url);
const { detectSqliteWalSplitBrain: scan } = await import(owner.href);
const run = async (count) => {
  for (let i = 0; i < count; i++) {
    assert.equal(await scan(databasePath), undefined);
  }
};
const inspector = new Session();
try {
  await run(100);
  globalThis.gc();
  operations = 0;
  const hostLoad = loadavg();
  const cpu = process.threadCpuUsage();
  const started = performance.now();
  await run(iterations);
  const elapsedMs = performance.now() - started;
  const used = process.threadCpuUsage(cpu);
  const timingOperations = operations;
  globalThis.gc();
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 4096,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  await run(iterations);
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  let allocatedBytes = 0;
  const pending = [profile.head];
  while (pending.length) {
    const node = pending.pop();
    allocatedBytes += node.selfSize;
    pending.push(...node.children);
  }
  await immediate();
  delayMs = latencyMs;
  operations = 0;
  const delayedStart = performance.now();
  const heartbeat = immediate().then(() => performance.now() - delayedStart);
  await run(1);
  const delayedScanMs = performance.now() - delayedStart;
  const heartbeatDelayMs = await heartbeat;
  console.log(
    JSON.stringify({
      owner: owner.pathname,
      iterations,
      descriptors: names.length,
      hostLoad,
      timing: {
        elapsedMs,
        mainThreadCpuMs: (used.user + used.system) / 1000,
        operations: timingOperations,
      },
      allocation: { sampledBytes: allocatedBytes, bytesPerScan: allocatedBytes / iterations },
      writeback: { perOperationDelayMs: latencyMs, operations, delayedScanMs, heartbeatDelayMs },
    }),
  );
} finally {
  inspector.disconnect();
  for (const key of ["readdirSync", "readlinkSync", "fstatSync", "statSync", "fstat"]) {
    fs[key] = originals[key];
  }
  for (const key of ["readdir", "readlink", "stat"]) {
    fs.promises[key] = originals[key];
  }
  syncBuiltinESMExports();
}
