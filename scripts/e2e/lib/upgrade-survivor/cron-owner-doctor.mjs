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

const fixtureName = "cron-owner-fixture.json";
const prefix = "owner-proof-";
const sessionKey = "agent:ops:owner-proof-continuity";
const sessionMarker = "Synthetic cron ownership upgrade continuity witness";
const deliveryCases = [
  {
    name: "delivery-missing",
    delivery: { channel: "telegram", to: "synthetic-target" },
    mode: "announce",
  },
  {
    name: "delivery-null",
    delivery: { mode: null, channel: "telegram", to: "synthetic-target" },
    mode: "announce",
  },
  {
    name: "delivery-alias",
    delivery: { mode: "deliver", channel: "telegram", to: "synthetic-target" },
    mode: "announce",
  },
  {
    name: "delivery-announce-case",
    delivery: { mode: " ANNOUNCE ", channel: "telegram", to: "synthetic-target" },
    mode: "announce",
  },
  { name: "delivery-none-case", delivery: { mode: " NoNe " }, mode: "none" },
  {
    name: "delivery-webhook-case",
    delivery: { mode: " WeBhOoK ", to: "https://example.invalid/cron" },
    mode: "webhook",
  },
];
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const writeJson = (file, value) =>
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });

function parseCliJson(raw) {
  const start = raw.indexOf("{");
  assert(start >= 0, "CLI returned no JSON object");
  return JSON.parse(raw.slice(start));
}

function paths() {
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  const artifacts = process.env.OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT;
  const runtime = process.env.OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT;
  assert(stateDir && configPath && artifacts && runtime, "Missing isolated survivor paths");
  assert(path.resolve(stateDir).startsWith(`${path.resolve(runtime)}/`));
  assert(path.resolve(configPath).startsWith(`${path.resolve(stateDir)}/`));
  return {
    stateDir,
    configPath,
    artifacts,
    databasePath: path.join(stateDir, "state/openclaw.sqlite"),
  };
}

function readDatabase(databasePath, run) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return run(db);
  } finally {
    db.close();
  }
}

function inspectRows(databasePath, storePath) {
  return readDatabase(databasePath, (db) =>
    db
      .prepare(
        "SELECT * FROM cron_jobs WHERE store_key = ? AND job_id GLOB 'owner-proof-*' ORDER BY sort_order, job_id",
      )
      .all(storePath)
      .map((row) => Object.assign({}, row)),
  );
}

function inspectBackups(databasePath) {
  return fs
    .readdirSync(path.dirname(databasePath))
    .filter(
      (name) =>
        name.startsWith(`${path.basename(databasePath)}.doctor-cron-`) && name.endsWith(".bak"),
    )
    .toSorted()
    .map((name) => ({
      name,
      sha256: hash(fs.readFileSync(path.join(path.dirname(databasePath), name))),
    }));
}

function snapshot(fixture) {
  const config = readJson(fixture.configPath);
  return {
    rows: inspectRows(fixture.databasePath, fixture.storePath),
    backups: inspectBackups(fixture.databasePath),
    historicalMarker: config.agents?.entries?.ops?.default === true,
    legacySourceSha256: fs.existsSync(fixture.storePath)
      ? hash(fs.readFileSync(fixture.storePath))
      : null,
  };
}

function installedProcessIdentity(entrypoint) {
  const file = fs.realpathSync(entrypoint);
  for (let root = path.dirname(file), depth = 0; depth < 4; root = path.dirname(root), depth++) {
    const manifestPath = path.join(root, "package.json");
    if (fs.existsSync(manifestPath) && readJson(manifestPath).name === "openclaw") {
      const manifest = fs.readFileSync(manifestPath);
      const build = fs.readFileSync(path.join(root, "dist/build-info.json"));
      const info = JSON.parse(build);
      assert.equal(info.version, JSON.parse(manifest).version);
      return {
        version: info.version,
        commit: info.commit,
        manifestSha256: hash(manifest),
        buildInfoSha256: hash(build),
        entrypoint: path.relative(root, file),
        entrypointSha256: hash(fs.readFileSync(file)),
      };
    }
  }
  throw new Error("Observed CLI is outside an OpenClaw package");
}

