/**
 * Measure retained shared-state lease opens against a synthetic large database.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/state-db-cache-admission-measure.ts
 *   --state-dir "$PWD/.local/state-cache-fixture" --payload-kib 832 --iterations 5000
 * Run the same command on base/candidate in alternating order; retain the fixture.
 * --payload-kib applies when creating the fixture; use a new directory to resize it.
 * Timing/CPU and sampled allocation passes are separate. Fixture writes, startup
 * admission, and warmup are outside measurement. This is an owner benchmark,
 * not a reproduction of a production stall or a whole-Gateway throughput test.
 */
import assert from "node:assert/strict";
import { mkdirSync, statSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../src/state/openclaw-state-db.js";
import { resolveLeaseDatabasePath } from "../../src/state/openclaw-state-lease-storage.js";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    "payload-kib": { type: "string", default: "8" },
    iterations: { type: "string", default: "5000" },
    rounds: { type: "string", default: "5" },
  },
});
assert(values["state-dir"], "--state-dir must name a task-owned synthetic directory");
assert(globalThis.gc, "Run with --expose-gc");
const payloadKiB = Number(values["payload-kib"]);
const iterations = Number(values.iterations);
const rounds = Number(values.rounds);
for (const count of [payloadKiB, iterations, rounds]) {
  assert(Number.isSafeInteger(count) && count > 0, "Counts must be positive integers");
}
const root = path.resolve(values["state-dir"]);
mkdirSync(root, { recursive: true });
const options = { env: { OPENCLAW_STATE_DIR: root } };
const inspector = new Session();
inspector.connect();
try {
  let database = openOpenClawStateDatabase(options);
  const scope = "synthetic-state-cache-benchmark";
  const rows = 10_000;
  const existing = database.db
    .prepare("SELECT count(*) AS count FROM diagnostic_events WHERE scope = ?")
    .get(scope)?.count;
  if (existing !== rows) {
    const payload = JSON.stringify({ synthetic: "x".repeat(payloadKiB * 1024) });
    runOpenClawStateWriteTransaction(({ db }) => {
      const insert = db.prepare(
        "INSERT OR REPLACE INTO diagnostic_events (scope, event_key, payload_json, created_at) VALUES (?, ?, ?, ?)",
      );
      for (let index = 0; index < rows; index++) {
        insert.run(scope, `session-${index}`, payload, index);
      }
    }, options);
    // Finish the fixture's large WAL before either arm's measured warm lookups.
    await closeOpenClawStateDatabaseAsync();
    database = openOpenClawStateDatabase(options);
  }
  const lease = { scope: "shared" as const, options };
  const run = (count: number) => {
    for (let index = 0; index < count; index++) {
      assert.equal(resolveLeaseDatabasePath(lease), database.path);
    }
  };
  run(1000);
  console.log(
    JSON.stringify({ rows, payloadKiB, bytes: statSync(database.path).size, iterations, rounds }),
  );
  for (let round = 0; round < rounds; round++) {
    globalThis.gc();
    const hostLoad = loadavg();
    const cpu = process.cpuUsage();
    const start = performance.now();
    run(iterations);
    const elapsedMs = performance.now() - start;
    const used = process.cpuUsage(cpu);
    globalThis.gc();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    run(iterations);
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const pending = [profile.head];
    let allocatedBytes = 0;
    while (pending.length) {
      const node = pending.pop()!;
      allocatedBytes += node.selfSize;
      pending.push(...node.children);
    }
    assert.equal(openOpenClawStateDatabase(options), database);
    console.log(
      JSON.stringify({
        round,
        elapsedMs,
        cpuMs: (used.user + used.system) / 1000,
        allocatedBytes,
        hostLoad,
        memory: process.memoryUsage(),
      }),
    );
  }
} finally {
  inspector.disconnect();
  await closeOpenClawStateDatabaseAsync();
}
