/**
 * Native commit-delay owner experiment; no operator state or live Gateway.
 * node scripts/perf/state-lease-commit-measure.mjs --out .local/lane2202 --samples 5
 *
 * Uses the production renewal scheduler and real SQLite connections. A synthetic
 * five-minute lease is time-scaled 50x: TTL 6000ms, former capped interval 600ms,
 * TTL/3 interval 2000ms. A native fsync shim delays WAL syncs by 400ms. Foreground
 * writes use a separate NORMAL connection; their timing includes native writer
 * lock waits, not the Gateway's host-admission FIFO or RPC latency. Both arms
 * preserve FULL lease durability. Two registrations represent the Gateway owner
 * and an ordinary long lease; both use the selected cadence. The scheduler is
 * unchanged between arms: this isolates cadence inputs, while integration tests
 * must separately prove those inputs come from the production lease owners.
 * The 1GiB payload and 10k retained lease rows
 * exercise a populated state store; no agent DB or workspace scan is involved.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

const script = fileURLToPath(import.meta.url);
const { values } = parseArgs({
  options: {
    out: { type: "string", default: ".local/lane2202" },
    samples: { type: "string", default: "5" },
    mib: { type: "string", default: "1024" },
    "delay-ms": { type: "string", default: "400" },
    "duration-ms": { type: "string", default: "12000" },
    child: { type: "string" },
  },
});
const root = path.resolve(workerData?.root ?? values.out);
const databasePath = path.join(root, "lease.sqlite");
const marker = path.join(root, "delay-enabled");
const nativeLog = path.join(root, "native-syncs.jsonl");
const leaseMs = 6000;
const percentile = (xs, q) =>
  xs.toSorted((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * q))] ?? 0;
const cpuMs = (x) => (x.user + x.system) / 1000;
function sampledBytes(profile) {
  let size = 0;
  const pending = [profile.head];
  while (pending.length) {
    const node = pending.pop();
    size += node.selfSize;
    pending.push(...node.children);
  }
  return size;
}

if (!isMainThread) {
  const { openNodeSqliteDatabase } = await import("../../src/infra/node-sqlite.ts");
  const { admitSqliteSchema } = await import("../../src/infra/sqlite-schema-facts.ts");
  const { enableNodeSqliteKyselyStatementCache } =
    await import("../../src/infra/kysely-sync-cache-state.ts");
  const { isSqliteLockError } = await import("../../src/infra/sqlite-error-diagnostics.ts");
  const { createStateLeaseRenewalScheduler } =
    await import("../../src/state/openclaw-state-lease-renewal.worker.ts");
  const db = openNodeSqliteDatabase(databasePath);
  enableNodeSqliteKyselyStatementCache(db);
  admitSqliteSchema(db);
  const synchronous = db.prepare("PRAGMA synchronous").get().synchronous;
  const journalMode = db.prepare("PRAGMA journal_mode").get().journal_mode;
  const autoCheckpointPages = db.prepare("PRAGMA wal_autocheckpoint").get().wal_autocheckpoint;
  const scheduler = createStateLeaseRenewalScheduler(db);
  const inspector = new Session();
  inspector.connect();
  let started = false;
  let stopAt = Infinity;
  let cpu;
  let commits = 0;
  let failures = 0;
  let contentions = 0;
  const errors = [];
  const retries = new Set();
  // Harness-only lock retry: rejoin the batch after 50ms while its persisted row
  // is unexpired. The heartbeat carrier instead retries each entry explicitly;
  // report contention callbacks so this difference remains visible in evidence.
  function retry(entry, error) {
    const expiresAt = db
      .prepare("SELECT expires_at FROM state_leases WHERE scope=? AND lease_key=? AND owner=?")
      .get(entry.identity.scope, entry.identity.key, entry.identity.owner)?.expires_at;
    if (isSqliteLockError(error) && expiresAt > Date.now()) {
      contentions++;
      if (!started || Date.now() >= stopAt) {
        return;
      }
      const timer = setTimeout(() => {
        retries.delete(timer);
        if (started) {
          scheduler.schedule(entry, expiresAt);
        }
      }, 50);
      retries.add(timer);
    } else {
      failures++;
      errors.push(String(error));
    }
  }
  let expired = 0;
  const durations = [];
  const gateway = {
    identity: { scope: "perf:renew", key: "gateway", owner: "synthetic" },
    leaseMs,
    intervalMs: workerData.intervalMs,
    execute(operation) {
      const t = performance.now();
      try {
        return operation();
      } finally {
        durations.push(performance.now() - t);
      }
    },
    complete(outcome) {
      if ("error" in outcome) {
        retry(gateway, outcome.error);
        return;
      }
      if (outcome.expiresAt === undefined) {
        expired++;
        return;
      }
      if (started && Date.now() < stopAt) {
        scheduler.schedule(gateway, outcome.expiresAt);
      }
    },
  };
  const entry = {
    identity: { scope: "perf:renew", key: "held", owner: "synthetic" },
    leaseMs,
    intervalMs: workerData.intervalMs,
    execute(operation) {
      const t = performance.now();
      try {
        return operation();
      } finally {
        durations.push(performance.now() - t);
      }
    },
    complete(outcome) {
      if ("error" in outcome) {
        retry(entry, outcome.error);
        return;
      }
      if (outcome.expiresAt === undefined) {
        expired++;
        return;
      }
      commits++;
      if (started && Date.now() < stopAt) {
        scheduler.schedule(entry, outcome.expiresAt);
      }
    },
  };
  parentPort.on("message", (message) => {
    void handleMessage(message);
  });
  async function handleMessage(message) {
    if (message === "start") {
      db.prepare("UPDATE state_leases SET expires_at=? WHERE scope='perf:renew'").run(
        Date.now() + leaseMs,
      );
      await Promise.all(
        [entry, gateway].map(
          (target) =>
            new Promise((resolve, reject) => {
              scheduler.schedule(
                {
                  ...target,
                  intervalMs: 1,
                  complete(outcome) {
                    if ("error" in outcome || outcome.expiresAt === undefined) {
                      reject(new Error("Warm renewal failed"));
                    } else {
                      resolve();
                    }
                  },
                },
                Date.now() + leaseMs,
              );
            }),
        ),
      );
      durations.length = 0;
      cpu = process.threadCpuUsage();
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 4096,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
      started = true;
      stopAt = Date.now() + workerData.durationMs;
      const expiresAt = Date.now() + leaseMs;
      db.prepare(
        "UPDATE state_leases SET expires_at=? WHERE scope='perf:renew' AND lease_key='held'",
      ).run(expiresAt);
      db.prepare(
        "UPDATE state_leases SET expires_at=? WHERE scope='perf:renew' AND lease_key='gateway'",
      ).run(expiresAt);
      scheduler.schedule(gateway, expiresAt);
      scheduler.schedule(entry, expiresAt);
      parentPort.postMessage({ ready: true, synchronous, journalMode, autoCheckpointPages }, []);
    } else if (message === "stop") {
      started = false;
      for (const timer of retries) {
        clearTimeout(timer);
      }
      retries.clear();
      scheduler.cancel(entry);
      scheduler.cancel(gateway);
      const used = process.threadCpuUsage(cpu);
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      inspector.disconnect();
      db.close();
      parentPort.postMessage(
        {
          done: true,
          commits,
          failures,
          contentions,
          errors,
          expired,
          durations,
          cpuMs: cpuMs(used),
          sampledBytes: sampledBytes(profile),
        },
        [],
      );
      parentPort.close();
    }
  }
} else if (values.child) {
  assert(fs.existsSync(databasePath));
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA synchronous=NORMAL; PRAGMA wal_autocheckpoint=0; PRAGMA busy_timeout=30000;");
  const update = db.prepare("UPDATE foreground SET value=? WHERE id=1");
  update.run(-1);
  const worker = new Worker(new URL(import.meta.url), {
    workerData: {
      root,
      durationMs: Number(values["duration-ms"]),
      intervalMs: values.child === "base" ? 600 : 2000,
    },
    execArgv: ["--import", new URL("../tsx.mjs", import.meta.url).href],
  });
  const nextMessage = () =>
    new Promise((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
    });
  let ready = nextMessage();
  worker.postMessage("start", []);
  ready = await ready;
  assert(ready.ready && ready.synchronous === 2 && ready.journalMode === "wal");
  fs.writeFileSync(marker, "1");
  const cpu = process.threadCpuUsage();
  const inspector = new Session();
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 4096,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  const waits = [];
  const started = performance.now();
  // Fixed offered count avoids a slower arm reporting lower work as a win.
  const writes = Math.floor(Number(values["duration-ms"]) / 50);
  for (let i = 0; i < writes; i++) {
    await sleep(Math.max(0, started + i * 50 - performance.now()));
    const t = performance.now();
    update.run(i);
    waits.push(performance.now() - t);
  }
  const elapsedMs = performance.now() - started;
  const mainCpuMs = cpuMs(process.threadCpuUsage(cpu));
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  inspector.disconnect();
  const done = nextMessage();
  worker.postMessage("stop", []);
  const renewal = await done;
  fs.rmSync(marker);
  db.close();
  const syncs = fs.existsSync(nativeLog)
    ? fs.readFileSync(nativeLog, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
    : [];
  console.log(
    JSON.stringify({
      arm: values.child,
      elapsedMs,
      writes,
      waitMedianMs: percentile(waits, 0.5),
      waitP95Ms: percentile(waits, 0.95),
      waitMaxMs: Math.max(...waits),
      waitTotalMs: waits.reduce((a, b) => a + b, 0),
      waitsOver100Ms: waits.filter((x) => x > 100).length,
      mainCpuMs,
      mainSampledBytes: sampledBytes(profile),
      renewal,
      policy: ready,
      syncs,
      load: loadavg(),
    }),
  );
} else {
  fs.mkdirSync(root, { recursive: true });
  assert(!fs.existsSync(databasePath), "Use a new output directory; never overwrite a fixture");
  const db = new DatabaseSync(databasePath);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA wal_autocheckpoint=0;
    CREATE TABLE state_leases(scope TEXT NOT NULL, lease_key TEXT NOT NULL,owner TEXT NOT NULL,expires_at INTEGER,heartbeat_at INTEGER,updated_at INTEGER,payload_json TEXT,PRIMARY KEY(scope,lease_key));
    CREATE TABLE foreground(id INTEGER PRIMARY KEY,value INTEGER);
    INSERT INTO foreground VALUES(1,0);
    CREATE TABLE synthetic_payload(id INTEGER PRIMARY KEY,payload BLOB);
    BEGIN;
    WITH RECURSIVE fixture(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM fixture WHERE i<9999)
    INSERT INTO state_leases SELECT 'retained:'||(i%40),'key:'||i,'synthetic',0,0,0,'{}' FROM fixture;
    INSERT INTO state_leases VALUES('perf:renew','held','synthetic',0,0,0,'{}');
    INSERT INTO state_leases VALUES('perf:renew','gateway','synthetic',0,0,0,'{}');`);
  const insert = db.prepare("INSERT INTO synthetic_payload(payload) VALUES(zeroblob(1048576))");
  for (let i = 0; i < Number(values.mib); i++) {
    insert.run();
  }
  db.exec("COMMIT; PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();
  const library = path.join(root, process.platform === "darwin" ? "delay.dylib" : "delay.so");
  const c = path.join(root, "delay.c");
  fs.writeFileSync(
    c,
    String.raw`
#define _GNU_SOURCE
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <fcntl.h>
#include <dlfcn.h>
#include <sys/time.h>
static void delay_sync(int fd) {
 const char *marker=getenv("LEASE_DELAY_MARKER"), *target=getenv("LEASE_DELAY_TARGET");
 if(!marker || !target || access(marker,F_OK)!=0) return;
 char filename[4096]={0};
#ifdef __APPLE__
 if(fcntl(fd,F_GETPATH,filename)!=0) return;
#else
 char link[64]; snprintf(link,sizeof(link),"/proc/self/fd/%d",fd); ssize_t n=readlink(link,filename,sizeof(filename)-1); if(n<0)return; filename[n]=0;
#endif
 if(strcmp(filename,target)!=0) return;
 int delay=atoi(getenv("LEASE_DELAY_MS"));
 struct timeval t; gettimeofday(&t,NULL);
 usleep(delay*1000);
 const char *log=getenv("LEASE_DELAY_LOG");
 if(log) {int f=open(log,O_WRONLY|O_CREAT|O_APPEND,0600); if(f>=0) {char line[256]; int n=snprintf(line,sizeof(line),"{\"atMs\":%.3f,\"delayMs\":%d}\n",t.tv_sec*1000.0+t.tv_usec/1000.0,delay); write(f,line,n); close(f);}}
}
#ifdef __APPLE__
static int delayed_fsync(int fd) {delay_sync(fd); return fsync(fd);}
__attribute__((used)) static struct {const void *replacement;const void *replacee;} interpose_fsync __attribute__((section("__DATA,__interpose")))={(const void*)&delayed_fsync,(const void*)&fsync};
#else
int fsync(int fd) {static int(*original)(int); if(!original)original=dlsym(RTLD_NEXT,"fsync");delay_sync(fd);return original(fd);}
int fdatasync(int fd) {static int(*original)(int); if(!original)original=dlsym(RTLD_NEXT,"fdatasync");delay_sync(fd);return original(fd);}
#endif
`,
  );
  const compile = spawnSync(
    "cc",
    [
      ...(process.platform === "darwin" ? ["-dynamiclib"] : ["-shared", "-fPIC"]),
      "-O2",
      c,
      "-o",
      library,
      ...(process.platform === "darwin" ? [] : ["-ldl"]),
    ],
    { encoding: "utf8" },
  );
  assert.equal(compile.status, 0, compile.stderr);
  // Two A/A controls precede five serial AB pairs by default.
  const sequence = [
    "base",
    "base",
    ...Array.from({ length: Number(values.samples) }, () => ["base", "candidate"]).flat(),
  ];
  const rows = [];
  for (const [index, arm] of sequence.entries()) {
    fs.rmSync(nativeLog, { force: true });
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        new URL("../tsx.mjs", import.meta.url).href,
        script,
        "--out",
        root,
        "--child",
        arm,
        "--duration-ms",
        values["duration-ms"],
      ],
      {
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        timeout: 180000,
        env: {
          ...process.env,
          [process.platform === "darwin" ? "DYLD_INSERT_LIBRARIES" : "LD_PRELOAD"]: library,
          LEASE_DELAY_MARKER: marker,
          LEASE_DELAY_TARGET: databasePath + "-wal",
          LEASE_DELAY_MS: values["delay-ms"],
          LEASE_DELAY_LOG: nativeLog,
        },
      },
    );
    if (child.status !== 0) {
      throw new Error(`Arm ${index} ${arm}: ${child.stderr}\n${child.stdout}`);
    }
    const row = JSON.parse(child.stdout.trim());
    assert(row.syncs.length > 0, "Native injection did not intercept any WAL sync");
    assert.equal(row.renewal.failures, 0, JSON.stringify(row));
    assert.equal(row.renewal.expired, 0, JSON.stringify(row));
    rows.push({ index, control: index < 2, ...row });
    fs.writeFileSync(
      path.join(root, "results.json"),
      JSON.stringify(
        {
          fixture: {
            mib: Number(values.mib),
            leaseRows: 10002,
            scale: 50,
            ttlMs: leaseMs,
            baseIntervalMs: 600,
            candidateIntervalMs: 2000,
            delayMs: Number(values["delay-ms"]),
            filesystem: "host filesystem; not btrfs",
            databaseBytes: fs.statSync(databasePath).size,
          },
          rows,
        },
        null,
        2,
      ),
    );
    console.log(
      JSON.stringify({
        index,
        arm,
        commits: row.renewal.commits,
        waitP95Ms: row.waitP95Ms,
        waitMaxMs: row.waitMaxMs,
        waitTotalMs: row.waitTotalMs,
        elapsedMs: row.elapsedMs,
      }),
    );
  }
}
