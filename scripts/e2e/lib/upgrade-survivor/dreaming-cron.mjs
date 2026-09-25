import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { isMainThread } from "node:worker_threads";
import { readPositiveIntEnv } from "../env-limits.mjs";
import {
  assertWorkerCellPackageIdentity,
  readWorkerCellPackageIdentity,
} from "./worker-cell-package.mjs";

const baselineVersion = "2026.9.6";
const baselineCommit = "eb377ac59e6c9fd6c7705028034812becf00271b";
const declarationKey = "memory-core:memory-dreaming-promotion";
const dreamingName = "Memory Dreaming Promotion";
const dreamingTag = "[managed-by=memory-core.short-term-promotion]";
const dreamingMessage = "__openclaw_memory_core_short_term_promotion_dream__";
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const writeJson = (file, value) =>
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });

function readUpdateResult(file) {
  const raw = fs.readFileSync(file, "utf8");
  const start = raw.indexOf("{");
  assert.notEqual(start, -1, "Update reported no JSON result");
  return JSON.parse(raw.slice(start));
}

function installedIdentity(root) {
  const manifestBytes = fs.readFileSync(path.join(root, "package.json"));
  const buildBytes = fs.readFileSync(path.join(root, "dist/build-info.json"));
  const manifest = JSON.parse(manifestBytes);
  const build = JSON.parse(buildBytes);
  assert.equal(manifest.name, "openclaw");
  assert.equal(manifest.version, build.version);
  const schemaVersions = manifest.openclaw?.schemaVersions;
  for (const kind of ["state", "agent"]) {
    assert(Number.isSafeInteger(schemaVersions?.[kind]) && schemaVersions[kind] >= 0);
  }
  return {
    version: manifest.version,
    commit: build.commit,
    manifestSha256: hash(manifestBytes),
    buildInfoSha256: hash(buildBytes),
    schemaVersions: { state: schemaVersions.state, agent: schemaVersions.agent },
  };
}

function inspectSharedSchema(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const userVersion = db.prepare("PRAGMA user_version").get().user_version;
    assert(Number.isSafeInteger(userVersion) && userVersion >= 0);
    const hasMarkers = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'config_machine_state'")
      .get();
    const row = hasMarkers
      ? db
          .prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?")
          .get("state.schema.contentVersion")
      : undefined;
    const marker = row ? JSON.parse(row.value_json) : null;
    assert(marker === null || (Number.isSafeInteger(marker) && marker >= 0));
    return { userVersion, marker, contentVersion: Math.max(userVersion, marker ?? 0) };
  } finally {
    db.close();
  }
}

function inspectRows(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return db
      .prepare("SELECT * FROM cron_jobs ORDER BY store_key, sort_order, job_id")
      .all()
      .map((row) => Object.assign({}, row));
  } finally {
    db.close();
  }
}

function inspectBackups(databasePath) {
  const directory = path.dirname(databasePath);
  const prefix = `${path.basename(databasePath)}.doctor-cron-`;
  return fs
    .readdirSync(directory)
    .filter((name) => name.startsWith(prefix) && name.endsWith(".bak"))
    .toSorted()
    .map((name) => ({ name, sha256: hash(fs.readFileSync(path.join(directory, name))) }));
}

function snapshot(fixture) {
  return { rows: inspectRows(fixture.databasePath), backups: inspectBackups(fixture.databasePath) };
}

function configure(stateDir) {
  fs.mkdirSync(path.join(stateDir, "workspace"), { recursive: true });
  writeJson(process.env.OPENCLAW_CONFIG_PATH, {
    gateway: {
      mode: "local",
      bind: "loopback",
      controlUi: { enabled: false },
      auth: { mode: "token", token: "upgrade-survivor-token" },
    },
    agents: {
      ownership: "explicit",
      entries: { main: { workspace: path.join(stateDir, "workspace") } },
    },
    cron: { enabled: false },
    plugins: {
      allow: ["memory-core"],
      slots: { memory: "memory-core" },
      entries: { "memory-core": { enabled: true, config: { dreaming: { enabled: true } } } },
    },
  });
}

