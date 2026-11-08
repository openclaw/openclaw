import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import {
  readSqliteTranscriptPayload,
  sqliteTranscriptPayloadColumns,
  transcriptIdentity,
} from "../../../lib/sqlite-transcript-payload.mjs";
import { hashFile, sqliteFamily } from "./fixture-files.mjs";
import { readDatabase } from "./observations.mjs";
import { readSessionArchiveBytes } from "./session-archive-proof.mjs";

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// Match #141109's shared-state reader without importing stores that can migrate.
function readContentVersion(database, kind, published) {
  if (
    kind !== "state" ||
    !database
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'config_machine_state'")
      .get()
  ) {
    return published;
  }
  const row = database
    .prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?")
    .get("state.schema.contentVersion");
  if (!row) {
    return published;
  }
  const contentVersion = JSON.parse(row.value_json);
  assert(
    Number.isSafeInteger(contentVersion) && contentVersion >= 0,
    "invalid shared state schema content version",
  );
  return Math.max(published, contentVersion);
}

function readSchemas(stateDir) {
  const paths = [{ kind: "state", relative: "state/openclaw.sqlite" }];
  const agentsDir = path.join(stateDir, "agents");
  if (fs.existsSync(agentsDir)) {
    for (const agent of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      if (agent.isDirectory()) {
        const relative = `agents/${agent.name}/agent/openclaw-agent.sqlite`;
        if (fs.existsSync(path.join(stateDir, relative))) {
          paths.push({ kind: "agent", relative });
        }
      }
    }
  }
  return paths
    .toSorted((a, b) => a.relative.localeCompare(b.relative))
    .map((entry) => {
      const databasePath = path.join(stateDir, entry.relative);
      if (!fs.existsSync(databasePath)) {
        return {
          kind: entry.kind,
          relative: entry.relative,
          userVersion: null,
          contentVersion: null,
        };
      }
      // Never import a runtime store: the observer must not perform a migration.
      return readDatabase(databasePath, (database) => {
        const userVersion = database.prepare("PRAGMA user_version").get().user_version;
        return {
          kind: entry.kind,
          relative: entry.relative,
          userVersion,
          contentVersion: readContentVersion(database, entry.kind, userVersion),
        };
      });
    });
}

function hashBytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function databaseFamily(databasePath) {
  return sqliteFamily(databasePath, (file) => {
    const stat = fs.lstatSync(file);
    assert(stat.isFile(), "schema witness requires regular SQLite files");
    return { dev: stat.dev, ino: stat.ino, size: stat.size, sha256: hashFile(file, 1024 * 1024) };
  });
}

function observeDeferredSchema(databasePath) {
  const before = databaseFamily(databasePath);
  // One short snapshot binds header, ownership metadata and content. Close the
  // reader before Doctor so the witness cannot prolong deferred publication.
  const schema = readDatabase(databasePath, (database) => {
    database.exec("BEGIN");
    try {
      const userVersion = database.prepare("PRAGMA user_version").get().user_version;
      const metadata = database
        .prepare("SELECT role, schema_version FROM schema_meta WHERE meta_key = 'primary'")
        .get();
      assert.equal(metadata?.role, "global", "schema witness lacks the shared-state owner");
      return {
        userVersion,
        metadataVersion: metadata.schema_version,
        contentVersion: readContentVersion(database, "state", userVersion),
      };
    } finally {
      database.exec("ROLLBACK");
    }
  });
  const after = databaseFamily(databasePath);
  assert.deepEqual(after.main, before.main, "schema observer changed the primary database");
  return { before, schema, after };
}

