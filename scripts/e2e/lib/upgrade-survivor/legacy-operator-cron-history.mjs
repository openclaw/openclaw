import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { isMainThread } from "node:worker_threads";

const MIGRATION = "state:cron-run-logs-to-task-runs:v1";
const FIXTURE_NAME = "legacy-operator-cron-history.json";
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const writeJson = (file, value) =>
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });

function identity(manifestBytes, buildBytes) {
  const manifest = JSON.parse(manifestBytes.toString());
  assert.equal(manifest.name, "openclaw");
  JSON.parse(buildBytes.toString());
  return {
    version: manifest.version,
    stateSchemaVersion: manifest.openclaw.schemaVersions.state,
    manifestSha256: hash(manifestBytes),
    buildInfoSha256: hash(buildBytes),
  };
}

function installedIdentity(root) {
  return identity(
    fs.readFileSync(path.join(root, "package.json")),
    fs.readFileSync(path.join(root, "dist/build-info.json")),
  );
}

function snapshot(fixture) {
  const db = new DatabaseSync(fixture.databasePath, { readOnly: true });
  try {
    const legacySchema = db
      .prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'cron_run_logs'")
      .get()?.sql;
    const legacyRows = legacySchema
      ? db
          .prepare("SELECT * FROM cron_run_logs ORDER BY store_key, job_id, seq")
          .all()
          .map((row) => Object.assign({}, row))
      : [];
    const tasks = db
      .prepare("SELECT * FROM task_runs WHERE source_id IN (?, ?) ORDER BY source_id")
      .all(...fixture.entries.map((entry) => entry.jobId))
      .map((row) => Object.assign({}, row));
    const migration = db
      .prepare("SELECT status, report_json FROM migration_runs WHERE id = ?")
      .get(MIGRATION);
    return {
      stateSchemaVersion: db.prepare("PRAGMA user_version").get().user_version,
      legacySchema: legacySchema ?? null,
      legacyRows,
      legacySha256: hash(JSON.stringify({ legacySchema: legacySchema ?? null, legacyRows })),
      tasks,
      migration: migration ?? null,
    };
  } finally {
    db.close();
  }
}

export function seedCronHistory(stateDir, artifactRoot, baselineRoot, candidateTarball) {
  const baseline = installedIdentity(baselineRoot);
  assert(["2026.9.3", "2026.9.4"].includes(baseline.version));
  const packed = (name) =>
    execFileSync("tar", ["-xOf", candidateTarball, `package/${name}`], {
      maxBuffer: 1024 * 1024,
    });
  const candidate = identity(packed("package.json"), packed("dist/build-info.json"));
  assert(
    Number.isSafeInteger(candidate.stateSchemaVersion) &&
      candidate.stateSchemaVersion >= baseline.stateSchemaVersion,
    "retained-history candidate must declare a valid nonolder state schema",
  );
  assert.notEqual(baseline.buildInfoSha256, candidate.buildInfoSha256);
  const jobs = readJson(path.join(artifactRoot, "legacy-operator-baseline.json")).jobs;
  assert.equal(jobs.length, 2);
  const fixture = {
    baseline,
    candidate,
    databasePath: path.join(stateDir, "state/openclaw.sqlite"),
    storeKey: path.resolve(stateDir, "cron/jobs.json"),
    entries: jobs.map((job, index) => ({
      jobId: job.id,
      action: "finished",
      ts: 1_800_000_000_100 + index * 1000,
      runAtMs: 1_800_000_000_000 + index * 1000,
      durationMs: 100,
      runId: `survivor-retained-cron-${index}`,
      status: index === 0 ? "ok" : "error",
      completionStatus: index === 0 ? "succeeded" : "failed",
      deliveryStatus: "not-requested",
      summary: `retained cron history ${index}`,
      error: index === 1 ? "synthetic retained failure" : undefined,
    })),
  };
  const db = new DatabaseSync(fixture.databasePath);
  try {
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, baseline.stateSchemaVersion);
    assert.equal(baseline.stateSchemaVersion, baseline.version === "2026.9.4" ? 17 : 16);
    // A retained historical table is the specimen; executing a modern cron job
    // writes task_runs directly and would never exercise this import boundary.
    db.exec(`CREATE TABLE cron_run_logs (
      store_key TEXT NOT NULL, job_id TEXT NOT NULL, seq INTEGER NOT NULL,
      ts INTEGER NOT NULL, entry_json TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY (store_key, job_id, seq)
    ) STRICT;`);
    const insert = db.prepare("INSERT INTO cron_run_logs VALUES (?, ?, ?, ?, ?, ?)");
    for (const entry of fixture.entries) {
      insert.run(fixture.storeKey, entry.jobId, 1, entry.ts, JSON.stringify(entry), entry.ts);
    }
  } finally {
    db.close();
  }
  fixture.before = snapshot(fixture);
  assert.equal(fixture.before.tasks.length, 0, "fixture jobs already have task history");
  writeJson(path.join(artifactRoot, FIXTURE_NAME), fixture);
  return fixture;
}

