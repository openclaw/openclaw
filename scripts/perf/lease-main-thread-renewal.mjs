/**
 * Real publication-reservation renewal, using synthetic state and native workers.
 * Run from a built source checkout:
 * node --import ./scripts/tsx.mjs scripts/perf/lease-main-thread-renewal.mjs STATE_DIR
 * STATE_DIR must not exist. The probe keeps both reservations through their real
 * 20-second cadence under concurrent worker writes, reports main-thread
 * UPDATE/COMMIT counts and max commit ms,
 * and fails if renewal writes run on the main thread. Run the same script on
 * base and candidate. This owner proof supplements team-shape-stress.ts; it is
 * intentionally outside PR unit suites because worker clocks must run normally.
 */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";

const directory = process.argv[2];
assert(directory, "Pass a new synthetic STATE_DIR");
const stateDir = path.resolve(directory);
mkdirSync(stateDir, { mode: 0o700 });
process.env.OPENCLAW_STATE_DIR = stateDir;
process.env.OPENCLAW_HOME = stateDir;
process.env.HOME = stateDir;
const { openOpenClawStateDatabase, closeOpenClawStateDatabaseAsync } =
  await import("../../src/state/openclaw-state-db.ts");
const { createWorkerSessionPlacementStore } =
  await import("../../src/gateway/worker-environments/placement-store.ts");
const { writeConfigMachineStateAsync } =
  await import("../../src/state/config-machine-state-async.ts");
const database = openOpenClawStateDatabase();
const placements = createWorkerSessionPlacementStore({ database });
const identity = {
  sessionId: "lease-probe",
  sessionKey: "agent:main:lease-probe",
  agentId: "main",
};
// oxlint-disable-next-line typescript/unbound-method -- Restored below; calls retain their native receiver.
const originalExec = DatabaseSync.prototype.exec;
// oxlint-disable-next-line typescript/unbound-method -- Restored below; calls retain their native receiver.
const originalRun = StatementSync.prototype.run;
// oxlint-disable-next-line typescript/unbound-method -- Restored below; calls retain their native receiver.
const originalAll = StatementSync.prototype.all;
let updates = 0;
const commits = [];
let measuring = false;
const writing = new AbortController();
let writes = 0;
const payload = "synthetic".repeat(8192);
const writer = (async () => {
  while (!writing.signal.aborted) {
    await writeConfigMachineStateAsync("lease-probe.concurrent", { writes, payload });
    writes += 1;
    await delay(100);
  }
})();
void writer.catch(() => {});
DatabaseSync.prototype.exec = function (sql) {
  if (!measuring || !/^COMMIT\s*;?$/i.test(sql.trim())) {
    return originalExec.call(this, sql);
  }
  const start = performance.now();
  try {
    return originalExec.call(this, sql);
  } finally {
    commits.push(performance.now() - start);
  }
};
for (const method of ["run", "all"]) {
  const original = method === "run" ? originalRun : originalAll;
  StatementSync.prototype[method] = function (...args) {
    if (measuring && /update\s+"?state_leases"?/i.test(this.sourceSQL)) {
      updates += 1;
    }
    return original.apply(this, args);
  };
}
try {
  await placements.withLocalWorkspaceReservation(identity, async (assertCurrent) => {
    // Direct inspection is measurement-only; no product read path is replaced.
    const read = () =>
      database.db
        .prepare("SELECT scope, heartbeat_at FROM state_leases WHERE lease_key = ?")
        .all(identity.sessionId);
    const initial = read();
    assert.equal(initial.length, 2);
    const startedAt = performance.now();
    measuring = true;
    let renewed = false;
    while (performance.now() - startedAt < 30_000) {
      await delay(500);
      const rows = read();
      renewed =
        rows.length === 2 &&
        rows.every(
          (row) =>
            row.heartbeat_at > initial.find((before) => before.scope === row.scope).heartbeat_at,
        );
      if (renewed) {
        break;
      }
    }
    measuring = false;
    assertCurrent();
    console.log(
      JSON.stringify(
        {
          renewed,
          concurrentWrites: writes,
          durationMs: performance.now() - startedAt,
          mainThreadLeaseUpdates: updates,
          mainThreadCommits: commits.length,
          maxMainThreadCommitMs: Math.max(0, ...commits),
        },
        null,
        2,
      ),
    );
    assert(renewed, "Both held reservations must renew durably");
    assert(writes > 0, "Concurrent writer must make progress");
    assert.equal(updates, 0, "Lease renewal must not write SQLite on the main thread");
  });
} finally {
  measuring = false;
  writing.abort();
  try {
    await writer;
  } finally {
    DatabaseSync.prototype.exec = originalExec;
    StatementSync.prototype.run = originalRun;
    StatementSync.prototype.all = originalAll;
    await closeOpenClawStateDatabaseAsync();
  }
}