// These are historical persisted rows, not jobs created by candidate helpers.
// The shipped schema and definition digest format make them otherwise current.
function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function seed(stateDir, artifacts, baselineRoot, candidateTarball) {
  const baseline = installedIdentity(baselineRoot);
  assert.equal(baseline.version, baselineVersion);
  assert.equal(baseline.commit, baselineCommit);
  const scratch = fs.mkdtempSync(
    path.join(process.env.OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT, "dreaming-package-"),
  );
  let candidate;
  try {
    execFileSync("tar", [
      "-xzf",
      candidateTarball,
      "-C",
      scratch,
      "package/package.json",
      "package/openclaw.mjs",
      "package/dist",
    ]);
    const root = path.join(scratch, "package");
    candidate = installedIdentity(root);
    assert.notEqual(candidate.buildInfoSha256, baseline.buildInfoSha256);
    writeJson(
      path.join(artifacts, "dreaming-cron-candidate-package.json"),
      readWorkerCellPackageIdentity(root),
    );
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  const databasePath = path.join(stateDir, "state/openclaw.sqlite");
  assert(fs.statSync(databasePath).isFile(), "Baseline preparation did not create SQLite state");
  const sharedSchemaBefore = inspectSharedSchema(databasePath);
  assert.equal(sharedSchemaBefore.contentVersion, baseline.schemaVersions.state);
  const active = path.resolve(stateDir, "cron/jobs.json");
  const inactive = path.resolve(stateDir, "cron/retired-profile.json");
  const phaseOnly = path.resolve(stateDir, "cron/phase-only.json");
  const baselineRows = inspectRows(databasePath);
  writeJson(path.join(artifacts, "dreaming-cron-baseline-rows.json"), baselineRows);
  // Published Doctor materializes the default heartbeat even with cron execution disabled.
  assert.equal(baselineRows.length, 1, "Prepared baseline must contain only the main heartbeat");
  const heartbeat = baselineRows[0];
  assert.equal(heartbeat.store_key, active);
  assert.equal(heartbeat.declaration_key, "heartbeat:main");
  assert.equal(heartbeat.agent_id, "main");
  assert.equal(heartbeat.payload_kind, "heartbeat");
  assert.equal(heartbeat.enabled, 1);
  const heartbeatDefinition = JSON.parse(heartbeat.job_json);
  assert.equal(heartbeatDefinition.id, heartbeat.job_id);
  assert.equal(heartbeatDefinition.declarationKey, "heartbeat:main");
  assert.equal(heartbeatDefinition.name, "heartbeat-main");
  assert.equal(heartbeatDefinition.agentId, "main");
  assert.equal(heartbeatDefinition.enabled, true);
  assert.deepEqual(heartbeatDefinition.payload, { kind: "heartbeat" });
  assert.equal(heartbeatDefinition.schedule.kind, "every");
  assert.equal(heartbeatDefinition.schedule.everyMs, 1_800_000);
  assert.equal(heartbeatDefinition.sessionTarget, "main");
  assert.equal(heartbeatDefinition.wakeMode, "next-heartbeat");
  const make = (storeKey, id, createdAtMs, overrides = {}) => ({
    storeKey,
    definition: {
      id,
      name: dreamingName,
      description: dreamingTag,
      enabled: false,
      agentId: "main",
      owner: { agentId: "main" },
      createdAtMs,
      schedule: { kind: "cron", expr: "17 3 * * *", tz: "UTC", staggerMs: 0 },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: dreamingMessage },
      delivery: { mode: "none" },
      state: {},
      ...overrides,
    },
  });
  const phase = (kind) => ({
    name: `Memory ${kind === "light" ? "Light" : "REM"} Dreaming`,
    description: `[managed-by=memory-core.dreaming.${kind}]`,
    payload: {
      kind: "systemEvent",
      text: `__openclaw_memory_core_${kind === "light" ? "light" : "rem"}_sleep__`,
    },
  });
  const jobs = [
    make(active, "dreaming-active-declared", 200, {
      declarationKey,
      sessionTarget: "isolated",
      payload: {
        kind: "agentTurn",
        message: dreamingMessage,
        lightContext: false,
        timeoutSeconds: 60,
      },
    }),
    make(active, "dreaming-active-older-unkeyed", 100),
    make(active, "dreaming-active-light", 90, phase("light")),
    make(inactive, "dreaming-inactive-survivor", 100),
    make(inactive, "dreaming-inactive-duplicate", 200),
    make(inactive, "dreaming-inactive-rem", 90, phase("rem")),
    make(phaseOnly, "dreaming-phase-survivor", 100, phase("light")),
    make(phaseOnly, "dreaming-phase-duplicate", 200, phase("rem")),
    make(active, "dreaming-authored-lookalike", 50, {
      description: "An operator-authored reminder",
      payload: { kind: "systemEvent", text: "Write a personal dream diary" },
    }),
    make(active, "dreaming-foreign-declaration", 25, {
      declarationKey: "another-plugin:owned-job",
    }),
    make(active, "dreaming-authored-tagged", 24, {
      name: "Authored tagged maintenance",
      description: `${dreamingTag} An operator-authored reminder`,
      payload: { kind: "systemEvent", text: "Keep this authored reminder unchanged" },
    }),
  ];
  const db = new DatabaseSync(databasePath);
  try {
    const insert = db.prepare(`INSERT INTO cron_jobs (
      store_key, job_id, declaration_key, owner_agent_id, name, description, enabled,
      agent_id, payload_kind, job_json, grant_definition_revision,
      grant_definition_generation, grant_definition_updated_at, state_json,
      runtime_updated_at_ms, schedule_identity, sort_order, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    db.exec("BEGIN IMMEDIATE");
    for (const [index, { storeKey, definition }] of jobs.entries()) {
      const updatedAt = 1_800_000_000_000 + index;
      const { enabled: _enabled, state: _state, ...grantDefinition } = definition;
      const revision = `sha256:${createHash("sha256").update(stableJson(grantDefinition)).digest("base64url")}`;
      const runtimeState = {
        lastRunAtMs: updatedAt - 10_000,
        lastRunStatus: "error",
        lastStatus: "error",
        lastDurationMs: 321 + index,
        consecutiveErrors: 2,
        lastError: "synthetic retained error",
      };
      insert.run(
        storeKey,
        definition.id,
        definition.declarationKey ?? null,
        "main",
        definition.name,
        definition.description,
        0,
        "main",
        definition.payload.kind,
        JSON.stringify(definition),
        revision,
        3,
        updatedAt,
        JSON.stringify(runtimeState),
        updatedAt + 10,
        JSON.stringify({
          version: 2,
          enabled: false,
          schedule: definition.schedule,
          hasTrigger: false,
        }),
        10 + index * 3,
        updatedAt,
      );
    }
    db.exec("COMMIT");
  } finally {
    db.close();
  }
  const fixture = {
    baseline,
    candidate,
    candidateTarballSha256: hash(fs.readFileSync(candidateTarball)),
    databasePath,
    baselineRows,
    sharedSchemaBefore,
  };
  writeJson(path.join(artifacts, "dreaming-cron-fixture.json"), {
    ...fixture,
    before: snapshot(fixture),
  });
}

function assertRepaired(fixture, rows) {
  const survivorIds = [
    "dreaming-active-declared",
    "dreaming-inactive-survivor",
    "dreaming-phase-survivor",
  ];
  const preservedIds = [
    "dreaming-authored-lookalike",
    "dreaming-foreign-declaration",
    "dreaming-authored-tagged",
    ...fixture.baselineRows.map((row) => row.job_id),
  ];
  assert.deepEqual(
    rows.map((row) => row.job_id).toSorted((left, right) => left.localeCompare(right)),
    [...survivorIds, ...preservedIds].toSorted((left, right) => left.localeCompare(right)),
    "Dreaming migration chose the wrong survivors or retained a duplicate/phase",
  );
  for (const row of rows) {
    const before =
      fixture.baselineRows.find((entry) => entry.job_id === row.job_id) ??
      fixture.before.rows.find((entry) => entry.job_id === row.job_id);
    if (preservedIds.includes(row.job_id)) {
      assert.deepEqual(row, before, `Preserved job changed: ${row.job_id}`);
      continue;
    }
    for (const field of [
      "store_key",
      "job_id",
      "sort_order",
      "state_json",
      "runtime_updated_at_ms",
    ]) {
      assert.equal(row[field], before[field], `Survivor ${row.job_id} lost ${field}`);
    }
    const definition = JSON.parse(row.job_json);
    assert.equal(row.declaration_key, declarationKey);
    assert.equal(definition.declarationKey, declarationKey);
    assert.equal(definition.id, row.job_id);
    assert.equal(definition.sessionTarget, "isolated");
    assert.equal(definition.payload.kind, "agentTurn");
    assert.equal(definition.payload.message, dreamingMessage);
    assert.equal(definition.payload.lightContext, true);
    assert.equal(definition.payload.text, undefined);
    assert.equal(definition.delivery.mode, "none");
    const original = JSON.parse(before.job_json);
    for (const field of ["createdAtMs", "schedule", "enabled", "owner", "agentId", "wakeMode"]) {
      assert.deepEqual(
        definition[field],
        original[field],
        `Survivor ${row.job_id} changed ${field}`,
      );
    }
    if (row.job_id === "dreaming-active-declared") {
      assert.equal(definition.payload.timeoutSeconds, 60);
    }
  }
}

function observeProcess() {
  const fixturePath = process.env.OPENCLAW_UPGRADE_SURVIVOR_DREAMING_CRON_FIXTURE;
  const observations = process.env.OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT;
  const delegatedDoctor =
    process.argv[2] === "--doctor" &&
    path.basename(process.argv[1] ?? "") === "update-migrated-finalize.worker.js";
  const role = delegatedDoctor ? "doctor" : process.argv[2];
  if (!isMainThread || !fixturePath || !observations || !["doctor", "update"].includes(role)) {
    return;
  }
  const receipt = {
    role,
    pid: process.pid,
    parentPid: process.ppid,
    transport: delegatedDoctor ? "delegated-worker" : "cli",
    updateInProgress: process.env.OPENCLAW_UPDATE_IN_PROGRESS === "1",
    repair: process.argv.includes("--repair"),
    nonInteractive: process.argv.includes("--non-interactive"),
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
        receipt.entrypoint = path.relative(root, fs.realpathSync(process.argv[1]));
        break;
      }
    }
    receipt.before = snapshot(fixture);
  } catch (error) {
    receipt.observationError = String(error);
  }
  const file = path.join(observations, `dreaming-cron-${role}-${process.pid}.json`);
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

function assertUpdated(artifacts, observations, packageRoot, candidateTarball) {
  const fixture = readJson(path.join(artifacts, "dreaming-cron-fixture.json"));
  const sharedSchemaAfter = inspectSharedSchema(fixture.databasePath);
  assert.equal(sharedSchemaAfter.contentVersion, fixture.candidate.schemaVersions.state);
  const update = readUpdateResult(path.join(artifacts, "update.json"));
  assert.equal(update.status, "ok");
  assert.equal(update.before.version, fixture.baseline.version);
  assert.equal(update.after.version, fixture.candidate.version);
  assert.match(update.runId, /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/iu);
  assert.equal(update.run.runId, update.runId);
  assert.equal(update.run.status, "succeeded");
  assert.equal(update.run.phase, "finished");
  assert(Number.isFinite(update.run.finishedAtMs));
  for (const [side, expected] of [
    ["before", fixture.baseline],
    ["after", fixture.candidate],
  ]) {
    if (update.run[side]?.version != null) {
      assert.equal(update.run[side].version, expected.version);
    }
  }
  assert.equal(hash(fs.readFileSync(candidateTarball)), fixture.candidateTarballSha256);
  assertWorkerCellPackageIdentity(
    readWorkerCellPackageIdentity(packageRoot),
    readJson(path.join(artifacts, "dreaming-cron-candidate-package.json")),
  );
  const receipts = fs
    .readdirSync(observations)
    .filter((name) => /^dreaming-cron-(doctor|update)-\d+\.json$/u.test(name))
    .map((name) => readJson(path.join(observations, name)));
  const updater = receipts.find(
    (entry) =>
      entry.role === "update" &&
      entry.identity?.buildInfoSha256 === fixture.baseline.buildInfoSha256,
  );
  assert(updater, "No published updater process observed");
  assert.deepEqual(updater.identity, fixture.baseline);
  assert.deepEqual(
    updater.before,
    fixture.before,
    "Published updater did not receive the seeded rows",
  );
  const doctor = receipts.find(
    (entry) =>
      entry.role === "doctor" &&
      (entry.transport === "delegated-worker" || (entry.repair && entry.nonInteractive)) &&
      entry.identity?.buildInfoSha256 === fixture.candidate.buildInfoSha256 &&
      entry.before?.rows.some((row) => row.job_id === "dreaming-inactive-duplicate"),
  );
  assert(doctor, "Packaged candidate Doctor never received unrepaired dreaming rows");
  assert.deepEqual(doctor.identity, fixture.candidate);
  assert.equal(doctor.updateInProgress, true, "Repair was not the installed updater's child");
  if (doctor.transport === "cli") {
    assert.equal(doctor.repair, true, "Installed updater did not request Doctor repair");
    assert.equal(doctor.nonInteractive, true);
  } else {
    assert.equal(doctor.entrypoint, "dist/infra/update-migrated-finalize.worker.js");
  }
  assert.deepEqual(
    doctor.before,
    fixture.before,
    "Runtime or earlier startup changed the specimen before Doctor",
  );
  for (const witness of [updater, doctor]) {
    assert.equal(witness.observationError, undefined);
    assert.equal(witness.exitCode, 0);
    const exited = readJson(
      path.join(observations, "diagnostics", `process-${witness.pid}-exited.json`),
    );
    assert.equal(exited.pid, witness.pid);
    assert.equal(exited.parentPid, witness.parentPid);
    assert.equal(exited.role, witness.role);
    assert.equal(exited.packageVersion, witness.identity.version);
    assert.equal(exited.exitCode, 0);
  }
  assertRepaired(fixture, doctor.after.rows);
  const current = snapshot(fixture);
  assert.deepEqual(current, doctor.after, "Cron changed after updater Doctor exited");
  const added = current.backups.filter(
    (entry) => !fixture.before.backups.some((before) => before.name === entry.name),
  );
  assert.equal(added.length, 1, "Repair must retain exactly one new cron backup");
  const backupPath = path.join(path.dirname(fixture.databasePath), added[0].name);
  const backup = new DatabaseSync(backupPath, { readOnly: true });
  try {
    assert.deepEqual(
      backup
        .prepare("PRAGMA integrity_check")
        .all()
        .map((row) => row.integrity_check),
      ["ok"],
    );
    assert.deepEqual(backup.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    backup.close();
  }
  assert.deepEqual(
    inspectRows(backupPath),
    fixture.before.rows,
    "Verified backup did not preserve the pre-repair jobs",
  );
  writeJson(path.join(artifacts, "dreaming-cron-updated.json"), current);
  writeJson(path.join(artifacts, "dreaming-cron-proof.json"), {
    status: "updater-child-repaired",
    baseline: fixture.baseline,
    candidate: fixture.candidate,
    sharedSchema: { before: fixture.sharedSchemaBefore, after: sharedSchemaAfter },
    terminalUpdate: {
      runId: update.runId,
      status: update.status,
      before: update.before,
      after: update.after,
      runStatus: update.run.status,
      runPhase: update.run.phase,
      finishedAtMs: update.run.finishedAtMs,
    },
    updaterPid: updater.pid,
    doctorPid: doctor.pid,
    doctorTransport: doctor.transport,
    backup: added[0],
    baselineHeartbeatId: fixture.baselineRows[0].job_id,
    survivors: current.rows.map((row) => ({
      id: row.job_id,
      storeKey: row.store_key,
      sortOrder: row.sort_order,
    })),
  });
}

function prepareRuntime(artifacts) {
  const fixture = readJson(path.join(artifacts, "dreaming-cron-fixture.json"));
  const before = snapshot(fixture);
  assert.deepEqual(before, readJson(path.join(artifacts, "dreaming-cron-updated.json")));
  const config = readJson(process.env.OPENCLAW_CONFIG_PATH);
  const scheduled = new Date(Date.now() + 7 * 24 * 60 * 60_000);
  scheduled.setUTCHours(12, 17, 0, 0);
  const frequency = `17 12 ${scheduled.getUTCDate()} ${scheduled.getUTCMonth() + 1} *`;
  // Only this post-Doctor runtime fixture runs the scheduler. Keep model work dormant.
  config.cron.enabled = true;
  config.agents.entries.main.heartbeat = { every: "0m" };
  config.skills ??= {};
  config.skills.workshop ??= {};
  config.skills.workshop.autonomous = { mode: "off" };
  const dreaming = config.plugins.entries["memory-core"].config.dreaming;
  dreaming.frequency = frequency;
  dreaming.timezone = "UTC";
  writeJson(process.env.OPENCLAW_CONFIG_PATH, config);
  writeJson(path.join(artifacts, "dreaming-cron-runtime.json"), {
    before,
    frequency,
    storeKey: fixture.baselineRows[0].store_key,
    jobId: "dreaming-active-declared",
  });
  for (const name of ["dreaming-cron-runtime-reload.json", "dreaming-cron-runtime-reload.err"]) {
    fs.writeFileSync(path.join(artifacts, name), "", { mode: 0o600 });
  }
}

function assertRuntimeCanonical(row, runtime) {
  const before = runtime.before.rows.find((entry) => entry.job_id === runtime.jobId);
  assert(row, "Runtime lost the declared dreaming job");
  for (const field of ["store_key", "job_id"]) {
    assert.equal(row[field], before[field], `Runtime changed canonical ${field}`);
  }
  assert.equal(row.declaration_key, declarationKey);
  assert.equal(row.enabled, 1);
  const definition = JSON.parse(row.job_json);
  assert.equal(definition.name, dreamingName);
  assert.equal(definition.enabled, true);
  assert.equal(definition.schedule.kind, "cron");
  assert.equal(definition.schedule.expr, runtime.frequency);
  assert.equal(definition.schedule.tz, "UTC");
  assert.equal(definition.sessionTarget, "isolated");
  assert.equal(definition.wakeMode, "now");
  assert.equal(definition.payload.kind, "agentTurn");
  assert.equal(definition.payload.message, dreamingMessage);
  assert.equal(definition.payload.lightContext, true);
  assert.equal(definition.delivery.mode, "none");
  const state = JSON.parse(row.state_json);
  assert.equal(state.lastRunAtMs, JSON.parse(before.state_json).lastRunAtMs);
  assert(
    state.nextRunAtMs > Date.now() + 24 * 60 * 60_000,
    "Dreaming must stay scheduled in the future",
  );
}

async function waitRuntime(artifacts) {
  const fixture = readJson(path.join(artifacts, "dreaming-cron-fixture.json"));
  const runtime = readJson(path.join(artifacts, "dreaming-cron-runtime.json"));
  const deadline =
    Date.now() + readPositiveIntEnv("OPENCLAW_UPGRADE_SURVIVOR_START_BUDGET_SECONDS", 90) * 1000;
  // Plugin services start after HTTP readiness; the committed cron row is the barrier.
  while (Date.now() < deadline) {
    const row = inspectRows(fixture.databasePath).find((entry) => entry.job_id === runtime.jobId);
    if (row?.enabled === 1) {
      assertRuntimeCanonical(row, runtime);
      writeJson(path.join(artifacts, "dreaming-cron-runtime-converged.json"), row);
      return;
    }
    await delay(100);
  }
  writeJson(
    path.join(artifacts, "dreaming-cron-runtime-unconverged.json"),
    inspectRows(fixture.databasePath),
  );
  assert.fail("Canonical dreaming did not converge while an authored tagged row was retained");
}

function assertRuntime(artifacts, gatewayLog) {
  const fixture = readJson(path.join(artifacts, "dreaming-cron-fixture.json"));
  const runtime = readJson(path.join(artifacts, "dreaming-cron-runtime.json"));
  const reloadText = fs.readFileSync(
    path.join(artifacts, "dreaming-cron-runtime-reload.json"),
    "utf8",
  );
  const reload = JSON.parse(reloadText.slice(reloadText.indexOf("{")));
  assert.equal(reload.ok, true);
  assert.equal(reload.restartRequired, false);
  assert.deepEqual(reload.pluginIds, ["memory-core"]);
  const current = snapshot(fixture);
  writeJson(path.join(artifacts, "dreaming-cron-runtime-after.json"), current);
  process.stdout.write(
    `DREAMING_CRON_RUNTIME_INVENTORY ${JSON.stringify(
      current.rows.map((row) => ({
        id: row.job_id,
        storeKey: row.store_key,
        declarationKey: row.declaration_key,
        enabled: row.enabled,
        name: row.name,
      })),
    )}\n`,
  );
  const managed = current.rows.filter(
    (row) => row.store_key === runtime.storeKey && row.declaration_key === declarationKey,
  );
  assert.equal(managed.length, 1);
  assertRuntimeCanonical(managed[0], runtime);
  assert.deepEqual(
    managed[0],
    readJson(path.join(artifacts, "dreaming-cron-runtime-converged.json")),
    "Settled plugin reload rewrote an already-converged dreaming job",
  );
  // Gateway retains a disabled Workshop monitor even when autonomous work is off.
  const workshop = current.rows.filter(
    (row) =>
      row.store_key === runtime.storeKey && row.declaration_key === "skill-collection-review:main",
  );
  assert.equal(workshop.length, 1);
  assert.equal(workshop[0].enabled, 0);
  const workshopJob = JSON.parse(workshop[0].job_json);
  assert.equal(workshopJob.name, "skill-collection-review-main");
  assert.equal(workshopJob.agentId, "main");
  assert.equal(workshopJob.enabled, false);
  assert.equal(workshopJob.payload.kind, "agentTurn");
  assert.equal(workshopJob.sessionTarget, "isolated");
  assert.equal(workshopJob.delivery.mode, "none");
  const workshopState = JSON.parse(workshop[0].state_json);
  assert.equal(workshopState.nextRunAtMs, undefined);
  assert.equal(workshopState.lastRunAtMs, undefined);
  assert.deepEqual(
    current.rows.filter((row) => row !== workshop[0]).map((row) => [row.store_key, row.job_id]),
    runtime.before.rows.map((row) => [row.store_key, row.job_id]),
    "Runtime changed cron row membership or order",
  );
  const activeRows = current.rows.filter((row) => row.store_key === runtime.storeKey);
  for (const before of runtime.before.rows) {
    // The active heartbeat belongs to its own config owner after explicit runtime enablement.
    if (before.job_id === runtime.jobId || before.job_id === fixture.baselineRows[0].job_id) {
      continue;
    }
    const row = current.rows.find(
      (entry) => entry.store_key === before.store_key && entry.job_id === before.job_id,
    );
    if (before.store_key !== runtime.storeKey) {
      assert.deepEqual(row, before, `Runtime changed inactive cron row ${before.job_id}`);
      continue;
    }
    assert(row, `Runtime lost active cron row ${before.job_id}`);
    // Enabled saves compact ordinals and project the retained runtime timestamp into config.
    assert.deepEqual(
      { ...row, job_json: JSON.parse(row.job_json) },
      {
        ...before,
        sort_order: activeRows.findIndex((entry) => entry.job_id === before.job_id),
        updated_at: before.runtime_updated_at_ms,
        grant_definition_updated_at: before.runtime_updated_at_ms,
        job_json: JSON.parse(before.job_json),
      },
      `Runtime changed authored cron row ${before.job_id}`,
    );
  }
  assert.deepEqual(
    current.backups,
    runtime.before.backups,
    "Runtime changed Doctor backup evidence",
  );
  const lines = fs.readFileSync(gatewayLog, "utf8").split("\n");
  assert(
    lines.some(
      (line) =>
        line.includes("dreaming-authored-tagged") &&
        line.includes("Review their ownership manually"),
    ),
    "Runtime did not identify the authored tagged row for manual ownership review",
  );
  const proof = {
    status: "passed",
    candidate: fixture.candidate,
    canonicalId: managed[0].job_id,
    canonicalSortOrder: managed[0].sort_order,
    frequency: runtime.frequency,
    authoredTaggedUnchanged: true,
    inactiveRowsUnchanged: true,
    doctorBackupUnchanged: true,
    settledPluginReloadNoop: true,
    pluginGeneration: reload.runtime.generation,
  };
  writeJson(path.join(artifacts, "dreaming-cron-runtime-proof.json"), proof);
  process.stdout.write(`DREAMING_CRON_RUNTIME_PROOF ${JSON.stringify(proof)}\n`);
}

async function reportUpdateFailure(file, packageRoot) {
  const result = readUpdateResult(file);
  const step = result.steps?.find((entry) => entry.name === "candidate-gateway-startup");
  assert(step, "Update result has no candidate Gateway startup step");
  const { redactSensitiveText } = await import(
    pathToFileURL(path.join(packageRoot, "dist/plugin-sdk/logging-core.js")).href
  );
  const report = {
    step: step.name,
    exitCode: step.exitCode,
    stderrTail: redactSensitiveText(step.stderrTail ?? "", { mode: "tools" }),
    stdoutTail: redactSensitiveText(step.stdoutTail ?? "", { mode: "tools" }),
  };
  process.stdout.write(`DREAMING_CRON_GATEWAY_STARTUP ${JSON.stringify(report)}\n`);
}

observeProcess();
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [command, ...args] = process.argv.slice(2);
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  const artifacts = process.env.OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT;
  assert(stateDir && artifacts, "Missing isolated survivor paths");
  if (command === "configure") {
    configure(stateDir);
  } else if (command === "seed") {
    seed(stateDir, artifacts, ...args);
  } else if (command === "assert-updated") {
    assertUpdated(artifacts, ...args);
  } else if (command === "prepare-runtime") {
    prepareRuntime(artifacts);
  } else if (command === "wait-runtime") {
    await waitRuntime(artifacts);
  } else if (command === "assert-runtime") {
    assertRuntime(artifacts, ...args);
  } else if (command === "report-update-failure") {
    await reportUpdateFailure(...args);
  } else {
    assert.equal(command, "assert-idempotent");
    const fixture = readJson(path.join(artifacts, "dreaming-cron-fixture.json"));
    assert.deepEqual(
      snapshot(fixture),
      readJson(path.join(artifacts, "dreaming-cron-updated.json")),
      "Repeated Doctor rewrote cron rows or created another backup",
    );
    const proofPath = path.join(artifacts, "dreaming-cron-proof.json");
    const proof = {
      ...readJson(proofPath),
      status: "passed",
      explicitDoctorIdempotent: true,
    };
    writeJson(proofPath, proof);
    process.stdout.write(`DREAMING_CRON_PROOF ${JSON.stringify(proof)}\n`);
  }
}