function prepareDoctorWitness(snapshotFile, captureFile) {
  const snapshot = readJson(snapshotFile);
  assert.equal(snapshot.baselineVersion, "2026.9.2", "schema witness requires the tagged baseline");
  assert(/^[a-f0-9]{40}$/u.test(snapshot.sourceSha), "schema witness requires the selected source");
  const databasePath = path.join(snapshot.stateDir, "state/openclaw.sqlite");
  const observation = observeDeferredSchema(databasePath);
  const baselinePublishedVersion = snapshot.databases.find(
    (database) => database.relative === "state/openclaw.sqlite",
  )?.userVersion;
  const { userVersion, metadataVersion, contentVersion } = observation.schema;
  // The published 2026.9.2 writer owns header 15; content follows the selected TGZ.
  const status =
    userVersion === 15 &&
    userVersion === baselinePublishedVersion &&
    userVersion === metadataVersion &&
    userVersion < contentVersion &&
    contentVersion === snapshot.candidateSchemaVersions.state
      ? "observed"
      : "not-observed";
  fs.writeFileSync(
    captureFile,
    JSON.stringify({
      status,
      databasePath,
      observation,
      baselinePublishedVersion,
      baselineVersion: snapshot.baselineVersion,
      candidateVersion: snapshot.candidateVersion,
      candidateSha256: snapshot.candidateSha256,
      sourceSha: snapshot.sourceSha,
      expectedContentVersion: snapshot.candidateSchemaVersions.state,
    }) + "\n",
    { mode: 0o600 },
  );
  return status;
}

function assertDoctorWitness(captureFile, exitCode, reportFile, proofFile) {
  const capture = readJson(captureFile);
  const proof = {
    status: capture.status,
    relativePath: "state/openclaw.sqlite",
    baselineVersion: capture.baselineVersion,
    candidateVersion: capture.candidateVersion,
    candidateSha256: capture.candidateSha256,
    sourceSha: capture.sourceSha,
    expectedContentVersion: capture.expectedContentVersion,
    baselinePublishedVersion: capture.baselinePublishedVersion,
    before: capture.observation.schema,
  };
  if (capture.status === "observed") {
    const after = observeDeferredSchema(capture.databasePath);
    // Capture CLI effects before the second observer opens SQLite; observer
    // sidecar changes are reported separately from the joined command's effects.
    fs.writeFileSync(captureFile + ".after", JSON.stringify(after) + "\n", { mode: 0o600 });
    assert.deepEqual(
      after.before.main,
      capture.observation.after.main,
      "Doctor replaced or changed the primary database",
    );
    assert.deepEqual(
      after.schema,
      capture.observation.schema,
      "Doctor changed the deferred schema tuple",
    );
    assert.equal(
      Number(exitCode),
      1,
      "info-level Doctor must return its documented findings status",
    );
    assert(
      fs.statSync(reportFile).size <= 256 * 1024,
      "Doctor schema report exceeds its byte budget",
    );
    let report;
    try {
      report = readJson(reportFile);
    } catch {
      throw new Error("Doctor schema report is not complete JSON");
    }
    assert(
      report.schemaVersion === 1 &&
        report.ok === false &&
        report.checksRun === 1 &&
        Array.isArray(report.findings),
      "Doctor schema report has an unexpected envelope",
    );
    assert(
      report.findings.every(
        (finding) =>
          finding.checkId === "core/doctor/database-engine" && finding.severity === "info",
      ),
      "Doctor reported a non-informational finding",
    );
    const selected = report.findings.filter(
      (finding) =>
        finding.details?.family === "state" &&
        typeof finding.path === "string" &&
        path.resolve(finding.path) === path.resolve(capture.databasePath),
    );
    assert.equal(
      selected.length,
      1,
      "Doctor must report the witnessed state database exactly once",
    );
    const details = selected[0].details;
    assert.equal(
      path.resolve(details.path),
      path.resolve(capture.databasePath),
      "Doctor details identify another database",
    );
    assert.deepEqual(details.issues, [], "Doctor did not admit the state store");
    assert.equal(
      details.schema.version,
      capture.expectedContentVersion,
      "Doctor reported the raw header instead of content",
    );
    assert.equal(
      details.schema.expectedVersion,
      capture.expectedContentVersion,
      "Doctor expected another candidate schema",
    );
    assert.equal(details.schema.pending, 0, "Doctor reported pending state migrations");
    Object.assign(proof, {
      status: "passed",
      after: after.schema,
      doctorExitCode: Number(exitCode),
      diagnosticVersion: details.schema.version,
      pendingMigrations: details.schema.pending,
      sameDatabase: true,
      beforeObserverFamilyUnchanged: isDeepStrictEqual(
        capture.observation.before,
        capture.observation.after,
      ),
      cliFamilyUnchanged: isDeepStrictEqual(capture.observation.after, after.before),
      afterObserverFamilyUnchanged: isDeepStrictEqual(after.before, after.after),
    });
  } else {
    assert.equal(capture.status, "not-observed", "invalid schema observation status");
  }
  fs.writeFileSync(proofFile, JSON.stringify(proof) + "\n", { mode: 0o600 });
  return proof.status;
}

