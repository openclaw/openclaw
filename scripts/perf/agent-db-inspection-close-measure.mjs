// Bounded owner reproduction, not a whole-Gateway or production-duration benchmark.
// node --import ./scripts/tsx.mjs scripts/perf/agent-db-inspection-close-measure.mjs \
//   [--source-file .local/baseline-lifecycle.ts] [--iterations 12] [--rows 10000]
// Run baseline/candidate in separate alternating processes. The frozen lifecycle
// source loads at its original URL, preserving its real relative imports.
// Fixtures are fresh synthetic cache rows (not sessions), created under .local.
// Each measured cycle overlaps real scheduled WAL inspection with worker settlement,
// then reopens and reads. Failed settlement models native exit by closing the handle
// after inspection and invoking the real unknown-outcome lease cleanup. It excludes
// Worker startup, IPC, termination and production scan-duration claims.
// Two complete cycles warm imports and admission before measurements begin.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";

const { values } = parseArgs({
  options: {
    "source-file": { type: "string" },
    iterations: { type: "string", default: "12" },
    rows: { type: "string", default: "10000" },
  },
});
const iterations = Number(values.iterations);
const rows = Number(values.rows);
assert(Number.isSafeInteger(iterations) && iterations > 0 && iterations <= 100);
assert(Number.isSafeInteger(rows) && rows > 0 && rows <= 100000);
const ownerUrl = new URL("../../src/state/openclaw-agent-db-lifecycle.ts", import.meta.url);
const source = fs.readFileSync(values["source-file"] ?? ownerUrl, "utf8");
let replaced = false;
if (values["source-file"]) {
  registerHooks({
    load(url, context, nextLoad) {
      if (url === ownerUrl.href) {
        replaced = true;
        return { format: "module-typescript", source, shortCircuit: true };
      }
      return nextLoad(url, context);
    },
  });
}

const scratch = path.resolve(".local");
fs.mkdirSync(scratch, { recursive: true });
const root = fs.mkdtempSync(path.join(scratch, "agent-db-inspection-close-"));
process.env.OPENCLAW_STATE_DIR = root;
process.env.OPENCLAW_LOG_LEVEL = "silent";
const env = { OPENCLAW_STATE_DIR: root };
const { openOpenClawAgentDatabase, closeOpenClawAgentDatabasesAsync } =
  await import("../../src/state/openclaw-agent-db.js");
const { settleOpenClawAgentDatabaseWorkerClose, readOpenClawAgentDatabaseWorkerLeaseReceipt } =
  await import(ownerUrl.href);
const { openOpenClawStateDatabase, closeOpenClawStateDatabaseAsync } =
  await import("../../src/state/openclaw-state-db.js");
const { releaseExitedOpenClawAgentDatabaseLeaseInDatabase } =
  await import("../../src/state/openclaw-agent-db-lease.js");
const { getOpenClawAgentDatabaseValidation } =
  await import("../../src/state/openclaw-agent-db-validation-cache.js");
const { observeSqliteWalPeriodicWork } =
  await import("../../src/infra/sqlite-wal-scheduler.test-support.js");