function assertImported(fixture, state) {
  assert.equal(state.legacySchema, null, "retained cron_run_logs table was not retired");
  assert.deepEqual(state.legacyRows, []);
  assert.equal(state.tasks.length, fixture.entries.length, "retained cron task count changed");
  for (const entry of fixture.entries) {
    const task = state.tasks.find((row) => row.source_id === entry.jobId);
    assert(task, "retained cron history was lost");
    const taskId = `cron-runlog-import:${entry.jobId}:${entry.ts}:1`;
    for (const [key, expected] of Object.entries({
      task_id: taskId,
      runtime: "cron",
      source_id: entry.jobId,
      run_id: taskId,
      task: entry.jobId,
      status: entry.completionStatus,
      scope_kind: "system",
      created_at: entry.runAtMs,
      started_at: entry.runAtMs,
      ended_at: entry.ts,
      last_event_at: entry.ts,
      cleanup_after: null,
      error: entry.error ?? null,
      terminal_summary: entry.summary,
      terminal_outcome: entry.status === "ok" ? "succeeded" : null,
      delivery_status: "not_applicable",
      notify_policy: "silent",
    })) {
      assert.equal(task[key], expected, `retained cron task changed: ${key}`);
    }
    assert.deepEqual(JSON.parse(task.detail_json), {
      kind: "cron-run",
      status: entry.status,
      completionStatus: entry.completionStatus,
      error: entry.error ?? null,
      summary: entry.summary,
      storeKey: fixture.storeKey,
      deliveryStatus: entry.deliveryStatus,
      runId: entry.runId,
      runAtMs: entry.runAtMs,
      durationMs: entry.durationMs,
    });
  }
  assert.equal(state.migration?.status, "completed");
  assert.deepEqual(JSON.parse(state.migration.report_json), {
    imported: 2,
    alreadyMirrored: 0,
    malformed: 0,
    skipped: false,
  });
}

function observeUpdateProcess() {
  const fixturePath = process.env.OPENCLAW_UPGRADE_SURVIVOR_CRON_HISTORY_FIXTURE;
  const observations = process.env.OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT;
  const command = process.argv[2];
  if (!isMainThread || !fixturePath || !observations || !["doctor", "update"].includes(command)) {
    return;
  }
  const receipt = {
    role: command,
    pid: process.pid,
    parentPid: process.ppid,
    startedAtMs: Date.now(),
  };
  let fixture;
  try {
    fixture = readJson(fixturePath);
    assert.equal(
      fixture.databasePath,
      path.join(process.env.OPENCLAW_STATE_DIR, "state/openclaw.sqlite"),
    );
    let root = path.dirname(fs.realpathSync(process.argv[1]));
    for (let depth = 0; depth < 3; depth++, root = path.dirname(root)) {
      if (
        fs.existsSync(path.join(root, "package.json")) &&
        readJson(path.join(root, "package.json")).name === "openclaw"
      ) {
        receipt.identity = installedIdentity(root);
        break;
      }
    }
    receipt.updateInProgress = process.env.OPENCLAW_UPDATE_IN_PROGRESS === "1";
    receipt.before = snapshot(fixture);
  } catch (error) {
    receipt.observationError = String(error);
  }
  const file = path.join(observations, `cron-history-${command}-${process.pid}.json`);
  writeJson(file, receipt);
  process.once("exit", (exitCode) => {
    try {
      receipt.after = snapshot(fixture);
    } catch (error) {
      receipt.observationError = String(error);
    }
    writeJson(file, { ...receipt, exitCode });
  });
}

function assertProcessReceipt(observations, witness, role) {
  const processReceipt = readJson(
    path.join(observations, "diagnostics", `process-${witness.pid}-exited.json`),
  );
  assert.equal(processReceipt.role, role);
  assert.equal(processReceipt.pid, witness.pid);
  assert.equal(processReceipt.packageVersion, witness.identity.version);
  assert.equal(processReceipt.parentPid, witness.parentPid);
  assert.equal(processReceipt.exitCode, 0);
  assert.equal(witness.observationError, undefined);
  assert.equal(witness.exitCode, 0);
}

function summarizeSnapshot(state) {
  if (!state) {
    return undefined;
  }
  return {
    stateSchemaVersion: state.stateSchemaVersion,
    legacySha256: state.legacySha256,
    legacyRows: state.legacyRows.length,
    tasks: state.tasks.length,
    tasksSha256: hash(JSON.stringify(state.tasks)),
    migration: state.migration
      ? {
          status: state.migration.status,
          report_json: state.migration.report_json.slice(0, 160),
        }
      : null,
  };
}