function sessionIdentities(index) {
  return Object.entries(index)
    .map(([sessionKey, entry]) => {
      assert(typeof entry.sessionId === "string", `legacy session id missing: ${sessionKey}`);
      return { sessionKey, sessionId: entry.sessionId };
    })
    .toSorted((a, b) => a.sessionKey.localeCompare(b.sessionKey));
}

function readSeededAgents(stateDir, configFile, artifactRoot) {
  const config = readJson(configFile);
  const entries =
    config.agents?.entries ??
    Object.fromEntries((config.agents?.list ?? []).map((entry) => [entry.id, entry]));
  const agentIds = Object.keys(entries).toSorted();
  const nativeEligibility = path.join(artifactRoot, "native-assignment-eligibility.json");
  const expectedAgentIds =
    fs.existsSync(nativeEligibility) && readJson(nativeEligibility).status === "required"
      ? ["main", "native-proof", "ops"]
      : ["main", "ops"];
  assert.deepEqual(agentIds, expectedAgentIds, "legacy operator seeded agent roster changed");
  return agentIds.map((agentId) => {
    const agentRoot = path.join(stateDir, "agents", agentId);
    if (entries[agentId].agentDir) {
      assert.equal(path.resolve(entries[agentId].agentDir), path.join(agentRoot, "agent"));
    }
    const files = [];
    function visitSessions(directory) {
      if (!fs.existsSync(directory)) {
        return;
      }
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          visitSessions(absolute);
          continue;
        }
        assert(entry.isFile(), `non-file baseline agent specimen: ${absolute}`);
        const local = path.relative(agentRoot, absolute).split(path.sep).join("/");
        const relative = path.relative(stateDir, absolute).split(path.sep).join("/");
        const bytes = fs.readFileSync(absolute);
        const specimen = { relative, sha256: hashBytes(bytes) };
        if (local === "sessions/sessions.json") {
          files.push({
            ...specimen,
            kind: "legacy-store",
            sessions: sessionIdentities(JSON.parse(bytes.toString("utf8"))),
          });
        } else if (/^sessions\/[^/]+\.trajectory(?:\.jsonl|-path\.json)$/u.test(local)) {
          files.push({ ...specimen, kind: "trajectory" });
        } else if (/^sessions\/[^/]+\.jsonl$/u.test(local)) {
          const events = bytes
            .toString("utf8")
            .split(/\r?\n/u)
            .filter((line) => line.trim())
            .map((line) => JSON.parse(line));
          const sessionId = events.find((event) => event.type === "session")?.id;
          assert(typeof sessionId === "string", `legacy transcript header missing: ${relative}`);
          files.push({
            ...specimen,
            kind: "transcript",
            sessionId,
            events: events.map(transcriptIdentity),
          });
        } else if (
          /^sessions\/skills-prompts\/sha256\/[a-f0-9]{2}\/[a-f0-9]{64}\.txt$/u.test(local)
        ) {
          // skill-prompt-blobs.ts retains content-addressed source artifacts during Doctor import.
          files.push({ ...specimen, kind: "skill-prompt" });
        } else {
          throw new Error(`unclassified baseline agent specimen: ${relative}`);
        }
      }
    }
    visitSessions(path.join(agentRoot, "sessions"));
    // Model catalogs and other per-agent artifacts have separate owners.
    const runtimeDir = path.join(agentRoot, "agent");
    if (fs.existsSync(runtimeDir)) {
      for (const entry of fs.readdirSync(runtimeDir, { withFileTypes: true })) {
        // WAL, shared memory, and reindex scratch belong to the existing SQLite owner.
        if (!entry.name.startsWith("openclaw-agent.sqlite")) {
          continue;
        }
        assert(entry.isFile(), `non-file baseline SQLite specimen: ${entry.name}`);
        files.push({ relative: `agents/${agentId}/agent/${entry.name}`, kind: "sqlite-runtime" });
      }
    }
    const databaseRelative = `agents/${agentId}/agent/openclaw-agent.sqlite`;
    return {
      agentId,
      databaseRelative,
      requiresDatabase:
        fs.existsSync(path.join(stateDir, databaseRelative)) ||
        files.some((file) => file.sessions?.length > 0 || file.events?.length > 0),
      files: files.toSorted((a, b) => a.relative.localeCompare(b.relative)),
    };
  });
}

