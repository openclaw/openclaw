// Synthetic owner benchmark, not a Gateway or btrfs commit benchmark.
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/sqlite-statement-changes-measure.mjs \
//   --root /task-owned/fixture --prepare --gib 35
// Repeat with --owner /path/to/baseline-observation.ts and candidate, interleaved.
// Acceptance: correct counts, no extra SQL, timing/CPU/allocation within A/A spread;
// investigate any >20% increase. Setup, explicit GC and allocation profiling are untimed.
import assert from "node:assert/strict";
import { mkdirSync, statSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    prepare: { type: "boolean" },
    gib: { type: "string", default: "35" },
    owner: { type: "string" },
    mode: { type: "string", default: "timing" },
    label: { type: "string", default: "candidate" },
  },
});
assert(values.root && globalThis.gc, "Supply --root and --expose-gc");
assert(["timing", "allocation"].includes(values.mode));
const root = path.resolve(values.root);
mkdirSync(root, { recursive: true });
const filename = path.join(root, "synthetic.sqlite");
const db = new DatabaseSync(filename);
try {
  if (values.prepare) {
    // Setup is synthetic and outside measurement; this file must be new.
    db.exec(`PRAGMA journal_mode = OFF;
      CREATE TABLE transcript (id INTEGER PRIMARY KEY, session INTEGER, payload BLOB);
      CREATE TABLE audit (id INTEGER PRIMARY KEY, session INTEGER, payload TEXT);
      BEGIN`);
    const ballast = db.prepare("INSERT INTO transcript VALUES (?, ?, zeroblob(1048576))");
    for (let index = 0; index < Math.ceil(Number(values.gib) * 1024); index++) {
      ballast.run(index, index % 5000);
    }
    const insert = db.prepare("INSERT INTO audit VALUES (?, ?, ?)");
    for (let index = 0; index < 100_000; index++) {
      insert.run(index, index % 5000, "synthetic audit event ".repeat(16));
    }
    db.exec("COMMIT");
    console.log(
      JSON.stringify({ fixtureBytes: statSync(filename).size, sessions: 5000, auditRows: 100_000 }),
    );
  } else {
    db.exec("PRAGMA journal_mode = WAL");
    const owner = values.owner
      ? pathToFileURL(path.resolve(values.owner))
      : new URL("../../src/infra/database-engine/observation.ts", import.meta.url);
    const { observeConnection, startSqliteStatementTiming } = await import(owner.href);
    observeConnection(db);
    const remove = db.prepare("DELETE FROM audit WHERE id >= ? AND id < ?");
    remove.setReadBigInts(true); // Kysely's write-result mode.
    const read = db.prepare("SELECT id FROM audit WHERE id = ?");
    let observedChanges = 0;
    let observedRows = 0;
    let statements = 0;
    function run() {
      observedChanges = observedRows = statements = 0;
      db.exec("BEGIN IMMEDIATE");
      try {
        for (let hold = 0; hold < 1000; hold++) {
          const stop = startSqliteStatementTiming();
          const first = hold * 100;
          remove.run(first, first + 100);
          read.get(first);
          const summary = stop().summarize();
          statements += summary.count;
          for (const entry of summary.statements) {
            observedChanges += entry.changes ?? 0;
            observedRows += entry.rows ?? 0;
          }
        }
      } finally {
        db.exec("ROLLBACK");
      }
      assert.equal(statements, 2000);
      assert.equal(observedRows, 0);
      assert([0, 100_000].includes(observedChanges));
    }
    run(); // Warm the same pages, SQL and collector before each trial.
    globalThis.gc();
    const inspector = values.mode === "allocation" ? new Session() : undefined;
    if (inspector) {
      inspector.connect();
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 512,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    const hostLoad = loadavg();
    const cpu = process.threadCpuUsage();
    const start = performance.now();
    run();
    const elapsedMs = performance.now() - start;
    const used = process.threadCpuUsage(cpu);
    let sampledAllocationBytes;
    if (inspector) {
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      const sum = (node) =>
        node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
      sampledAllocationBytes = sum(profile.head);
      inspector.disconnect();
    }
    console.log(
      JSON.stringify({
        label: values.label,
        mode: values.mode,
        fixtureBytes: statSync(filename).size,
        hostLoad,
        statements,
        observedChanges,
        observedRows,
        elapsedMs: values.mode === "timing" ? elapsedMs : undefined,
        cpuMs: values.mode === "timing" ? (used.user + used.system) / 1000 : undefined,
        sampledAllocationBytes,
        maxRssKiB: process.resourceUsage().maxRSS,
      }),
    );
  }
} finally {
  db.close();
}