function observeProcess() {
  const fixturePath = process.env.OPENCLAW_UPGRADE_SURVIVOR_CRON_OWNER_FIXTURE;
  const artifacts = process.env.OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT;
  const delegated =
    process.argv[2] === "--doctor" &&
    path.basename(process.argv[1] ?? "") === "update-migrated-finalize.worker.js";
  const role = delegated ? "doctor" : process.argv[2];
  if (!isMainThread || !fixturePath || !artifacts || !["update", "doctor"].includes(role)) {
    return;
  }
  const fixture = readJson(fixturePath);
  // Canary copies are separate state owners and cannot prove the live update's repair.
  if (fixture.databasePath !== path.join(process.env.OPENCLAW_STATE_DIR, "state/openclaw.sqlite")) {
    return;
  }
  const receipt = {
    role,
    pid: process.pid,
    parentPid: process.ppid,
    transport: delegated ? "delegated-worker" : "cli",
    updateInProgress: process.env.OPENCLAW_UPDATE_IN_PROGRESS === "1",
    repair: process.argv.includes("--fix") || process.argv.includes("--repair"),
    nonInteractive: process.argv.includes("--non-interactive"),
  };
  try {
    receipt.identity = installedProcessIdentity(process.argv[1]);
    receipt.before = snapshot(fixture);
  } catch (error) {
    receipt.observationError = String(error);
  }
  const file = path.join(artifacts, `cron-owner-${role}-${process.pid}.json`);
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

function gateway(artifacts, name, method, params) {
  const stdout = execFileSync(
    "openclaw",
    [
      "gateway",
      "call",
      method,
      "--url",
      "ws://127.0.0.1:18789",
      "--token",
      "upgrade-survivor-token",
      "--timeout",
      "30000",
      "--json",
      "--params",
      JSON.stringify(params),
    ],
    { encoding: "utf8", timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
  );
  fs.writeFileSync(path.join(artifacts, `cron-owner-${name}.json`), stdout, { mode: 0o600 });
  return parseCliJson(stdout);
}

function configure(p) {
  for (const agentId of ["ops", "research"]) {
    fs.mkdirSync(path.join(p.stateDir, "workspaces", agentId), { recursive: true });
  }
  writeJson(p.configPath, {
    gateway: {
      mode: "local",
      bind: "loopback",
      controlUi: { enabled: false },
      auth: { mode: "token", token: "upgrade-survivor-token" },
    },
    agents: {
      ownership: "explicit",
      defaults: { systemAgent: { agentId: "research" } },
      entries: Object.fromEntries(
        ["ops", "research"].map((agentId) => [
          agentId,
          { workspace: path.join(p.stateDir, "workspaces", agentId), heartbeat: { every: "0m" } },
        ]),
      ),
    },
    cron: { enabled: false },
    plugins: { enabled: false },
    skills: { workshop: { autonomous: { mode: "off" } } },
  });
}

function seedSession(p) {
  const created = gateway(p.artifacts, "baseline-session-create", "sessions.create", {
    key: sessionKey,
    agentId: "ops",
    label: "owner-proof-continuity",
  });
  assert(created.ok && created.sessionId && created.key === sessionKey);
  assert.equal(created.runStarted, false, "Session creation unexpectedly started inference");
  const injected = gateway(p.artifacts, "baseline-session-inject", "chat.inject", {
    sessionKey,
    agentId: "ops",
    message: sessionMarker,
  });
  assert(injected.ok && injected.messageId);
  const history = gateway(p.artifacts, "baseline-session-history", "chat.history", {
    sessionKey,
    agentId: "ops",
    limit: 20,
  });
  assert.equal(history.sessionId, created.sessionId);
  assert(
    history.messages.some(
      (message) =>
        message.id === injected.messageId &&
        JSON.stringify(message.content).includes(sessionMarker),
    ),
  );
  writeJson(path.join(p.artifacts, "cron-owner-session.json"), {
    sessionId: created.sessionId,
    messageId: injected.messageId,
    messages: history.messages,
  });
}

function seed(p) {
  const baseline = readJson(path.join(p.artifacts, "baseline-package-identity.json"));
  const candidate = readJson(path.join(p.artifacts, "candidate-package-identity.json"));
  assert(["2026.9.4", "2026.9.7"].includes(baseline.version), "Unaudited published baseline");
  if (baseline.version === "2026.9.4") {
    assert.equal(baseline.buildInfo.commit, "3a9d69db306cd7f081e06254cb89c4bcc14a7107");
  }
  const storePath = path.join(p.stateDir, "custom-cron/jobs.json");
  const config = readJson(p.configPath);
  delete config.agents.ownership;
  config.agents.entries.ops.default = true;
  config.cron = { enabled: false, store: storePath };
  const definitions = [
    { name: "historical", overrides: {} },
    { name: "explicit", overrides: { agentId: "research" } },
    { name: "session", overrides: { sessionKey: "agent:research:main" } },
    { name: "sql-owner", overrides: {} },
    ...deliveryCases.map(({ name, delivery }) => ({
      name,
      overrides: {
        agentId: "ops",
        sessionTarget: "isolated",
        payload: { kind: "agentTurn", message: "Synthetic delivery migration", toolsAllow: [] },
        delivery,
      },
    })),
    { name: "json-import", overrides: {} },
  ].map(({ name, overrides }, index) =>
    Object.assign(
      {
        id: `${prefix}${name}`,
        name: `Authored ${name}`,
        description: `Keep description ${index}`,
        enabled: false,
        createdAtMs: 1_800_000_000_000 + index,
        updatedAtMs: 1_800_000_000_000 + index,
        schedule: { kind: "every", everyMs: 86_400_000, anchorMs: 1_800_000_000_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: `Synthetic ownership event ${name}` },
        authoredNote: { keep: name },
      },
      overrides,
      {
        state: {
          lastRunAtMs: 1_700_000_000_000 + index,
          lastRunStatus: "ok",
          lastStatus: "ok",
          lastDurationMs: 10 + index,
        },
      },
    ),
  );
  const db = new DatabaseSync(p.databasePath);
  let baselineSchema;
  try {
    const columns = db
      .prepare("PRAGMA table_info(cron_jobs)")
      .all()
      .map((row) => row.name);
    const required = [
      "store_key",
      "job_id",
      "name",
      "description",
      "enabled",
      "agent_id",
      "payload_kind",
      "job_json",
      "state_json",
      "runtime_updated_at_ms",
      "schedule_identity",
      "sort_order",
      "updated_at",
    ];
    assert(
      required.every((column) => columns.includes(column)),
      "Published cron schema differs from the audited writer",
    );
    if (baseline.version === "2026.9.4") {
      assert.equal(
        columns.some((column) => column.startsWith("grant_definition_")),
        false,
        "Baseline already contains candidate grant projections",
      );
    }
    baselineSchema = { userVersion: db.prepare("PRAGMA user_version").get().user_version, columns };
    const insert = db.prepare(
      `INSERT INTO cron_jobs (${required.join(", ")}) VALUES (${required.map(() => "?").join(", ")})`,
    );
    db.exec("BEGIN IMMEDIATE");
    for (const [index, job] of definitions.slice(0, -1).entries()) {
      const { state, updatedAtMs, ...definition } = job;
      insert.run(
        storePath,
        job.id,
        job.name,
        job.description,
        0,
        job.id === `${prefix}sql-owner` ? "research" : (job.agentId ?? null),
        job.payload.kind,
        JSON.stringify({ ...definition, state: {} }),
        JSON.stringify(state),
        updatedAtMs,
        JSON.stringify({ version: 2, enabled: false, schedule: job.schedule, hasTrigger: false }),
        index,
        updatedAtMs,
      );
    }
    db.exec("COMMIT");
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  } finally {
    db.close();
  }
  writeJson(p.configPath, config);
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  writeJson(storePath, { version: 1, jobs: [definitions.at(-1)] });
  const fixture = {
    databasePath: p.databasePath,
    configPath: p.configPath,
    storePath,
    definitions,
    baselineSchema,
    baseline,
    candidate,
    originalConfigSha256: hash(fs.readFileSync(p.configPath)),
    legacySha256: hash(fs.readFileSync(storePath)),
  };
  writeJson(path.join(p.artifacts, fixtureName), { ...fixture, before: snapshot(fixture) });
}

function assertRepaired(fixture, observed) {
  assert.equal(observed.historicalMarker, false, "Doctor did not retire the repaired marker");
  assert.equal(observed.legacySourceSha256, null, "Legacy cron source was not archived");
  assert.deepEqual(
    observed.rows.map((row) => row.job_id).toSorted(),
    fixture.definitions.map((job) => job.id).toSorted(),
  );
  for (const definition of fixture.definitions) {
    const row = observed.rows.find((entry) => entry.job_id === definition.id);
    const job = JSON.parse(row.job_json);
    const expectedOwner =
      definition.id === `${prefix}session`
        ? undefined
        : ["explicit", "sql-owner"].some((name) => definition.id === `${prefix}${name}`)
          ? "research"
          : "ops";
    assert.equal(job.agentId, expectedOwner, `Wrong canonical owner for ${definition.id}`);
    assert.equal(row.agent_id, expectedOwner ?? null);
    for (const field of [
      "id",
      "name",
      "description",
      "createdAtMs",
      "schedule",
      "sessionTarget",
      "wakeMode",
      "payload",
      "sessionKey",
      "authoredNote",
    ]) {
      assert.deepEqual(job[field], definition[field], `${definition.id} changed authored ${field}`);
    }
    const deliveryCase = deliveryCases.find(({ name }) => definition.id === `${prefix}${name}`);
    assert.deepEqual(
      job.delivery,
      deliveryCase ? { ...deliveryCase.delivery, mode: deliveryCase.mode } : definition.delivery,
      `${definition.id} did not retain its intended canonical delivery`,
    );
    assert.equal(job.enabled, false);
    assert.deepEqual(
      JSON.parse(row.state_json),
      definition.state,
      `${definition.id} lost runtime state`,
    );
    assert.equal(row.runtime_updated_at_ms, definition.updatedAtMs);
    assert.equal(row.sort_order, fixture.definitions.indexOf(definition));
  }
}

function assertUpdated(p, observations, packageRoot) {
  const fixture = readJson(path.join(p.artifacts, fixtureName));
  const update = parseCliJson(fs.readFileSync(path.join(p.artifacts, "update.json"), "utf8"));
  assert.equal(update.status, "ok");
  assert.equal(update.before.version, fixture.baseline.version);
  assert.equal(update.after.version, fixture.candidate.version);
  assert.equal(update.run.runId, update.runId);
  assert.equal(update.run.status, "succeeded");
  assert.equal(update.run.phase, "finished");
  const candidateSchema = readJson(path.join(packageRoot, "package.json")).openclaw.schemaVersions
    .state;
  const sharedSchema = readDatabase(p.databasePath, (db) => {
    const userVersion = db.prepare("PRAGMA user_version").get().user_version;
    const deferred = db
      .prepare(
        "SELECT value_json FROM config_machine_state WHERE state_key = 'state.schema.contentVersion'",
      )
      .get();
    return {
      userVersion,
      contentVersion: Math.max(userVersion, deferred ? JSON.parse(deferred.value_json) : 0),
    };
  });
  assert.equal(
    sharedSchema.contentVersion,
    candidateSchema,
    "Update did not apply the packaged candidate schema",
  );
  const receipts = fs
    .readdirSync(observations)
    .filter((name) => /^cron-owner-(doctor|update)-\d+\.json$/u.test(name))
    .map((name) => readJson(path.join(observations, name)));
  const updater = receipts.find(
    (entry) =>
      entry.role === "update" && entry.identity?.commit === fixture.baseline.buildInfo.commit,
  );
  const doctor = receipts.find(
    (entry) =>
      entry.role === "doctor" &&
      entry.identity?.commit === fixture.candidate.buildInfo.commit &&
      entry.updateInProgress &&
      (entry.transport === "delegated-worker" || (entry.repair && entry.nonInteractive)) &&
      entry.before?.historicalMarker &&
      entry.after?.historicalMarker === false,
  );
  assert(updater, "Published updater was not observed");
  assert(doctor, "Installed updater's candidate Doctor did not perform the owner repair");
  assert.deepEqual(updater.before, fixture.before, "Specimen changed before the installed update");
  assert.equal(doctor.before.legacySourceSha256, fixture.legacySha256);
  assert.deepEqual(
    doctor.before.rows.map(({ job_id, agent_id, job_json, state_json }) => ({
      job_id,
      agent_id,
      job_json,
      state_json,
    })),
    fixture.before.rows.map(({ job_id, agent_id, job_json, state_json }) => ({
      job_id,
      agent_id,
      job_json,
      state_json,
    })),
    "Jobs were repaired before candidate Doctor received them",
  );
  for (const receipt of [updater, doctor]) {
    assert.equal(receipt.observationError, undefined);
    assert.equal(receipt.exitCode, 0);
    const expected = receipt === updater ? fixture.baseline : fixture.candidate;
    assert.equal(receipt.identity.manifestSha256, expected.files["package.json"].sha256);
    assert.equal(receipt.identity.buildInfoSha256, expected.files["dist/build-info.json"].sha256);
    assert.equal(
      receipt.identity.entrypointSha256,
      expected.files[receipt.identity.entrypoint]?.sha256,
    );
    const exited = readJson(
      path.join(observations, "diagnostics", `process-${receipt.pid}-exited.json`),
    );
    assert.equal(exited.pid, receipt.pid);
    assert.equal(exited.parentPid, receipt.parentPid);
    assert.equal(exited.exitCode, 0);
  }
  assertRepaired(fixture, doctor.after);
  const current = snapshot(fixture);
  assert.deepEqual(current, doctor.after, "Cron changed after update Doctor exited");
  assert.equal(hash(fs.readFileSync(`${fixture.storePath}.migrated`)), fixture.legacySha256);
  const migration = readDatabase(p.databasePath, (db) =>
    db
      .prepare(
        "SELECT status, removed_source, source_sha256, source_record_count FROM migration_sources WHERE source_path = ? AND migration_kind = 'legacy-cron-json'",
      )
      .all(fixture.storePath),
  );
  assert.deepEqual(
    migration.map((row) => Object.assign({}, row)),
    [
      {
        status: "completed",
        removed_source: 1,
        source_sha256: fixture.legacySha256,
        source_record_count: 1,
      },
    ],
  );
  const added = current.backups.filter(
    (entry) => !fixture.before.backups.some((before) => before.name === entry.name),
  );
  assert.equal(added.length, 1, "Ownership repair did not retain one verified cron backup");
  const backupPath = path.join(path.dirname(p.databasePath), added[0].name);
  const backupRows = inspectRows(backupPath, fixture.storePath);
  assert.equal(backupRows.find((row) => row.job_id === `${prefix}historical`)?.agent_id, null);
  assert.equal(backupRows.find((row) => row.job_id === `${prefix}json-import`)?.agent_id, null);
  readDatabase(backupPath, (db) => {
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  });
  const archive = parseCliJson(
    fs.readFileSync(path.join(p.artifacts, "cron-owner-backup.json"), "utf8"),
  );
  assert.equal(archive.verified, true);
  assert.equal(
    path.resolve(archive.archivePath),
    path.join(p.artifacts, "cron-owner-before-update.tar.gz"),
  );
  assert(fs.statSync(archive.archivePath).isFile());
  writeJson(path.join(p.artifacts, "cron-owner-updated.json"), current);
  writeJson(path.join(p.artifacts, "cron-owner-proof.json"), {
    status: "updater-child-repaired",
    baselineVersion: fixture.baseline.version,
    baselineSchema: fixture.baselineSchema,
    sharedSchemaAfter: sharedSchema,
    candidateVersion: fixture.candidate.version,
    candidateCommit: fixture.candidate.buildInfo.commit,
    updateRunId: update.runId,
    updaterPid: updater.pid,
    doctorPid: doctor.pid,
    backup: added[0],
    verifiedArchive: {
      path: archive.archivePath,
      sha256: hash(fs.readFileSync(archive.archivePath)),
    },
    migration,
    fixtureOwners: current.rows.map((row) => ({ id: row.job_id, agentId: row.agent_id })),
    automaticSupervisorRestartVerified: false,
  });
}

function prepareRuntime(p) {
  const fixture = readJson(path.join(p.artifacts, fixtureName));
  assert.deepEqual(snapshot(fixture), readJson(path.join(p.artifacts, "cron-owner-updated.json")));
  const config = readJson(p.configPath);
  config.cron.enabled = true;
  writeJson(p.configPath, config);
}

async function runRuntime(p) {
  const continuity = readJson(path.join(p.artifacts, "cron-owner-session.json"));
  const history = gateway(p.artifacts, "candidate-session-history", "chat.history", {
    sessionKey,
    agentId: "ops",
    limit: 20,
  });
  assert.equal(history.sessionId, continuity.sessionId);
  assert.deepEqual(
    history.messages,
    continuity.messages,
    "Synthetic transcript changed across update",
  );
  const runs = [];
  for (const name of ["historical", "explicit"]) {
    const result = gateway(p.artifacts, `run-${name}`, "cron.run", {
      id: `${prefix}${name}`,
      mode: "force",
    });
    assert.equal(result.ok, true);
    assert.equal(result.enqueued, true);
    assert.equal(typeof result.runId, "string");
    runs.push({ jobId: `${prefix}${name}`, runId: result.runId });
    writeJson(path.join(p.artifacts, "cron-owner-runtime-runs.json"), runs);
    const deadline =
      Date.now() + readPositiveIntEnv("OPENCLAW_UPGRADE_SURVIVOR_START_BUDGET_SECONDS", 90) * 1000;
    let completed = false;
    while (Date.now() < deadline) {
      const runHistory = gateway(p.artifacts, `history-${name}`, "cron.runs", {
        id: `${prefix}${name}`,
        runId: result.runId,
        limit: 10,
      });
      const entry = runHistory.entries?.find((row) => row.runId === result.runId);
      if (entry) {
        assert.equal(entry.status, "ok", `Cron execution failed for ${name}`);
        completed = true;
        break;
      }
      await delay(100);
    }
    assert(completed, `Cron execution did not settle for ${name}`);
  }
}

function assertRuntime(p) {
  const fixture = readJson(path.join(p.artifacts, fixtureName));
  const before = readJson(path.join(p.artifacts, "cron-owner-updated.json"));
  const current = snapshot(fixture);
  for (const row of current.rows) {
    const original = before.rows.find((entry) => entry.job_id === row.job_id);
    assert(original, "Runtime introduced an unexpected fixture job");
    assert.equal(row.agent_id, original.agent_id);
    assert.deepEqual(
      JSON.parse(row.job_json),
      JSON.parse(original.job_json),
      "Runtime changed an authored cron definition",
    );
  }
  assert.equal(current.rows.length, before.rows.length);
  assert.deepEqual(current.backups, before.backups, "Runtime performed a Doctor ownership repair");
  const receipts = readDatabase(p.databasePath, (db) =>
    db
      .prepare(
        "SELECT job_id, agent_id, status, request_run_id FROM cron_run_receipts WHERE store_key = ? AND job_id GLOB 'owner-proof-*' ORDER BY job_id",
      )
      .all(fixture.storePath),
  );
  const runs = readJson(path.join(p.artifacts, "cron-owner-runtime-runs.json"));
  assert.deepEqual(
    receipts.map((row) => Object.assign({}, row)),
    [
      {
        job_id: `${prefix}explicit`,
        agent_id: "research",
        status: "ok",
        request_run_id: runs.find((run) => run.jobId === `${prefix}explicit`).runId,
      },
      {
        job_id: `${prefix}historical`,
        agent_id: "ops",
        status: "ok",
        request_run_id: runs.find((run) => run.jobId === `${prefix}historical`).runId,
      },
    ],
  );
  const proofPath = path.join(p.artifacts, "cron-owner-proof.json");
  const proof = {
    ...readJson(proofPath),
    status: "passed",
    runtimeReceipts: receipts,
    sessionContinuity: {
      sessionKey,
      sessionId: readJson(path.join(p.artifacts, "cron-owner-session.json")).sessionId,
      preserved: true,
    },
  };
  writeJson(proofPath, proof);
  process.stdout.write(`CRON_OWNER_DOCTOR_PROOF ${JSON.stringify(proof)}\n`);
}

observeProcess();
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [stage, ...args] = process.argv.slice(2);
  const p = paths();
  if (stage === "configure") {
    configure(p);
  } else if (stage === "seed-session") {
    seedSession(p);
  } else if (stage === "seed") {
    seed(p);
  } else if (stage === "assert-updated") {
    assertUpdated(p, ...args);
  } else if (stage === "prepare-runtime") {
    prepareRuntime(p);
  } else if (stage === "run-runtime") {
    await runRuntime(p);
  } else if (stage === "assert-runtime") {
    assertRuntime(p);
  } else {
    assert.equal(stage, "assert-idempotent");
    const fixture = readJson(path.join(p.artifacts, fixtureName));
    assert.deepEqual(
      snapshot(fixture),
      readJson(path.join(p.artifacts, "cron-owner-updated.json")),
      "Repeated Doctor changed cron ownership or backups",
    );
    const proofPath = path.join(p.artifacts, "cron-owner-proof.json");
    writeJson(proofPath, { ...readJson(proofPath), idempotent: true });
  }
}
