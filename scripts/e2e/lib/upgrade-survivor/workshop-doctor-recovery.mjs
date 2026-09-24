import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { isMainThread } from "node:worker_threads";
import {
  assertWorkshopLegacyImported,
  assertWorkshopLegacyWarning,
  captureWorkshopLegacyState,
  seedWorkshopLegacyProposals,
} from "./workshop-legacy-proposals.mjs";

const INDEX = "idx_skill_workshop_collection_reviews_workspace_time";
const INDEX_SQL = `CREATE INDEX ${INDEX} ON skill_workshop_collection_reviews(workspace_dir, create_time DESC, review_id DESC)`;
const REVIEW = {
  review_id: "survivor-workshop-review",
  owner_agent_id: "main",
  backup_id: "survivor-workshop-backup",
  create_time: 1,
  kept_names_json: '["retained-skill"]',
  written_names_json: "[]",
  dropped_json: "[]",
};

const readJson = (filename) => JSON.parse(fs.readFileSync(filename, "utf8"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function writeJson(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function databasePath(stateDir) {
  const filename = path.join(stateDir, "state", "openclaw.sqlite");
  assert(fs.statSync(filename).isFile(), "Published baseline did not create shared SQLite state");
  return filename;
}

function buildIdentity(manifest, buildInfo) {
  assert.equal(manifest.name, "openclaw");
  assert.equal(typeof manifest.version, "string");
  JSON.parse(buildInfo.toString("utf8"));
  return { version: manifest.version, buildInfoSha256: sha256(buildInfo) };
}

function installedIdentity(packageRoot) {
  return buildIdentity(
    readJson(path.join(packageRoot, "package.json")),
    fs.readFileSync(path.join(packageRoot, "dist", "build-info.json")),
  );
}

export function captureWorkshopBaseline(packageRoot, artifactRoot) {
  const identity = installedIdentity(packageRoot);
  assert.equal(identity.version, "2026.9.4");
  writeJson(path.join(artifactRoot, "workshop-baseline.json"), identity);
  return identity;
}

export function captureWorkshopCandidate(tarball, artifactRoot, candidateVersion) {
  const readPackedFile = (relative) =>
    execFileSync("tar", ["-xOf", tarball.replace(/^file:/u, ""), `package/${relative}`], {
      maxBuffer: 1024 * 1024,
    });
  const identity = buildIdentity(
    JSON.parse(readPackedFile("package.json").toString("utf8")),
    readPackedFile("dist/build-info.json"),
  );
  assert.equal(identity.version, candidateVersion, "Candidate artifact version changed");
  const baseline = readJson(path.join(artifactRoot, "workshop-baseline.json"));
  assert.notEqual(
    identity.buildInfoSha256,
    baseline.buildInfoSha256,
    "Candidate must be a distinct build",
  );
  writeJson(path.join(artifactRoot, "workshop-candidate.json"), identity);
  return identity;
}

function hasMalformedWorkshopIndex(filename) {
  const database = new DatabaseSync(filename, { readOnly: true });
  try {
    database.prepare("SELECT review_id FROM skill_workshop_collection_reviews LIMIT 1").get();
    return false;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("malformed database schema") &&
      error.message.includes(INDEX)
    ) {
      return true;
    }
    throw error;
  } finally {
    database.close();
  }
}

function inspectMalformedState(filename) {
  assert(hasMalformedWorkshopIndex(filename), "Legacy Workshop fixture is not malformed");
  const database = new DatabaseSync(filename, { readOnly: true });
  try {
    database.enableDefensive?.(false);
    database.exec("PRAGMA writable_schema = ON;");
    const catalog = database
      .prepare("SELECT type, name, tbl_name, rootpage, sql FROM sqlite_schema ORDER BY type, name")
      .all();
    const index = catalog.find((entry) => entry.name === INDEX);
    assert.equal(index?.sql, INDEX_SQL);
    assert(
      typeof index.rootpage === "number" && index.rootpage > 0,
      "Malformed index must retain its physical b-tree",
    );
    // Compare logical state, including the ledger, without mistaking WAL housekeeping for writes.
    const digest = createHash("sha256").update(JSON.stringify(catalog));
    for (const pragma of ["user_version", "schema_version", "application_id"]) {
      digest.update(JSON.stringify(database.prepare(`PRAGMA ${pragma}`).get()));
    }
    for (const table of catalog.filter((entry) => entry.type === "table")) {
      const rows = database
        .prepare(`SELECT * FROM "${table.name.replaceAll('"', '""')}"`)
        .all()
        .map((row) => JSON.stringify(row))
        .toSorted();
      digest.update(JSON.stringify([table.name, rows]));
    }
    const review = database
      .prepare("SELECT * FROM skill_workshop_collection_reviews WHERE review_id = ?")
      .get(REVIEW.review_id);
    assert.deepEqual({ ...review }, REVIEW, "Retained Workshop review changed");
    return {
      index: INDEX,
      sql: index.sql,
      rootpage: index.rootpage,
      stateSha256: digest.digest("hex"),
    };
  } finally {
    database.close();
  }
}

export function seedWorkshopIndex(stateDir, artifactRoot, stage) {
  assert(["baseline", "candidate"].includes(stage));
  const filename = databasePath(stateDir);
  const database = new DatabaseSync(filename);
  try {
    if (stage === "baseline") {
      database
        .prepare(
          `INSERT INTO skill_workshop_collection_reviews (
            review_id, owner_agent_id, backup_id, create_time, kept_names_json, written_names_json, dropped_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(...Object.values(REVIEW));
    } else {
      assert.deepEqual(
        {
          ...database
            .prepare("SELECT * FROM skill_workshop_collection_reviews WHERE review_id = ?")
            .get(REVIEW.review_id),
        },
        REVIEW,
        "Candidate reseeding must preserve the upgraded review",
      );
    }
    database.exec(
      `CREATE INDEX ${INDEX} ON skill_workshop_collection_reviews(review_id, create_time DESC);`,
    );
    database.enableDefensive?.(false);
    database.exec("PRAGMA writable_schema = ON;");
    database
      .prepare("UPDATE sqlite_schema SET sql = ? WHERE type = 'index' AND name = ?")
      .run(INDEX_SQL, INDEX);
    const { schema_version } = database.prepare("PRAGMA schema_version").get();
    database.exec(`PRAGMA writable_schema = OFF; PRAGMA schema_version = ${schema_version + 1};`);
  } finally {
    database.close();
  }
  const seeded = inspectMalformedState(filename);
  writeJson(path.join(artifactRoot, `workshop-${stage}-seeded.json`), seeded);
  return seeded;
}

function observeProcess() {
  const role = process.argv[2];
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  const observations = process.env.OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT;
  if (
    !isMainThread ||
    !["update", "doctor"].includes(role) ||
    !observations ||
    !stateDir ||
    stateDir !== process.env.OPENCLAW_UPGRADE_SURVIVOR_WORKSHOP_STATE_DIR
  ) {
    return;
  }
  let identity = null;
  try {
    let directory = path.dirname(fs.realpathSync(process.argv[1]));
    // Installed CLI entrypoints are at the package root or inside dist.
    for (let depth = 0; depth < 3; depth++, directory = path.dirname(directory)) {
      const manifest = path.join(directory, "package.json");
      if (fs.existsSync(manifest) && readJson(manifest).name === "openclaw") {
        identity = installedIdentity(directory);
        break;
      }
    }
  } catch {
    // Missing identity rejects the evidence without changing the observed CLI.
  }
  const legacyFixture = process.env.OPENCLAW_UPGRADE_SURVIVOR_WORKSHOP_LEGACY_FIXTURE;
  const doctorResultPath = process.env.OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH;
  let malformedAtStart;
  let legacySeed;
  let legacyAtStart;
  let startupCaptureError;
  try {
    malformedAtStart = hasMalformedWorkshopIndex(databasePath(stateDir));
    if (legacyFixture && fs.existsSync(legacyFixture)) {
      legacySeed = readJson(legacyFixture);
      if (!malformedAtStart) {
        legacyAtStart = captureWorkshopLegacyState(stateDir, legacySeed);
      }
    }
  } catch (error) {
    startupCaptureError = String(error);
  }
  const evidence = {
    role,
    pid: process.pid,
    parentPid: process.ppid,
    identity,
    updateInProgress: process.env.OPENCLAW_UPDATE_IN_PROGRESS === "1",
    malformedAtStart,
    ...(legacyAtStart ? { legacyAtStart } : {}),
    ...(startupCaptureError !== undefined ? { startupCaptureError } : {}),
  };
  const filename = path.join(observations, `workshop-process-${process.pid}.json`);
  try {
    writeJson(filename, evidence);
  } catch {
    // The exit observer can still persist the captured facts if artifact storage recovers.
  }
  process.once("exit", (exitCode) => {
    let legacyExit;
    if (role === "doctor" && legacySeed) {
      try {
        legacyExit = {
          legacyAtExit: captureWorkshopLegacyState(stateDir, legacySeed),
          ...(doctorResultPath
            ? { doctorResultAtExit: readWorkshopDoctorResult(doctorResultPath) }
            : {}),
        };
      } catch (error) {
        legacyExit = { legacyExitCaptureError: String(error) };
      }
    }
    try {
      writeJson(filename, { ...evidence, exitCode, ...legacyExit });
    } catch {
      // Missing exit evidence rejects qualification without changing the observed CLI exit.
    }
  });
}

function readWorkshopDoctorResult(filename) {
  assert(path.isAbsolute(filename), "Doctor IPC path must be absolute");
  assert.match(
    path.basename(filename),
    /^openclaw-update-doctor-\d+-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/iu,
  );
  const stat = fs.lstatSync(filename);
  assert(stat.isFile() && stat.size <= 256 * 1024, "Invalid Doctor IPC file");
  const bytes = fs.readFileSync(filename);
  assert(bytes.length <= 256 * 1024, "Doctor IPC exceeds observation limit");
  const result = JSON.parse(bytes.toString("utf8"));
  assert(["ok", "advisory"].includes(result.status), "Doctor IPC did not report success");
  const warnings = result.warnings ?? [];
  assert(
    Array.isArray(warnings) &&
      warnings.length <= 32 &&
      warnings.every((warning) => typeof warning === "string" && warning.length <= 500),
    "Invalid Doctor IPC warnings",
  );
  return { path: filename, sha256: sha256(bytes), status: result.status, warnings };
}

function processWitness(observations, identity, expected) {
  assert.match(identity.buildInfoSha256, /^[a-f0-9]{64}$/u, "Missing build identity");
  const receipts = fs
    .readdirSync(path.join(observations, "diagnostics"))
    .filter((name) => /^process-\d+-exited\.json$/u.test(name))
    .map((name) => readJson(path.join(observations, "diagnostics", name)));
  const witnesses = fs
    .readdirSync(observations)
    .filter((name) => /^workshop-process-\d+\.json$/u.test(name))
    .map((name) => readJson(path.join(observations, name)));
  const witness = witnesses.find(
    (entry) =>
      entry.identity?.version === identity.version &&
      entry.identity?.buildInfoSha256 === identity.buildInfoSha256 &&
      entry.startupCaptureError === undefined &&
      Object.entries(expected).every(([key, value]) => entry[key] === value) &&
      receipts.some(
        (receipt) =>
          receipt.role === entry.role &&
          receipt.packageVersion === identity.version &&
          receipt.pid === entry.pid &&
          receipt.parentPid === entry.parentPid &&
          receipt.exitCode === entry.exitCode,
      ),
  );
  assert(witness, `Missing matching ${expected.role} build, source-state, and exit evidence`);
  return witness;
}

function assertRepairedState(stateDir) {
  const database = new DatabaseSync(databasePath(stateDir), { readOnly: true });
  try {
    assert.equal(
      database.prepare("SELECT name FROM sqlite_schema WHERE name = ?").get(INDEX),
      undefined,
      "Doctor left the malformed Workshop index behind",
    );
    assert.deepEqual(
      {
        ...database
          .prepare("SELECT * FROM skill_workshop_collection_reviews WHERE review_id = ?")
          .get(REVIEW.review_id),
      },
      REVIEW,
      "Doctor changed the retained Workshop review",
    );
    assert.deepEqual(
      database
        .prepare("PRAGMA integrity_check")
        .all()
        .map((row) => row.integrity_check),
      ["ok"],
    );
  } finally {
    database.close();
  }
}

export function assertWorkshopUpdateRefusal(
  stateDir,
  artifactRoot,
  observations,
  packageRoot,
  exitCode,
) {
  assert.equal(exitCode, 1, "Published updater must refuse before installing the candidate");
  const baseline = readJson(path.join(artifactRoot, "workshop-baseline.json"));
  assert.deepEqual(
    installedIdentity(packageRoot),
    baseline,
    "Refused updater changed installed build",
  );
  const seeded = readJson(path.join(artifactRoot, "workshop-baseline-seeded.json"));
  assert.deepEqual(
    inspectMalformedState(databasePath(stateDir)),
    seeded,
    "Refused updater changed state",
  );
  const result = readJson(path.join(artifactRoot, "update.json"));
  assert.equal(result.ok, false);
  assert.equal(result.error?.type, "cli_error");
  assert(result.error.message.includes("SQLite integrity_check failed"));
  assert(result.error.message.includes(`Page ${seeded.rootpage}: never used`));
  const updater = processWitness(observations, baseline, {
    role: "update",
    exitCode: 1,
    malformedAtStart: true,
  });
  const doctorStarted = fs
    .readdirSync(path.join(observations, "diagnostics"))
    .filter((name) => /^process-\d+-started\.json$/u.test(name))
    .some((name) =>
      ["doctor", "post-core"].includes(readJson(path.join(observations, "diagnostics", name)).role),
    );
  assert.equal(doctorStarted, false, "Published refusal must precede the candidate handoff");
  const refusal = {
    status: "refused-before-candidate",
    automaticRepair: false,
    stateSha256: seeded.stateSha256,
    updater,
  };
  writeJson(path.join(artifactRoot, "workshop-published-refusal.json"), refusal);
  return refusal;
}

export function assertWorkshopDoctorRepair(stateDir, artifactRoot, observations, stage) {
  assert(["baseline", "candidate"].includes(stage));
  const identity = readJson(path.join(artifactRoot, `workshop-${stage}.json`));
  assertRepairedState(stateDir);
  const doctor = processWitness(observations, identity, {
    role: "doctor",
    exitCode: 0,
    malformedAtStart: true,
    updateInProgress: false,
  });
  let legacy;
  let legacyWarning;
  if (
    stage === "candidate" &&
    fs.existsSync(path.join(artifactRoot, "workshop-legacy-seeded.json"))
  ) {
    const seeded = readJson(path.join(artifactRoot, "workshop-legacy-seeded.json"));
    assert.equal(doctor.legacyExitCaptureError, undefined, "Candidate Doctor exit capture failed");
    legacy = assertWorkshopLegacyImported(stateDir, seeded, doctor.legacyAtExit);
    assert.deepEqual(
      legacy,
      readJson(path.join(artifactRoot, "workshop-recovered-upgrade.json")).legacy.after,
      "Second candidate Doctor changed imported or recoverable Workshop state",
    );
    assert.deepEqual(
      captureWorkshopLegacyState(stateDir, seeded),
      legacy,
      "Workshop state changed after second Doctor exit",
    );
    legacyWarning = assertWorkshopLegacyWarning(seeded, [
      fs.readFileSync(path.join(artifactRoot, "doctor.log"), "utf8"),
    ]);
  }
  const repair = {
    status: "explicit-doctor-repaired",
    doctor,
    ...(legacy ? { legacy, legacyWarning } : {}),
  };
  writeJson(path.join(artifactRoot, `workshop-${stage}-doctor.json`), repair);
  return repair;
}

export function assertWorkshopRecoveredUpgrade(stateDir, artifactRoot, observations, packageRoot) {
  const baseline = readJson(path.join(artifactRoot, "workshop-baseline.json"));
  const candidate = readJson(path.join(artifactRoot, "workshop-candidate.json"));
  assert.deepEqual(
    installedIdentity(packageRoot),
    candidate,
    "Updater did not install the exact candidate",
  );
  assertRepairedState(stateDir);
  const updater = processWitness(observations, baseline, {
    role: "update",
    exitCode: 0,
    malformedAtStart: false,
  });
  const doctor = processWitness(observations, candidate, {
    role: "doctor",
    exitCode: 0,
    malformedAtStart: false,
    updateInProgress: true,
  });
  const seeded = readJson(path.join(artifactRoot, "workshop-legacy-seeded.json"));
  assert.deepEqual(
    updater.legacyAtStart,
    seeded.before,
    "Published updater did not receive original legacy sidecars",
  );
  assert.deepEqual(
    doctor.legacyAtStart,
    seeded.before,
    "Candidate Doctor did not receive original legacy sidecars",
  );
  assert.equal(doctor.legacyExitCaptureError, undefined, "Candidate Doctor exit capture failed");
  const after = assertWorkshopLegacyImported(stateDir, seeded, doctor.legacyAtExit);
  assert.deepEqual(
    captureWorkshopLegacyState(stateDir, seeded),
    after,
    "Workshop state changed after candidate Doctor exit",
  );
  const warning = assertWorkshopLegacyWarning(seeded, doctor.doctorResultAtExit?.warnings);
  const legacy = { seeded, after, warning };
  const upgraded = { status: "upgraded-after-explicit-repair", updater, doctor, legacy };
  writeJson(path.join(artifactRoot, "workshop-recovered-upgrade.json"), upgraded);
  return upgraded;
}

export function completeWorkshopRecovery(stateDir, artifactRoot) {
  assertRepairedState(stateDir);
  const firstAttempt = readJson(path.join(artifactRoot, "workshop-published-refusal.json"));
  const baselineDoctor = readJson(path.join(artifactRoot, "workshop-baseline-doctor.json"));
  const upgrade = readJson(path.join(artifactRoot, "workshop-recovered-upgrade.json"));
  const candidateDoctor = readJson(path.join(artifactRoot, "workshop-candidate-doctor.json"));
  assert.equal(firstAttempt.status, "refused-before-candidate");
  assert.equal(firstAttempt.automaticRepair, false);
  assert.equal(baselineDoctor.status, "explicit-doctor-repaired");
  assert.equal(upgrade.status, "upgraded-after-explicit-repair");
  assert.equal(candidateDoctor.status, "explicit-doctor-repaired");
  assert.deepEqual(
    candidateDoctor.legacy,
    upgrade.legacy.after,
    "Missing candidate Doctor idempotence evidence for the imported legacy proposals",
  );
  assert.equal(candidateDoctor.legacyWarning.warning, upgrade.legacy.warning.warning);
  const result = { firstAttempt, baselineDoctor, upgrade, candidateDoctor };
  writeJson(path.join(artifactRoot, "workshop-doctor-recovery.json"), result);
  return result;
}

const direct =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (direct) {
  const [mode, first, second, third] = process.argv.slice(2);
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  const artifacts = process.env.OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT;
  assert(stateDir && artifacts, "Missing isolated survivor paths");
  if (mode === "configure") {
    assert(process.env.OPENCLAW_CONFIG_PATH, "Missing isolated config path");
    writeJson(process.env.OPENCLAW_CONFIG_PATH, {
      gateway: {
        mode: "local",
        bind: "loopback",
        auth: { mode: "token", token: "upgrade-survivor-token" },
        controlUi: { enabled: false },
      },
      agents: {
        ownership: "explicit",
        entries: { main: { workspace: path.join(stateDir, "workspace") } },
      },
      plugins: { enabled: false },
    });
  } else if (mode === "baseline") {
    captureWorkshopBaseline(first, artifacts);
  } else if (mode === "candidate") {
    captureWorkshopCandidate(first, artifacts, second);
  } else if (mode === "seed") {
    seedWorkshopIndex(stateDir, artifacts, first);
  } else if (mode === "seed-legacy") {
    seedWorkshopLegacyProposals(stateDir, artifacts);
  } else if (mode === "refusal") {
    assertWorkshopUpdateRefusal(stateDir, artifacts, first, second, Number(third));
  } else if (mode === "doctor") {
    assertWorkshopDoctorRepair(stateDir, artifacts, first, second);
  } else if (mode === "upgrade") {
    assertWorkshopRecoveredUpgrade(stateDir, artifacts, first, second);
  } else if (mode === "complete") {
    completeWorkshopRecovery(stateDir, artifacts);
  } else {
    throw new Error(`Unknown Workshop recovery fixture mode: ${mode}`);
  }
} else {
  observeProcess();
}
