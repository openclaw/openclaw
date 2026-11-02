/**
 * Linux worker-owner procfs overhead; synthetic SQLite only.
 * node --expose-gc scripts/perf/sqlite-reader-io-measure.mjs --root /isolated/fixture --prepare
 * Creates ~35 GiB, 5,000 interleaved sessions. --gib 0.1 is a quick smoke only.
 * Five A1/B/A2 passes compare two real helper snapshots against no snapshots.
 * Timing and sampled V8 allocation are separate; native SQLite allocation excluded.
 * Acceptance: exact per-thread byte attribution, <50us CPU/op instrumentation,
 * no >20% CPU/time regression for session scans; report tiny-query overhead separately.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, statfsSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { availableParallelism, freemem, loadavg, totalmem } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    prepare: { type: "boolean" },
    gib: { type: "string", default: "35" },
    samples: { type: "string", default: "5" },
    "owner-module": { type: "string" },
  },
});
assert(values.root, "--root must name a task-owned synthetic fixture directory");
const root = path.resolve(values.root);
const filename = path.join(root, "synthetic-reader.sqlite");
const sessions = 5000;
const payloadBytes = 1024 * 1024;
const events = Math.ceil(Number(values.gib) * 1024);
assert(events > 0 && events < 1024 * 1024);

if (isMainThread) {
  assert.equal(process.platform, "linux", "Physical read proof requires Linux procfs");
  if (values.prepare) {
    assert(!existsSync(root), "Refusing to replace existing fixture");
    mkdirSync(root, { recursive: true });
    const db = new DatabaseSync(filename);
    db.exec(
      "PRAGMA journal_mode=OFF; CREATE TABLE events(session_id INTEGER, seq INTEGER, payload BLOB); CREATE INDEX session_events ON events(session_id,seq)",
    );
    const insert = db.prepare("INSERT INTO events VALUES(?,?,?)");
    const payload = randomBytes(payloadBytes);
    const started = performance.now();
    for (let offset = 0; offset < events; offset += 128) {
      db.exec("BEGIN");
      for (let index = offset; index < Math.min(events, offset + 128); index++) {
        insert.run(index % sessions, Math.floor(index / sessions), payload);
      }
      db.exec("COMMIT");
    }
    db.close();
    console.log(
      JSON.stringify({
        phase: "prepared",
        elapsedMs: performance.now() - started,
        events,
        sessions,
        bytes: statSync(filename).size,
      }),
    );
  }
  console.log(
    JSON.stringify({
      phase: "host",
      node: process.version,
      platform: process.platform,
      availableParallelism: availableParallelism(),
      totalmem: totalmem(),
      freemem: freemem(),
      loadavg: loadavg(),
      filesystemType: statfsSync(root).type,
      bytes: statSync(filename).size,
      helperSha256: createHash("sha256")
        .update(readFileSync("src/infra/thread-disk-io.ts"))
        .digest("hex"),
    }),
  );
  const worker = new Worker(new URL(import.meta.url), {
    workerData: { filename, events },
    argv: process.argv.slice(2),
  });
  worker.on("message", (record) => console.log(JSON.stringify(record)));
  await new Promise((resolve, reject) => {
    worker.on("error", reject);
    worker.on("exit", (code) => (code ? reject(new Error(`worker exit ${code}`)) : resolve()));
  });
} else {
  const { readThreadDiskReadBytes } = await import("../../src/infra/thread-disk-io.ts");
  const db = new DatabaseSync(workerData.filename, { readOnly: true });
  db.exec("PRAGMA mmap_size=0; PRAGMA cache_size=-2048");
  // substr forces payload page reads; length(blob) alone only visits headers.
  const query = db.prepare(
    "SELECT sum(length(substr(payload,1))) AS bytes FROM events WHERE session_id < ?",
  );
  const tiny = db.prepare("SELECT count(*) AS rows FROM events WHERE session_id=?");
  const sampleCount = Number(values.samples);
  const heap = new Session();
  heap.connect();
  const sumHeap = (node) =>
    node.selfSize + node.children.reduce((sum, child) => sum + sumHeap(child), 0);
  let observedBytes = 0;
  const run = (scenario, sampled, count) => {
    for (let index = 0; index < count; index++) {
      const before = sampled ? readThreadDiskReadBytes() : undefined;
      if (scenario !== "counter") {
        db.exec("BEGIN");
      }
      if (scenario === "tiny") {
        tiny.get(index % sessions);
      }
      if (scenario === "scan") {
        query.get(Math.min(16, workerData.events));
      }
      if (scenario !== "counter") {
        db.exec("COMMIT");
      }
      if (sampled) {
        observedBytes += readThreadDiskReadBytes() - before;
      }
    }
  };
  for (const scenario of ["counter", "tiny", "scan"]) {
    const count = scenario === "scan" ? 3 : 10000;
    run(scenario, true, scenario === "scan" ? 1 : 1000);
    for (let sample = 0; sample < sampleCount; sample++) {
      for (const label of ["A1", "B", "A2"]) {
        global.gc?.();
        observedBytes = 0;
        const before = process.threadCpuUsage();
        const started = performance.now();
        run(scenario, label === "B", count);
        const elapsedMs = performance.now() - started;
        const cpu = process.threadCpuUsage(before);
        parentPort.postMessage(
          {
            phase: "timing",
            scenario,
            sample,
            label,
            count,
            usPerOp: (elapsedMs * 1000) / count,
            cpuUsPerOp: (cpu.user + cpu.system) / count,
            observedBytes,
            loadavg: loadavg(),
          },
          [],
        );
      }
    }
    for (const label of ["A1", "B", "A2"]) {
      await heap.post("HeapProfiler.startSampling", {
        samplingInterval: 512,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
      run(scenario, label === "B", count);
      const { profile } = await heap.post("HeapProfiler.stopSampling");
      parentPort.postMessage(
        {
          phase: "allocation",
          scenario,
          label,
          count,
          sampledBytesPerOp: sumHeap(profile.head) / count,
        },
        [],
      );
    }
  }
  // Evict only this owned fixture from the OS cache, never global drop_caches.
  db.close();
  const evict = spawnSync(
    "python3",
    [
      "-c",
      "import os,sys; f=os.open(sys.argv[1],os.O_RDONLY); os.fsync(f); os.posix_fadvise(f,0,0,os.POSIX_FADV_DONTNEED); os.close(f)",
      workerData.filename,
    ],
    { encoding: "utf8" },
  );
  assert.equal(evict.status, 0, evict.stderr);
  const cold = new DatabaseSync(workerData.filename, { readOnly: true });
  cold.exec("PRAGMA mmap_size=0; PRAGMA cache_size=-2048");
  const ownerModule = values["owner-module"] ? await import(values["owner-module"]) : undefined;
  const before = readThreadDiskReadBytes();
  const selected = Math.min(16, workerData.events);
  const read = () =>
    cold
      .prepare("SELECT sum(length(substr(payload,1))) AS bytes FROM events WHERE session_id < ?")
      .get(selected);
  const result = ownerModule
    ? ownerModule.withSqliteReaderOwner(
        { operation: "synthetic.session-scan", ownerKind: "worker" },
        read,
        { agentId: "synthetic", sessions: selected, rows: Math.ceil(events / sessions) * selected },
        ownerModule.createSubsystemLogger("sqlite/transaction"),
      )
    : read();
  const after = readThreadDiskReadBytes();
  parentPort.postMessage(
    {
      phase: "cold-attribution",
      logicalPayloadBytes: result.bytes,
      readBytes: after - before,
      mainProcessReadBytes: Number(
        /^read_bytes: (\d+)$/m.exec(readFileSync("/proc/self/io", "utf8"))[1],
      ),
    },
    [],
  );
  assert(
    after - before >= 64 * 1024 * 1024 || result.bytes < 64 * 1024 * 1024,
    "Production-shaped cold scan must cross heavy-read threshold",
  );
  cold.close();
  heap.disconnect();
}
