import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const legacyPrompt = " \nCheck the synthetic checklist. If quiet, reply HEARTBEAT_OK.\n ";
const ordinaryPrompt = legacyPrompt.replace("HEARTBEAT_OK", "NO_REPLY");
const scratch = "# Synthetic checklist\n\nKeep the migration receipt.  \n";
const helpers = "scripts/e2e/lib/upgrade-survivor";
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
export const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

export function seedPublishedDriverHeartbeat(config) {
  const main = config.agents.list.find((agent) => agent.id === "main");
  assert(main, "Heartbeat proof requires its synthetic main agent");
  // This cell proves installed-updater custody. Scheduled delivery has a separate live cell.
  config.cron = { enabled: false };
  main.heartbeat = {
    every: "17m",
    prompt: legacyPrompt,
    target: "none",
    directPolicy: "block",
    activeHours: { start: "22:00", end: "06:00", timezone: "UTC" },
  };
  fs.writeFileSync(path.join(main.workspace, "HEARTBEAT.md"), scratch, { flag: "wx" });
}

function inspectHeartbeat(state, jobId) {
  const database = new DatabaseSync(path.join(state, "state/openclaw.sqlite"), { readOnly: true });
  try {
    database.exec("BEGIN");
    const rows = jobId
      ? database.prepare("SELECT * FROM cron_jobs WHERE job_id = ?").all(jobId)
      : database
          .prepare("SELECT * FROM cron_jobs WHERE agent_id = 'main' AND payload_kind = 'heartbeat'")
          .all();
    assert.equal(rows.length, 1, "Expected exactly one original heartbeat job");
    const row = rows[0];
    const scratchRow = database
      .prepare("SELECT * FROM cron_job_scratch WHERE store_key = ? AND job_id = ?")
      .get(row.store_key, row.job_id);
    const receipts = database
      .prepare(
        "SELECT state_key, value_json FROM config_machine_state WHERE state_key LIKE 'automation-default:%'",
      )
      .all()
      .map((value) => ({ key: value.state_key, value: JSON.parse(value.value_json) }))
      .filter((value) => value.value.jobId === row.job_id);
    return {
      schema: database.prepare("PRAGMA user_version").get().user_version,
      id: row.job_id,
      storeKey: row.store_key,
      job: JSON.parse(row.job_json),
      state: JSON.parse(row.state_json),
      scratch: scratchRow ? { ...scratchRow } : null,
      receipts,
    };
  } finally {
    database.close();
  }
}

export async function capturePublishedHeartbeatProof(context) {
  const { run, writeJson, candidate, driverVersion, state, runtime, prefix, env, artifacts } =
    context;
  assert.equal(driverVersion, "2026.9.7", "Heartbeat proof pins the audited published driver");
  const before = inspectHeartbeat(state);
  assert.equal(before.schema, 19, "Published driver must create its own state schema");
  assert.equal(before.job.payload.kind, "heartbeat");
  assert.equal(before.job.schedule.everyMs, 17 * 60_000);
  assert.equal(before.scratch?.content, scratch, "Published Doctor must preserve scratch bytes");
  assert(before.scratch.revision > 0, "Published Doctor did not import scratch");
  assert.equal(before.receipts.length, 0, "Published state already has candidate receipts");
  const rollbackRoot = path.join(runtime, "heartbeat-rollback");
  const retainedPrefix = path.join(rollbackRoot, "published-prefix");
  fs.mkdirSync(rollbackRoot, { mode: 0o700 });
  await run("heartbeat-retain-driver", "cp", ["-a", prefix, retainedPrefix]);
  const retainedRoot = path.join(retainedPrefix, "lib/node_modules/openclaw");
  const retainedEntry = fs.realpathSync(path.join(retainedPrefix, "bin/openclaw"));
  assert(
    !path.relative(retainedPrefix, retainedEntry).startsWith(".."),
    "Retained driver escaped its prefix",
  );
  const schemaBefore = path.join(artifacts, "heartbeat-schema-before.json");
  const rollbackProof = path.join(artifacts, "heartbeat-backup-rollback.json");
  await run("heartbeat-schema-before", process.execPath, [
    `${helpers}/schema-expectation.mjs`,
    "prepare",
    driverVersion,
    candidate,
    state,
    schemaBefore,
    env.OPENCLAW_CONFIG_PATH,
    JSON.stringify(["main", "second"]),
  ]);
  await run("heartbeat-backup-capture", process.execPath, [
    `${helpers}/backup-rollback.mjs`,
    "capture",
    schemaBefore,
    retainedRoot,
    retainedEntry,
    rollbackRoot,
    rollbackProof,
  ]);
  writeJson("heartbeat-before", before);
  return { before, schemaBefore, rollbackProof, retainedEntry };
}

