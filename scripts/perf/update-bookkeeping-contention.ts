/**
 * Cold post-activation ledger verification against synthetic shared state and a live writer.
 * Prepare the baseline with: git show <base>:src/state/openclaw-state-db-existing-write.ts > <baseline.ts>
 * nice -n 19 node --expose-gc --import ./scripts/tsx.mjs scripts/perf/update-bookkeeping-contention.ts \
 *   --state-dir <fresh-directory> --baseline-source <baseline.ts>
 * Defaults: 12,000 MiB of plugin blobs, 100k audit events across 6k sessions; warm filesystem,
 * fresh process admission per sample. The owner never visits agent DBs or workspaces.
 * One warmup, two baseline A/A controls, then five counterbalanced pairs, separately with heap sampling.
 * Acceptance: every candidate writer wait and immediate hold <250ms; full checks retained,
 * no material owner CPU/allocation regression. Entirely synthetic; no btrfs/cold-cache claim.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Worker } from "node:worker_threads";
import { transformSync } from "esbuild";
import { startCollectedHeapSampling, sumSampledHeapBytes } from "../lib/heap-sampling.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    "baseline-source": { type: "string" },
    mode: { type: "string", default: "run" },
    arm: { type: "string", default: "candidate" },
    mib: { type: "string", default: "12000" },
    samples: { type: "string", default: "5" },
    allocation: { type: "boolean", default: false },
  },
});
assert(values["state-dir"] && values["baseline-source"]);
const root = path.resolve(values["state-dir"]);
const baseline = path.resolve(values["baseline-source"]);
const databasePath = path.join(root, "state.sqlite");
const mib = Number(values.mib),
  samples = Number(values.samples);
assert(Number.isSafeInteger(mib) && mib > 0 && Number.isSafeInteger(samples) && samples > 0);
const options = {
  path: databasePath,
  env: {
    ...process.env,
    OPENCLAW_STATE_DIR: root,
    OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
  },
};
Object.assign(process.env, options.env);
if (values.arm === "baseline") {
  const target = new URL("../../src/state/openclaw-state-db-existing-write.ts", import.meta.url)
    .href;
  registerHooks({
    load(url, context, next) {
      return url === target
        ? {
            format: "module",
            shortCircuit: true,
            source: transformSync(readFileSync(baseline, "utf8"), {
              loader: "ts",
              format: "esm",
              target: "esnext",
            }).code,
          }
        : next(url, context);
    },
  });
}
if (values.mode === "run" || values.mode === "resume") {
  if (values.mode === "run") {
    assert(!existsSync(root), "Use a fresh synthetic directory");
    mkdirSync(root, { recursive: true });
    writeFileSync(options.env.OPENCLAW_CONFIG_PATH, "{}\n");
  }
  const child = (mode: string, arm: string, allocation = false) => {
    const result = spawnSync(
      process.execPath,
      [
        "--expose-gc",
        "--import",
        "./scripts/tsx.mjs",
        fileURLToPath(import.meta.url),
        "--state-dir",
        root,
        "--baseline-source",
        baseline,
        "--mib",
        String(mib),
        "--mode",
        mode,
        "--arm",
        arm,
        ...(allocation ? ["--allocation"] : []),
      ],
      { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
    );
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const line = result.stdout.split("\n").find((entry) => entry.startsWith("RESULT "));
    assert(line, result.stdout);
    const output: unknown = JSON.parse(line.slice(7));
    console.log(JSON.stringify(output));
    return output;
  };
  if (values.mode === "run") {
    child("seed", "candidate");
  }
  const output: unknown[] = [];
  for (const allocation of [false, true]) {
    child("sample", "baseline", allocation);
    output.push(child("sample", "baseline", allocation), child("sample", "baseline", allocation));
    for (let pair = 0; pair < samples; pair++) {
      for (const arm of pair % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"]) {
        output.push(child("sample", arm, allocation));
      }
    }
  }
  writeFileSync(path.join(root, "results.json"), JSON.stringify(output, null, 2));
} else if (values.mode === "seed") {
  const { createUpdateRun } = await import("../../src/infra/update-run-ledger.js");
  const { closeOpenClawStateDatabaseAsync } = await import("../../src/state/openclaw-state-db.js");
  const run = createUpdateRun({ trigger: "cli" }, options);
  await closeOpenClawStateDatabaseAsync();
  using db = new DatabaseSync(databasePath);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0");
  const blob = db.prepare(
    "INSERT INTO plugin_blob_entries VALUES ('synthetic','content',?,'{}',zeroblob(1048576),1,NULL)",
  );
  for (let start = 0; start < mib; start += 64) {
    db.exec("BEGIN IMMEDIATE");
    for (let row = start; row < Math.min(start + 64, mib); row++) {
      blob.run(String(row));
    }
    db.exec("COMMIT; PRAGMA wal_checkpoint(TRUNCATE)");
  }
  const audit = db.prepare(`INSERT INTO audit_events
    (event_id,source_id,source_sequence,occurred_at,kind,action,status,actor_type,actor_id,agent_id,session_key)
    VALUES (?, ?, ?, ?, 'tool', 'execute', 'succeeded', 'agent', 'synthetic', 'synthetic', ?)`);
  db.exec("BEGIN IMMEDIATE");
  for (let row = 0; row < 100000; row++) {
    audit.run(`event-${row}`, `source-${row}`, row, row, `session-${row % 6000}`);
  }
  db.exec("COMMIT; PRAGMA wal_checkpoint(TRUNCATE)");
  const census = {
    runId: run.runId,
    mib,
    auditRows: 100000,
    sessions: 6000,
    bytes: statSync(databasePath).size,
  };
  writeFileSync(path.join(root, "census.json"), JSON.stringify(census));
  console.log("RESULT " + JSON.stringify(census));
} else {
  assert.equal(values.mode, "sample");
  const census = JSON.parse(readFileSync(path.join(root, "census.json"), "utf8")) as {
    runId: string;
    bytes: number;
  };
  const { recordUpdateRunVerification } = await import("../../src/infra/update-run-ledger.js");
  const control = new SharedArrayBuffer(4);
  const writer = new Worker(
    `
    const { parentPort, workerData } = require('node:worker_threads');
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(workerData.path);
    db.exec('PRAGMA busy_timeout=60000; PRAGMA wal_autocheckpoint=0');
    const prefix = require('node:crypto').randomUUID();
    const update = db.prepare("INSERT INTO audit_events (event_id,source_id,source_sequence,occurred_at,kind,action,status,actor_type,actor_id) VALUES (?, ?, ?, 1, 'tool', 'execute', 'succeeded', 'agent', 'synthetic')");
    const stop = new Int32Array(workerData.control);
    let maxWaitMs=0, count=0;
    parentPort.postMessage('ready');
    Atomics.wait(stop, 0, 0);
    while (Atomics.load(stop, 0) === 1) {
      const start=performance.now(), id=prefix + '-' + count; update.run(id, id, count++);
      maxWaitMs=Math.max(maxWaitMs,performance.now()-start);
      Atomics.wait(stop, 0, 1, 5);
    }
    db.close(); parentPort.postMessage({maxWaitMs,count});
  `,
    { eval: true, workerData: { path: databasePath, control } },
  );
  await once(writer, "message");
  const writerResult = once(writer, "message");
  const writerExit = once(writer, "exit");
  const checks: { sql: string; transaction: boolean; ms: number }[] = [];
  const holds: number[] = [];
  const starts = new Map<DatabaseSync, number>();
  // oxlint-disable-next-line typescript/unbound-method -- Instrumentation calls the original with its intercepted database receiver.
  const prepare = DatabaseSync.prototype.prepare;
  // oxlint-disable-next-line typescript/unbound-method -- Restored after measurement; calls below preserve the native receiver.
  const exec = DatabaseSync.prototype.exec;
  DatabaseSync.prototype.prepare = function (sql: string) {
    const statement = prepare.call(this, sql);
    if (/PRAGMA (?:integrity_check|foreign_key_check)/i.test(sql)) {
      const all = statement.all.bind(statement);
      statement.all = new Proxy(all, {
        apply: (target, receiver, args) => {
          const start = performance.now(),
            transaction = this.isTransaction;
          try {
            return Reflect.apply(target, receiver, args);
          } finally {
            checks.push({ sql, transaction, ms: performance.now() - start });
          }
        },
      });
    }
    return statement;
  };
  DatabaseSync.prototype.exec = function (sql: string) {
    const result = exec.call(this, sql);
    if (/^BEGIN IMMEDIATE\b/i.test(sql)) {
      starts.set(this, performance.now());
    }
    if (/^(?:COMMIT|ROLLBACK)\b/i.test(sql) && starts.has(this)) {
      holds.push(performance.now() - starts.get(this)!);
      starts.delete(this);
    }
    return result;
  };
  const inspector = new Session();
  if (values.allocation) {
    await startCollectedHeapSampling(inspector, 16384);
  }
  global.gc?.();
  const cpu = process.threadCpuUsage(),
    start = performance.now();
  Atomics.store(new Int32Array(control), 0, 1);
  Atomics.notify(new Int32Array(control), 0);
  let result;
  try {
    result = recordUpdateRunVerification(
      census.runId,
      {
        serviceRunning: true,
        coreReady: true,
        versionMatch: true,
        runningVersion: `synthetic-${process.pid}`,
      },
      options,
    );
  } finally {
    Atomics.store(new Int32Array(control), 0, 2);
    Atomics.notify(new Int32Array(control), 0);
    DatabaseSync.prototype.prepare = prepare;
    DatabaseSync.prototype.exec = exec;
  }
  const wallMs = performance.now() - start,
    used = process.threadCpuUsage(cpu);
  const heap = values.allocation ? await inspector.post("HeapProfiler.stopSampling") : undefined;
  if (values.allocation) {
    inspector.disconnect();
  }
  const [live] = (await writerResult) as [{ maxWaitMs: number; count: number }];
  await writerExit;
  assert.equal(result.verification.coreReady, true);
  using observed = new DatabaseSync(databasePath, { readOnly: true });
  const saved = observed
    .prepare("SELECT verification_json FROM update_runs WHERE run_id = ?")
    .get(census.runId);
  assert(saved && typeof saved.verification_json === "string");
  assert.equal(JSON.parse(saved.verification_json).runningVersion, `synthetic-${process.pid}`);
  assert(
    checks.some((check) => /integrity_check/i.test(check.sql)),
    "Cold full scan must be exercised",
  );
  console.log(
    "RESULT " +
      JSON.stringify({
        arm: values.arm,
        allocation: values.allocation,
        bytes: census.bytes,
        wallMs,
        cpuMs: (used.user + used.system) / 1000,
        allocatedBytes: heap ? sumSampledHeapBytes(heap.profile.head) : undefined,
        maxHoldMs: Math.max(0, ...holds),
        ...live,
        checks,
        load: loadavg(),
        baselineSha256: createHash("sha256").update(readFileSync(baseline)).digest("hex"),
      }),
  );
}
