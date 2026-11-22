/**
 * Synthetic native update-finish retention proof; never use operator state.
 * node --import ./scripts/tsx.mjs scripts/perf/migration-backup-retention-measure.ts seed .local/retention 35840
 * node --import ./scripts/tsx.mjs scripts/perf/migration-backup-retention-measure.ts run .local/retention label [allocation]
 * Compare pinned checkouts with five interleaved pairs and separate A/A controls.
 * Setup uses real Doctor backup/verification owners outside the measured window.
 * The native receipt is a synthetic external-supervisor input: migration completed,
 * candidate accepted, rollback journal retired. No health verification is fabricated.
 * Acceptance: eligible backup bytes reclaimed, source unchanged, summary recorded.
 * Report the added finish latency/CPU/allocation; this is reclamation, not a speedup.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const [mode, directory, argument = "35840", sampling] = process.argv.slice(2);
assert.ok(directory && (mode === "seed" || mode === "run"));
const root = path.resolve(directory);
assert.ok(root.startsWith(path.resolve(".local") + path.sep));
const marker = path.join(root, "synthetic-retention.json");
if (mode === "seed") {
  fs.mkdirSync(root);
} else {
  assert.equal(JSON.parse(fs.readFileSync(marker, "utf8")).synthetic, true);
}
const stateDir = path.join(root, "state");
Object.assign(process.env, {
  OPENCLAW_HOME: path.join(root, "home"),
  OPENCLAW_STATE_DIR: stateDir,
  OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
  OPENCLAW_SUPERVISOR_MODE: "external",
  OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
});
for (const key of ["OPENCLAW_UPDATE_IN_PROGRESS", "OPENCLAW_UPDATE_RUN_ID", "OPENCLAW_AGENT_DIR"]) {
  delete process.env[key];
}
fs.mkdirSync(stateDir, { recursive: true });
const { withDoctorSqliteMaintenanceLock } =
  await import("../../src/commands/doctor-sqlite-maintenance-lock.js");
const { closeOpenClawStateDatabaseAsync, openOpenClawStateDatabase } =
  await import("../../src/state/openclaw-state-db.js");
const { closeOpenClawAgentDatabasesAsync, openOpenClawAgentDatabase } =
  await import("../../src/state/openclaw-agent-db.js");
const source = path.join(stateDir, "agents", "synthetic", "agent", "openclaw-agent.sqlite");
if (mode === "seed") {
  const mebibytes = Number(argument);
  assert.ok(Number.isSafeInteger(mebibytes) && mebibytes > 0);
  fs.writeFileSync(
    process.env.OPENCLAW_CONFIG_PATH!,
    JSON.stringify({
      agents: { ownership: "explicit", entries: { synthetic: {} } },
      plugins: { enabled: false },
      gateway: { mode: "local", auth: { mode: "none" } },
    }),
  );
  await withDoctorSqliteMaintenanceLock({
    operation: "synthetic retention fixture",
    run: async () => {
      openOpenClawStateDatabase();
      const { db } = openOpenClawAgentDatabase({ agentId: "synthetic" });
      db.exec("BEGIN IMMEDIATE");
      const insert = db.prepare(
        "INSERT INTO session_nodes(session_key,current_session_id,entry_json,entry_valid,updated_at,status) VALUES(?,?,'{}',1,1,'done')",
      );
      const window = db.prepare(
        "INSERT INTO session_windows(session_id,session_key,created_at,updated_at,status) VALUES(?,?,1,1,'done')",
      );
      for (let index = 0; index < 3000; index++) {
        const key = `agent:synthetic:subagent:${index}`;
        insert.run(key, `synthetic-${index}`);
        window.run(`synthetic-${index}`, key);
      }
      db.exec("CREATE TABLE synthetic_payload(payload BLOB NOT NULL)");
      const payload = db.prepare("INSERT INTO synthetic_payload VALUES(zeroblob(1048576))");
      for (let index = 0; index < mebibytes; index++) {
        payload.run();
      }
      db.exec("COMMIT");
      await closeOpenClawAgentDatabasesAsync();
      await closeOpenClawStateDatabaseAsync();
    },
  });
  const workspace = path.join(stateDir, "workspace");
  fs.mkdirSync(workspace);
  const content = Buffer.alloc(19050, "synthetic workspace\n");
  for (let index = 0; index < 62000; index++) {
    fs.writeFileSync(path.join(workspace, `${index}.txt`), content);
  }
  fs.writeFileSync(
    marker,
    JSON.stringify({
      synthetic: true,
      databaseBytes: fs.statSync(source).size,
      sessions: 3000,
      workspaceFiles: 62000,
      workspaceBytes: 62000 * content.length,
    }),
  );
} else {
  const { backupDoctorSqliteDatabases } =
    await import("../../src/commands/doctor-migration-backup.js");
  const { completeDoctorMigrationBackups } =
    await import("../../src/commands/doctor-migration-backup-artifacts.js");
  const { updateFinishCommand } =
    await import("../../src/cli/update-cli/update-command-migrate.js");
  const { withCliProcessScope, withCliCommandCleanup } =
    await import("../../src/cli/runtime-cleanup-scope.js");
  const backups = await withDoctorSqliteMaintenanceLock({
    operation: "synthetic migration backup",
    run: async (authority) => {
      const result = await backupDoctorSqliteDatabases({
        env: process.env,
        pendingDatabasePaths: [source],
        databasePaths: [source],
        repair: { key: randomUUID() },
        authority,
      });
      completeDoctorMigrationBackups(process.env, [source]);
      return result.snapshots!;
    },
  });
  const bytes = backups.reduce((total, backup) => total + fs.statSync(backup.path).size, 0);
  const sourceBefore = fs.statSync(source, { bigint: true });
  const backupRoot = path.join(root, `native-${randomUUID()}`);
  const nativeDirectory = `${backupRoot}.databases`;
  fs.mkdirSync(nativeDirectory);
  fs.writeFileSync(
    `${backupRoot}.receipt.json`,
    JSON.stringify({
      schemaVersion: 1,
      runId: randomUUID(),
      startedAtMs: Date.now(),
      stateDir,
      configPath: process.env.OPENCLAW_CONFIG_PATH,
      status: "migrated",
      backup: {
        directory: nativeDirectory,
        databases: [],
        missingPaths: [],
        sourcePaths: [],
        sourceGenerations: {},
        warnings: [],
      },
      databases: [source],
      databaseIdentities: {},
      configIdentity: null,
      configFiles: [],
    }),
  );
  const inspector = new Session();
  if (sampling === "allocation") {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const loadBefore = os.loadavg();
  const cpuBefore = process.cpuUsage();
  const started = performance.now();
  await withCliProcessScope(() =>
    withCliCommandCleanup(false, () => updateFinishCommand(backupRoot)),
  );
  const elapsedMs = performance.now() - started;
  const cpu = process.cpuUsage(cpuBefore);
  let allocatedBytes: number | undefined;
  if (sampling === "allocation") {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    allocatedBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
    inspector.disconnect();
  }
  const retainedBytes = backups.reduce(
    (total, backup) => total + (fs.existsSync(backup.path) ? fs.statSync(backup.path).size : 0),
    0,
  );
  const sourceAfter = fs.statSync(source, { bigint: true });
  for (const key of ["ino", "size", "mtimeNs"] as const) {
    assert.equal(sourceAfter[key], sourceBefore[key]);
  }
  using database = new DatabaseSync(source, { readOnly: true });
  assert.equal(database.prepare("SELECT count(*) AS n FROM session_nodes").get()!.n, 3000);
  const report = {
    label: argument,
    elapsedMs,
    cpu,
    allocatedBytes,
    backupBytes: bytes,
    retainedBytes,
    reclaimedBytes: bytes - retainedBytes,
    maxRssKiB: process.resourceUsage().maxRSS,
    loadBefore,
    loadAfter: os.loadavg(),
    fixture: JSON.parse(fs.readFileSync(marker, "utf8")),
  };
  fs.writeFileSync(path.join(root, `${argument}.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  // Only these synthetic originals belong to this measurement; never scan by suffix.
  for (const backup of backups) {
    fs.rmSync(backup.path, { force: true });
  }
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
}