function assertSeededAgents(snapshot) {
  const manifestDir = path.join(snapshot.stateDir, "session-sqlite-migration-runs");
  const targets = fs.existsSync(manifestDir)
    ? fs
        .readdirSync(manifestDir)
        .filter((name) => name.endsWith(".json"))
        .flatMap((name) => {
          const manifest = readJson(path.join(manifestDir, name));
          if (!manifest.completedAt || manifest.failedAt) {
            return [];
          }
          const consumed = manifest.restore?.consumedArchives ?? [];
          for (const target of manifest.targets) {
            target.completedMoves = target.completedMoves.filter(
              (move) => !consumed.includes(move.archivePath),
            );
          }
          return manifest.targets;
        })
    : [];
  for (const agent of snapshot.agents) {
    const databasePath = path.join(snapshot.stateDir, agent.databaseRelative);
    assert(
      !agent.requiresDatabase || fs.existsSync(databasePath),
      `required agent database missing before candidate probes: ${agent.agentId}`,
    );
    const database = agent.requiresDatabase
      ? new DatabaseSync(databasePath, { readOnly: true })
      : null;
    try {
      if (database) {
        assert.equal(
          database.prepare("PRAGMA user_version").get().user_version,
          snapshot.candidateSchemaVersions.agent,
          `required agent database lacks candidate schema: ${agent.agentId}`,
        );
      }
      for (const file of agent.files) {
        if (file.kind === "sqlite-runtime") {
          continue;
        }
        const source = path.join(snapshot.stateDir, file.relative);
        if (file.kind === "skill-prompt") {
          assert(fs.existsSync(source), `legacy skill prompt missing: ${file.relative}`);
          assert.equal(
            hashBytes(fs.readFileSync(source)),
            file.sha256,
            `legacy skill prompt changed: ${file.relative}`,
          );
          continue;
        }
        // doctor-session-sqlite.ts moves verified originals; recovery manifests own their destinations.
        assert(!fs.existsSync(source), `legacy agent specimen was not retired: ${file.relative}`);
        const move = targets
          .filter(
            (target) =>
              target.agentId === agent.agentId &&
              target.sqlitePath === databasePath &&
              target.validationBeforeArchive === "passed",
          )
          .flatMap((target) => target.completedMoves)
          .find((item) => item.sourcePath === source && item.kind === file.kind);
        assert(move, `legacy agent specimen lacks completed archive receipt: ${file.relative}`);
        const archiveRoot = path.join(
          snapshot.stateDir,
          "agents",
          agent.agentId,
          "session-sqlite-import-archive",
        );
        assert.equal(
          path.dirname(move.archivePath),
          archiveRoot,
          "agent archive escaped its owner",
        );
        const archiveBytes = readSessionArchiveBytes(move);
        if (file.kind === "legacy-store") {
          // Earlier Doctor passes may normalize the entry, but keys and session identities must survive.
          assert.deepEqual(
            sessionIdentities(JSON.parse(archiveBytes.toString("utf8"))),
            file.sessions,
            `legacy session index identities changed: ${file.relative}`,
          );
          for (const session of file.sessions) {
            const row = database
              .prepare("SELECT current_session_id FROM session_nodes WHERE session_key = ?")
              .get(session.sessionKey);
            assert.equal(
              row?.current_session_id,
              session.sessionId,
              `legacy session was not imported: ${session.sessionKey}`,
            );
          }
        } else {
          assert.equal(
            hashBytes(archiveBytes),
            file.sha256,
            `legacy agent archive changed: ${file.relative}`,
          );
          if (file.kind === "transcript") {
            const events = database
              .prepare(
                `SELECT ${sqliteTranscriptPayloadColumns(database)} FROM transcript_events WHERE session_id = ? ORDER BY seq`,
              )
              .all(file.sessionId)
              .map((row) => transcriptIdentity(JSON.parse(readSqliteTranscriptPayload(row))));
            for (const expected of file.events) {
              assert.deepEqual(
                events.find((event) => event.id === expected.id && event.type === expected.type),
                expected,
                `legacy transcript event was not imported: ${file.relative} (${expected.id})`,
              );
            }
          }
        }
      }
    } finally {
      database?.close();
    }
    console.error(
      `Agent migration verified before candidate probes: ${agent.agentId} (${agent.requiresDatabase ? "candidate store required" : "no legacy state; store may remain lazy"}).`,
    );
  }
}