export function assertCronHistory(artifactRoot, observations) {
  const fixture = readJson(path.join(artifactRoot, FIXTURE_NAME));
  const proofFile = path.join(artifactRoot, "legacy-operator-cron-history-proof.json");
  const proof = {
    baseline: fixture.baseline,
    candidate: fixture.candidate,
    retainedSha256: fixture.before.legacySha256,
  };
  let receipts = [];
  let current;
  try {
    receipts = fs
      .readdirSync(observations)
      .filter((name) => /^cron-history-(?:doctor|update)-\d+\.json$/u.test(name))
      .map((name) => readJson(path.join(observations, name)))
      .toSorted((left, right) => left.startedAtMs - right.startedAtMs);
    current = snapshot(fixture);
    const doctors = receipts.filter(
      (receipt) =>
        receipt.role === "doctor" &&
        receipt.identity?.buildInfoSha256 === fixture.candidate.buildInfoSha256 &&
        !receipt.observationError,
    );
    let updater;
    let witness;
    if (fixture.baseline.version === "2026.9.3") {
      // The shipped 9.3 updater imports through its normal opener when admitting
      // the update ledger, before candidate code runs. Its result must survive Doctor.
      updater = receipts.find(
        (receipt) =>
          receipt.role === "update" &&
          receipt.identity?.buildInfoSha256 === fixture.baseline.buildInfoSha256 &&
          receipt.before?.legacySha256 === fixture.before.legacySha256,
      );
      assert(updater, "published updater never received the unchanged retained cron history");
      assert.deepEqual(updater.identity, fixture.baseline);
      assertProcessReceipt(observations, updater, "update");
      assert.equal(updater.before.stateSchemaVersion, fixture.before.stateSchemaVersion);
      assert.deepEqual(updater.before.legacyRows, fixture.before.legacyRows);
      assert.deepEqual(updater.before.tasks, []);
      witness = doctors[0];
      assert(witness, "candidate Doctor was not observed against the live database");
      assertImported(fixture, witness.before);
      assert.deepEqual(witness.after.tasks, witness.before.tasks, "cron history changed in Doctor");
      assert.equal(witness.after.migration?.report_json, witness.before.migration.report_json);
    } else {
      witness = doctors.find(
        (receipt) => receipt.before?.legacySha256 === fixture.before.legacySha256,
      );
      assert(witness, "candidate Doctor never received the unchanged retained cron history");
      assert.equal(witness.before.stateSchemaVersion, fixture.before.stateSchemaVersion);
      assert.deepEqual(witness.before.legacyRows, fixture.before.legacyRows);
      assert.deepEqual(witness.before.tasks, []);
    }
    assert.deepEqual(witness.identity, fixture.candidate);
    assert.equal(witness.updateInProgress, true, "Doctor was not an updater child");
    assertProcessReceipt(observations, witness, "doctor");
    assertImported(fixture, witness.after);
    assertImported(fixture, current);
    assert.equal(witness.after.stateSchemaVersion, fixture.candidate.stateSchemaVersion);
    assert.equal(current.stateSchemaVersion, fixture.candidate.stateSchemaVersion);
    assert.deepEqual(current.tasks, witness.after.tasks, "cron history changed after Doctor");
    writeJson(proofFile, {
      ...proof,
      status: "passed",
      contract: updater ? "published-updater-import-preserved" : "candidate-doctor-import",
      currentSchemaAtDoctorEntry:
        witness.before.stateSchemaVersion === fixture.candidate.stateSchemaVersion,
      ...(updater
        ? {
            updater: {
              pid: updater.pid,
              parentPid: updater.parentPid,
              identity: updater.identity,
              before: updater.before,
            },
          }
        : {}),
      doctor: witness,
    });
  } catch (error) {
    writeJson(proofFile, {
      ...proof,
      status: "failed",
      failure: String(error).slice(0, 500),
      current: summarizeSnapshot(current),
      observationCount: receipts.length,
      // This file shares the existing 16 KiB diagnostic publication budget.
      observations: receipts.slice(0, 8).map((receipt) => ({
        role: receipt.role,
        pid: receipt.pid,
        parentPid: receipt.parentPid,
        startedAtMs: receipt.startedAtMs,
        identity: receipt.identity,
        exitCode: receipt.exitCode,
        observationError: receipt.observationError?.slice(0, 160),
        before: summarizeSnapshot(receipt.before),
        after: summarizeSnapshot(receipt.after),
      })),
    });
    throw error;
  }
}

observeUpdateProcess();

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "seed") {
    seedCronHistory(
      process.env.OPENCLAW_STATE_DIR,
      process.env.OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT,
      ...args,
    );
  } else {
    assert.equal(command, "assert");
    assertCronHistory(process.env.OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT, args[0]);
  }
}