export async function verifyPublishedHeartbeatProof(context, proof) {
  const { run, output, writeJson, state, runtime, env, artifacts, build, update } = context;
  const after = inspectHeartbeat(state, proof.before.id);
  assert.equal(after.schema, 21, "Candidate must publish the approved policy fence");
  assert.equal(after.id, proof.before.id);
  assert.equal(after.storeKey, proof.before.storeKey);
  assert.deepEqual(after.scratch, proof.before.scratch, "Migration changed scratch bytes/revision");
  assert.deepEqual(
    after.state,
    proof.before.state,
    "Migration changed the existing scheduled occurrence",
  );
  assert.deepEqual(after.job.schedule, proof.before.job.schedule, "Migration rephased the job");
  assert.equal(after.job.enabled, proof.before.job.enabled);
  assert.equal(after.job.payload.kind, "agentTurn");
  assert.equal(after.job.payload.message, ordinaryPrompt);
  assert.equal(after.job.declarationKey, undefined);
  assert.deepEqual(after.job.activeHours, { start: "22:00", end: "06:00", timezone: "UTC" });
  assert.equal(after.job.idleOnly, true);
  assert.deepEqual(after.job.delivery, { mode: "none", directPolicy: "block" });
  assert.equal(after.receipts.length, 1);
  assert.equal(after.receipts[0].value.phase, "complete");
  const config = readJson(env.OPENCLAW_CONFIG_PATH);
  assert.equal(config.cron.enabled, false, "The lifecycle proof unexpectedly enabled inference");
  assert.equal(config.agents?.defaults?.heartbeat, undefined);
  for (const agent of Object.values(config.agents?.entries ?? {})) {
    assert.equal(agent.heartbeat, undefined, "Retired agent config remains");
  }
  for (const agent of config.agents?.list ?? []) {
    assert.equal(agent.heartbeat, undefined, "Retired list config remains");
  }
  const schemaAfter = path.join(artifacts, "heartbeat-schema-after.json");
  await run("heartbeat-schema-after", process.execPath, [
    `${helpers}/schema-expectation.mjs`,
    "assert",
    proof.schemaBefore,
    String(update.exitCode),
    build.version,
    "success",
    schemaAfter,
  ]);
  const schemas = readJson(schemaAfter);
  assert.equal(schemas.candidateSchemaVersions.state, 21);
  assert.equal(schemas.candidateSchemaVersions.agent, 24);
  assert(
    schemas.databases
      .filter((value) => value.kind === "agent")
      .every((value) => value.contentVersion === 24),
  );
  await run("heartbeat-stop-before-rollback", path.join(context.prefix, "bin/systemctl"), [
    "--user",
    "stop",
    "openclaw-gateway.service",
  ]);
  await run("heartbeat-candidate-snapshot", "openclaw", [
    "backup",
    "sqlite",
    "create",
    "--global",
    "--repository",
    path.join(runtime, "candidate-snapshots"),
    "--json",
  ]);
  const snapshot = output("heartbeat-candidate-snapshot");
  assert.equal(snapshot.ok, true);
  const databasePath = path.join(snapshot.snapshotPath, "database.sqlite");
  const snapshotHash = sha256(databasePath);
  const selector = path.join(runtime, "reader-selector");
  fs.mkdirSync(selector, { mode: 0o700 });
  const readerEnv = {
    ...env,
    HOME: selector,
    OPENCLAW_STATE_DIR: path.join(selector, "state"),
    OPENCLAW_CONFIG_PATH: path.join(selector, "state/openclaw.json"),
  };
  const refusal = await run(
    "heartbeat-older-reader",
    process.execPath,
    [proof.retainedEntry, "database", "preflight", databasePath, "--json"],
    true,
    readerEnv,
  );
  assert.notEqual(refusal.exitCode, 0, "Published reader accepted candidate state");
  const older = output("heartbeat-older-reader");
  assert.equal(older.schema, "openclaw.state-schema-preflight.v1");
  assert.equal(older.status, "incompatible");
  assert.equal(older.foundVersion, 21);
  assert.equal(older.targetVersion, 19);
  await run(
    "heartbeat-candidate-reopen",
    "openclaw",
    ["database", "preflight", databasePath, "--json"],
    false,
    readerEnv,
  );
  assert.equal(output("heartbeat-candidate-reopen").status, "exact");
  assert.equal(sha256(databasePath), snapshotHash, "Preflight changed its private snapshot");
  await run("heartbeat-backup-restore", process.execPath, [
    `${helpers}/backup-rollback.mjs`,
    "verify",
    proof.rollbackProof,
    schemaAfter,
  ]);
  const rollback = readJson(proof.rollbackProof);
  assert.equal(rollback.status, "passed");
  const restored = inspectHeartbeat(rollback.restoredStateDir, proof.before.id);
  assert.deepEqual(
    restored,
    proof.before,
    "Restored published state did not retain the exact heartbeat",
  );
  writeJson("heartbeat-after", after);
  writeJson("heartbeat-proof", {
    driverVersion: "2026.9.7",
    candidate: build,
    jobId: after.id,
    stateSchema: { before: 19, after: 21 },
    agentSchema: 24,
    scratchRevision: after.scratch.revision,
    receipt: "complete",
    olderReader: older.status,
    candidateReopen: "exact",
    candidateSnapshotSha256: snapshotHash,
    rollback: rollback.status,
    archiveSha256: rollback.archive.sha256,
    configRetired: true,
    scheduledExecution: "not exercised by this lifecycle cell",
  });
}