function prepare(baselineVersion, candidateTarball, stateDir, snapshotFile, configFile) {
  const manifest = JSON.parse(
    execFileSync("tar", ["-xOf", candidateTarball.replace(/^file:/u, ""), "package/package.json"], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    }),
  );
  assert.equal(manifest.name, "openclaw", "candidate is not an OpenClaw package");
  for (const kind of ["state", "agent"]) {
    assert(
      Number.isInteger(manifest.openclaw?.schemaVersions?.[kind]) &&
        manifest.openclaw.schemaVersions[kind] >= 0,
      `candidate package is missing its ${kind} schema version`,
    );
  }
  const snapshot = {
    baselineVersion,
    candidateVersion: manifest.version,
    candidateSchemaVersions: manifest.openclaw.schemaVersions,
    candidateSha256: hashFile(candidateTarball.replace(/^file:/u, ""), 1024 * 1024),
    sourceSha: process.env.OPENCLAW_DOCKER_E2E_SELECTED_SHA ?? null,
    stateDir,
    databases: readSchemas(stateDir),
    agents: readSeededAgents(stateDir, configFile, path.dirname(snapshotFile)),
  };
  fs.writeFileSync(snapshotFile, `${JSON.stringify(snapshot, null, 2)}\n`);
  return "success";
}

function assertOutcome(snapshotFile, exitCode, installedVersion, acceptedOutcome, afterFile) {
  const snapshot = readJson(snapshotFile);
  // The updater result classifier owns post-core warnings; they can exit 1
  // after installing the candidate and completing its schema migrations.
  assert(
    acceptedOutcome === "success" || acceptedOutcome === "recoverable",
    "update outcome was not accepted by the updater result checks",
  );
  assert(
    Number(exitCode) === 0 || (acceptedOutcome === "recoverable" && Number(exitCode) === 1),
    "baseline requires a successful or validated recoverable update",
  );
  assert.equal(installedVersion, snapshot.candidateVersion, "candidate package is not installed");
  const databases = readSchemas(snapshot.stateDir);
  fs.writeFileSync(afterFile, `${JSON.stringify({ ...snapshot, databases }, null, 2)}\n`);
  assertSeededAgents(snapshot);
  const currentPaths = new Set(databases.map((database) => database.relative));
  for (const database of snapshot.databases) {
    if (database.userVersion !== null) {
      assert(
        currentPaths.has(database.relative),
        `baseline database missing after update: ${database.relative}`,
      );
    }
  }
  for (const database of databases) {
    assert.equal(
      database.contentVersion,
      snapshot.candidateSchemaVersions[database.kind],
      `${database.relative} does not have the candidate schema`,
    );
  }
  return "success";
}

const [command, ...args] = process.argv.slice(2);
try {
  assert(
    (command === "prepare" && args.length === 5) ||
      (command === "assert" && args.length === 5) ||
      (command === "doctor-before" && args.length === 2) ||
      (command === "doctor-after" && args.length === 4),
    "usage: schema-expectation.mjs prepare <baseline-version> <candidate.tgz> <state-dir> <snapshot.json> <config.json> | assert <snapshot.json> <exit-code> <installed-version> <accepted-outcome> <after.json> | doctor-before <snapshot.json> <capture.json> | doctor-after <capture.json> <exit-code> <report.json> <proof.json>",
  );
  const action = {
    prepare,
    assert: assertOutcome,
    "doctor-before": prepareDoctorWitness,
    "doctor-after": assertDoctorWitness,
  }[command];
  process.stdout.write(`${action(...args)}\n`);
} catch (error) {
  // Assertion diffs and filesystem errors can contain private paths and inode IDs.
  const message =
    command === "doctor-before" || command === "doctor-after"
      ? "deferred-schema Doctor witness refused; inspect private run evidence"
      : error.message;
  process.stderr.write(`Schema expectation failed: ${message}\n`);
  process.exitCode = 1;
}