assert(!values["source-file"] || replaced, "Frozen lifecycle owner did not load");
const state = openOpenClawStateDatabase({ env });
const options = { agentId: "inspection-close-benchmark", env };
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
const originalReaddir = fs.promises.readdir;
const prepareDescriptor = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "prepare");
assert(prepareDescriptor && typeof prepareDescriptor.value === "function");
let counting = false;
let integrityChecks = 0;
DatabaseSync.prototype.prepare = function (sql, ...args) {
  if (counting && /^PRAGMA\s+(?:integrity_check|foreign_key_check)\b/i.test(sql.trim())) {
    integrityChecks++;
  }
  return prepareDescriptor.value.call(this, sql, ...args);
};
const results = [];
const hostLoadBefore = loadavg();
try {
  const seed = openOpenClawAgentDatabase(options);
  seed.db.exec("BEGIN");
  const insert = seed.db.prepare(
    "INSERT INTO cache_entries(scope,key,value_json,expires_at,updated_at) VALUES(?,?,?,?,?)",
  );
  const payload = JSON.stringify({ synthetic: "x".repeat(1024) });
  for (let index = 0; index < rows; index++) {
    insert.run("inspection-benchmark", String(index), payload, 0, 1);
  }
  seed.db.exec("COMMIT");
  await settleOpenClawAgentDatabaseWorkerClose(seed.path);
  for (let index = 0; index < iterations + 2; index++) {
    const scheduled = observeSqliteWalPeriodicWork();
    let database;
    try {
      // Enable the Linux tripwire on this synthetic connection only.
      Object.defineProperty(process, "platform", { ...originalPlatform, value: "linux" });
      database = openOpenClawAgentDatabase(options);
    } finally {
      Object.defineProperty(process, "platform", originalPlatform);
      scheduled.restore();
    }
    const validation = getOpenClawAgentDatabaseValidation(database);
    assert(validation);
    const lease = readOpenClawAgentDatabaseWorkerLeaseReceipt(database.path);
    let finishInspection;
    const inspected = new Promise((resolve) => {
      finishInspection = resolve;
    });
    let notifyInspection;
    const inspecting = new Promise((resolve) => {
      notifyInspection = resolve;
    });
    fs.promises.readdir = function (pathname, ...args) {
      if (pathname === "/proc/self/fd") {
        notifyInspection();
        return inspected;
      }
      return originalReaddir.call(this, pathname, ...args);
    };
    const periodic = scheduled.periodic();
    await inspecting;
    const allocatedBefore = getHeapStatistics().total_allocated_bytes;
    assert(Number.isFinite(allocatedBefore), "Node must expose total_allocated_bytes");
    const cpuBefore = process.threadCpuUsage();
    const started = performance.now();
    const checksBefore = integrityChecks;
    counting = true;
    const closing = Promise.resolve(settleOpenClawAgentDatabaseWorkerClose(database.path));
    finishInspection([]);
    await periodic;
    fs.promises.readdir = originalReaddir;
    const outcome = await closing;
    if (!outcome.settled) {
      assert.equal(outcome.errors.length, 2);
      assert(outcome.errors.every((error) => error.message.includes("WAL inspection is pending")));
      // Stand in for confirmed native Worker exit; keep real orphan cleanup and re-admission.
      database.db.close();
      releaseExitedOpenClawAgentDatabaseLeaseInDatabase(state.db, lease, "unknown");
      await settleOpenClawAgentDatabaseWorkerClose(database.path);
    }
    const retainedValidation = Atomics.load(new Int32Array(validation.valid), 0);
    const reopened = openOpenClawAgentDatabase(options);
    assert.equal(reopened.db.prepare("SELECT count(*) AS n FROM cache_entries").get().n, rows);
    const wallMs = performance.now() - started;
    const cpu = process.threadCpuUsage(cpuBefore);
    const allocatedBytes = getHeapStatistics().total_allocated_bytes - allocatedBefore;
    counting = false;
    if (index >= 2) {
      results.push({
        wallMs,
        cpuMicros: cpu.user + cpu.system,
        allocatedBytes,
        failedSettlement: !outcome.settled,
        retainedValidation,
        integrityChecks: integrityChecks - checksBefore,
      });
    }
    await settleOpenClawAgentDatabaseWorkerClose(reopened.path);
  }
  const sum = (key) => results.reduce((total, result) => total + Number(result[key]), 0);
  process.stdout.write(
    `${JSON.stringify({
      sourceSha256: createHash("sha256").update(source).digest("hex"),
      iterations,
      warmupCycles: 2,
      rows,
      payloadBytes: Buffer.byteLength(payload),
      cpuMicrosPerCycle: sum("cpuMicros") / iterations,
      allocatedBytesPerCycle: sum("allocatedBytes") / iterations,
      wallMsPerCycle: sum("wallMs") / iterations,
      failedSettlements: sum("failedSettlement"),
      retainedValidationCycles: sum("retainedValidation"),
      integrityChecks: sum("integrityChecks"),
      hostLoadBefore,
      hostLoadAfter: loadavg(),
      results,
    })}\n`,
  );
} finally {
  counting = false;
  fs.promises.readdir = originalReaddir;
  Object.defineProperty(DatabaseSync.prototype, "prepare", prepareDescriptor);
  Object.defineProperty(process, "platform", originalPlatform);
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
  fs.rmSync(root, { recursive: true, force: true });
}
