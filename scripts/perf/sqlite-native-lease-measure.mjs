/**
 * Native versus worker-owned runtime lease verification with real synthetic SQLite.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/sqlite-native-lease-measure.mjs
 *   [--baseline] [--iterations 2000] [--delay-ms 20]
 * --existing-read measures executeExistingOpenClawStateRead with no host SQLite
 * handle. --owner-dir selects a sparse source overlay for before/after runs.
 * --trace-io prints synchronous call stacks only during the delayed probe.
 * --assert-no-host-io requires zero warm main-thread filesystem and SQLite calls.
 * --assert-no-source-io fails if warm reads synchronously inspect the state DB.
 * --delay-source-only injects latency only for that file; other host I/O is counted.
 * Read fixtures include the quarantine store normally created during agent DB
 * setup; --missing-quarantine separately exercises an empty installation.
 *
 * --baseline selects the native lease API; omit it for the async counterpart.
 * Compare native revisions with --baseline on both arms and --owner-dir on base.
 * Seed 10,000 retained lease keys across 40 scopes, then warm one
 * held lease before measuring repeated effect admission.
 * CPU, sampled allocation, and filesystem counts use separate passes. Counting
 * wrappers are absent from CPU/allocation measurement. A final operation
 * injects latency into host synchronous filesystem/SQLite calls and awaited stats. This is an owner
 * benchmark, not Gateway load. State stays under .local and is removed on exit.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { syncBuiltinESMExports } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { setImmediate as immediate, setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    baseline: { type: "boolean", default: false },
    iterations: { type: "string", default: "2000" },
    "delay-ms": { type: "string", default: "20" },
    "existing-read": { type: "boolean", default: false },
    "owner-dir": { type: "string" },
    "trace-io": { type: "boolean", default: false },
    "assert-no-host-io": { type: "boolean", default: false },
    "assert-no-source-io": { type: "boolean", default: false },
    "delay-source-only": { type: "boolean", default: false },
    "missing-quarantine": { type: "boolean", default: false },
  },
});
if (values["owner-dir"]) {
  process.env.OPENCLAW_BENCH_BASELINE_DIR = path.resolve(values["owner-dir"]);
  await import("./worker-retained-heap-preload.ts");
}
const { readGatewayLockProcessNamespace } = await import("../../src/infra/gateway-lock-payload.ts");
const { acquireGatewayStateOwner } = await import("../../src/infra/gateway-state-owner.ts");
const {
  openOpenClawStateDatabase,
  closeOpenClawStateDatabaseAsync,
  runOpenClawStateWriteTransaction,
} = await import("../../src/state/openclaw-state-db.ts");
const { withOpenClawStateLease, withOpenClawStateLeaseAsync } =
  await import("../../src/state/openclaw-state-lease.ts");
const { executeExistingOpenClawStateRead } =
  await import("../../src/state/openclaw-state-db-readonly.ts");
const { captureOpenClawStateWorkerContext } =
  await import("../../src/state/openclaw-state-worker-context.ts");
const { requireNodeSqlite } = await import("../../src/infra/node-sqlite.ts");
const { ensureOpenClawQuarantineStore } =
  await import("../../src/state/openclaw-quarantine-store.ts");
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
let sqliteCalls = 0;
let sqliteOpens = 0;
let sourceOperations = 0;
let asyncStats = 0;
const blocked = new Int32Array(new SharedArrayBuffer(4));
const wrap = (object, key, sqlite = false) => {
  const original = object[key];
  const wrapped = function (...args) {
    if (sqlite) {
      sqliteCalls++;
    } else {
      operations++;
    }
    const source = args[0] === databasePath;
    if (source) {
      sourceOperations++;
    }
    if (injectedDelay && (sqlite || !values["delay-source-only"] || source)) {
      if (values["trace-io"]) {
        console.error(
          new Error(`Synchronous ${sqlite ? "SQLite" : "filesystem"} call: ${key}`).stack,
        );
      }
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
  if (values["existing-read"] && !values["missing-quarantine"]) {
    ensureOpenClawQuarantineStore(env);
  }
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
  if (values["existing-read"]) {
    await closeOpenClawStateDatabaseAsync();
  }
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
        if (values["existing-read"]) {
          const result = await executeExistingOpenClawStateRead({ env }, { type: "backup.runs" });
          assert(result?.ok && result.type === "backup.runs");
        } else {
          await lease.assertOwned();
          lease.assertCurrent();
        }
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
    for (const key of Object.keys(fs).filter(
      (name) => name.endsWith("Sync") && typeof fs[name] === "function",
    )) {
      wrap(fs, key);
    }
    const sqlite = requireNodeSqlite();
    const DatabaseSync = sqlite.DatabaseSync;
    sqlite.DatabaseSync = new Proxy(DatabaseSync, {
      construct(target, args, receiver) {
        sqliteOpens++;
        if (injectedDelay) {
          Atomics.wait(blocked, 0, 0, injectedDelay);
        }
        return Reflect.construct(target, args, receiver);
      },
    });
    restores.push(() => {
      sqlite.DatabaseSync = DatabaseSync;
    });
    for (const key of ["exec", "prepare", "open", "close"]) {
      wrap(DatabaseSync.prototype, key, true);
    }
    for (const key of ["run", "get", "all", "iterate"]) {
      wrap(sqlite.StatementSync.prototype, key, true);
    }
    const originalStat = fs.promises.stat;
    fs.promises.stat = async (...args) => {
      asyncStats++;
      if (injectedDelay && (!values["delay-source-only"] || args[0] === databasePath)) {
        await sleep(injectedDelay);
      }
      return originalStat(...args);
    };
    restores.push(() => {
      fs.promises.stat = originalStat;
    });
    wrap(fs.realpathSync, "native");
    syncBuiltinESMExports();
    operations = 0;
    sqliteCalls = 0;
    sqliteOpens = 0;
    sourceOperations = 0;
    asyncStats = 0;
    await run(iterations);
    const hostSyncOperations = operations;
    const hostSqliteCalls = sqliteCalls;
    const hostSqliteOpens = sqliteOpens;
    const sourceSyncOperations = sourceOperations;
    const hostAsyncStats = asyncStats;
    await immediate();
    injectedDelay = delayMs;
    operations = 0;
    sqliteCalls = 0;
    sqliteOpens = 0;
    sourceOperations = 0;
    asyncStats = 0;
    const delayedStart = performance.now();
    let lastBeat = delayedStart;
    let maxBeatGapMs = 0;
    const heartbeat = setInterval(() => {
      const now = performance.now();
      maxBeatGapMs = Math.max(maxBeatGapMs, now - lastBeat);
      lastBeat = now;
    }, 1);
    await run(1);
    const admissionMs = performance.now() - delayedStart;
    injectedDelay = 0;
    await sleep(2);
    clearInterval(heartbeat);
    console.log(
      JSON.stringify({
        iterations,
        entry: values["existing-read"] ? "existing-state-read" : "lease-verification",
        retainedLeaseKeys: 10000,
        leaseScopes: 40,
        hostLoad,
        measuredWorkers: measuredWorkers.length,
        timing: {
          elapsedMs,
          hostSyncOperations,
          hostSqliteCalls,
          hostSqliteOpens,
          sourceSyncOperations,
          hostAsyncStats,
          mainThreadCpuMs,
          workerCpuMs: workerUsed.reduce((sum, value) => sum + cpuMs(value), 0),
          processCpuMs,
        },
        allocation: {
          hostBytesPerAdmission: sampledHostBytes / iterations,
          workerBytesPerAdmission: sampledWorkerBytes / iterations,
          totalBytesPerAdmission: (sampledHostBytes + sampledWorkerBytes) / iterations,
        },
        hostWriteback: {
          delayPerCallMs: delayMs,
          sourceOnly: values["delay-source-only"],
          operations,
          sqliteCalls,
          sqliteOpens,
          sourceOperations,
          asyncStats,
          admissionMs,
          maxBeatGapMs,
        },
      }),
    );
    if (values["assert-no-host-io"]) {
      assert.deepEqual(
        { hostSyncOperations, hostSqliteCalls, hostSqliteOpens },
        { hostSyncOperations: 0, hostSqliteCalls: 0, hostSqliteOpens: 0 },
        "Warm reads must not perform synchronous host filesystem or SQLite work",
      );
    }
    if (values["assert-no-source-io"]) {
      assert.equal(
        sourceSyncOperations,
        0,
        "Warm reads must not synchronously inspect the state DB",
      );
    }
    for (const restore of restores.splice(0).toReversed()) {
      restore();
    }
    syncBuiltinESMExports();
  };
  if (values["existing-read"]) {
    await measure();
  } else if (values.baseline) {
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
