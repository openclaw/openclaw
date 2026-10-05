import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const WINDOW_MS = 5 * 60_000;
const STOPPED_REASON = "gateway.tailscale_backend_stopped";
const BREAKER_REASON = "gateway.crash_loop_breaker";
const RECOVERED_REASON = "gateway.crash_loop_recovered";
const FIXTURE_PREFIX = "upgrade-survivor-gateway-boot-";

function requireEnv(name) {
  const value = process.env[name];
  assert(value, `${name} is required`);
  return value;
}

function fixturePath() {
  return path.join(
    requireEnv("OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT"),
    "gateway-boot-lifecycle-fixture.json",
  );
}

function proofPath() {
  return path.join(
    requireEnv("OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT"),
    "gateway-boot-lifecycle-proof.json",
  );
}

function sourceDatabasePath() {
  return path.join(requireEnv("OPENCLAW_STATE_DIR"), "state", "openclaw.sqlite");
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function assertLogIncludes(log, message, error) {
  assert(log.includes(message), error);
}

function readRows(databasePath, bootIds) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const read = database.prepare(
      "SELECT boot_id, pid, started_at_ms, completed_at_ms, outcome, startup_reason, reason FROM gateway_boot_lifecycle WHERE boot_id = ?",
    );
    return bootIds.map((bootId) => {
      const row = read.get(bootId);
      assert(row, `Missing Gateway boot lifecycle row: ${bootId}`);
      return Object.assign({}, row);
    });
  } finally {
    database.close();
  }
}

function assertRows(databasePath, expected, label) {
  assert.deepEqual(
    readRows(
      databasePath,
      expected.map((row) => row.boot_id),
    ),
    expected,
    `${label} changed copied preexisting Gateway boot history`,
  );
}

function insertRows(databasePath, rows) {
  const database = new DatabaseSync(databasePath);
  try {
    assert(
      database
        .prepare(
          "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'gateway_boot_lifecycle'",
        )
        .get(),
      "Published baseline did not create the Gateway boot lifecycle owner",
    );
    database.exec("BEGIN IMMEDIATE");
    const insert = database.prepare(
      "INSERT INTO gateway_boot_lifecycle (boot_id, pid, started_at_ms, completed_at_ms, outcome, startup_reason, reason) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    for (const row of rows) {
      insert.run(
        row.boot_id,
        row.pid,
        row.started_at_ms,
        row.completed_at_ms,
        row.outcome,
        row.startup_reason,
        row.reason,
      );
    }
    database.exec("COMMIT");
  } catch (error) {
    if (database.isTransaction) {
      database.exec("ROLLBACK");
    }
    throw error;
  } finally {
    database.close();
  }
}

function seed() {
  const databasePath = sourceDatabasePath();
  const seededAtMs = Date.now();
  const rows = [
    {
      boot_id: `${FIXTURE_PREFIX}breaker-marker`,
      pid: 4242,
      started_at_ms: seededAtMs - WINDOW_MS - 1,
      completed_at_ms: null,
      outcome: null,
      startup_reason: BREAKER_REASON,
      reason: null,
    },
    ...Array.from({ length: 3 }, (_, index) => ({
      boot_id: `${FIXTURE_PREFIX}expired-unknown-${index + 1}`,
      pid: 4242,
      started_at_ms: seededAtMs - WINDOW_MS - 10_000 - index,
      completed_at_ms: seededAtMs - WINDOW_MS - 1 - index,
      outcome: "startup_failed",
      startup_reason: null,
      reason: "Synthetic genuine startup failure outside the breaker window",
    })),
    ...Array.from({ length: 3 }, (_, index) => ({
      boot_id: `${FIXTURE_PREFIX}completed-stopped-${index + 1}`,
      pid: 4242,
      started_at_ms: seededAtMs - 2_000 + index,
      completed_at_ms: seededAtMs - 1_000 + index,
      outcome: "startup_failed",
      startup_reason: STOPPED_REASON,
      reason: "Tailscale is stopped",
    })),
  ];
  insertRows(databasePath, rows);
  writeJson(fixturePath(), {
    version: 1,
    windowMs: WINDOW_MS,
    seededAtMs,
    sourceDatabasePath: fs.realpathSync(databasePath),
    rows,
  });
  process.stdout.write(`Seeded ${rows.length} preexisting Gateway boot lifecycle rows.\n`);
}

function inspectRecoveryRows(databasePath, fixture) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database
      .prepare(
        "SELECT boot_id, started_at_ms, completed_at_ms, outcome, startup_reason FROM gateway_boot_lifecycle WHERE startup_reason = ? AND started_at_ms >= ? ORDER BY started_at_ms",
      )
      .all(RECOVERED_REASON, fixture.candidateBoundaryMs)
      .map((row) => Object.assign({}, row));
  } finally {
    database.close();
  }
}

function writeCanaryPlugin(root) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  writeJson(path.join(root, "package.json"), {
    name: "@openclaw/gateway-boot-lifecycle-canary",
    version: "0.0.0",
    main: "index.cjs",
    openclaw: { extensions: ["./index.cjs"] },
  });
  writeJson(path.join(root, "openclaw.plugin.json"), {
    id: "gateway-boot-lifecycle-canary",
    activation: { onStartup: true },
    configSchema: { type: "object", additionalProperties: false, properties: {} },
  });
  const fixtureFile = fixturePath();
  const receiptFile = path.join(
    requireEnv("OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT"),
    "gateway-boot-lifecycle-canary.json",
  );
  fs.rmSync(receiptFile, { force: true });
  fs.writeFileSync(
    path.join(root, "index.cjs"),
    `const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const fixtureFile = ${JSON.stringify(fixtureFile)};
const receiptFile = ${JSON.stringify(receiptFile)};
const windowMs = ${WINDOW_MS};
const stoppedReason = ${JSON.stringify(STOPPED_REASON)};
const recoveredReason = ${JSON.stringify(RECOVERED_REASON)};

function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function installedIdentity() {
  let root = path.dirname(fs.realpathSync(process.argv[1]));
  for (let depth = 0; depth < 5; depth += 1, root = path.dirname(root)) {
    const manifestPath = path.join(root, "package.json");
    const buildPath = path.join(root, "dist", "build-info.json");
    if (!fs.existsSync(manifestPath) || !fs.existsSync(buildPath)) continue;
    const manifest = readJson(manifestPath);
    if (manifest.name !== "openclaw") continue;
    const build = readJson(buildPath);
    assert.equal(build.version, manifest.version);
    return { version: manifest.version, commit: build.commit };
  }
  throw new Error("Could not resolve the candidate canary package identity");
}
function observeCopiedState() {
  if (!process.argv.includes("--update-canary")) return;
  const fixture = readJson(fixtureFile);
  const databasePath = path.join(process.env.OPENCLAW_STATE_DIR || "", "state", "openclaw.sqlite");
  const receipt = { status: "admitting", identity: installedIdentity(), observedAtMs: Date.now() };
  try {
    assert.notEqual(fs.realpathSync(databasePath), fixture.sourceDatabasePath, "Candidate canary did not use copied state");
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const read = database.prepare("SELECT boot_id, pid, started_at_ms, completed_at_ms, outcome, startup_reason, reason FROM gateway_boot_lifecycle WHERE boot_id = ?");
      const rows = fixture.rows.map((expected) => Object.assign({}, read.get(expected.boot_id)));
      assert.deepEqual(rows, fixture.rows, "Candidate canary input changed copied preexisting Gateway boot history");
      const completedStopped = fixture.rows.filter((row) => row.startup_reason === stoppedReason);
      assert(completedStopped.every((row) => receipt.observedAtMs >= row.completed_at_ms && receipt.observedAtMs - row.completed_at_ms < windowMs), "Completed stopped-daemon rows expired before candidate canary admission");
      const recovery = database.prepare("SELECT boot_id FROM gateway_boot_lifecycle WHERE startup_reason = ? AND started_at_ms >= ? ORDER BY started_at_ms").all(recoveredReason, fixture.candidateBoundaryMs);
      assert(recovery.length > 0, "Candidate canary did not record copied-history recovery");
      receipt.copiedRows = rows.length;
      receipt.recoveryRows = recovery.length;
    } finally {
      database.close();
    }
  } catch (error) {
    receipt.error = String(error);
  }
  fs.writeFileSync(receiptFile, JSON.stringify({ ...receipt, status: receipt.error ? "failed" : "admitted" }, null, 2) + "\\n", { mode: 0o600 });
}
module.exports = { id: "gateway-boot-lifecycle-canary", name: "Gateway Boot Lifecycle Canary", register() { observeCopiedState(); } };
`,
    { mode: 0o600 },
  );
}

function captureCandidateBoundary(gatewayLog) {
  const fixture = readJson(fixturePath());
  assertRows(sourceDatabasePath(), fixture.rows, "Published baseline");
  writeJson(fixturePath(), {
    ...fixture,
    candidateBoundaryMs: Date.now(),
    candidateLogOffset: fs.statSync(gatewayLog).size,
  });
}

function canaryReceipts(artifacts) {
  const receipt = path.join(artifacts, "gateway-boot-lifecycle-canary.json");
  return fs.existsSync(receipt) ? [readJson(receipt)] : [];
}

function assertRecovery(gatewayLog, updateResult) {
  const artifacts = requireEnv("OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT");
  const fixture = readJson(fixturePath());
  assertRows(sourceDatabasePath(), fixture.rows, "Activated candidate");
  const receipts = canaryReceipts(artifacts);
  assert.equal(receipts.length, 1, "Expected one candidate canary lifecycle receipt");
  const canary = receipts[0];
  assert.equal(canary.status, "admitted", canary.error ?? "Candidate canary admission failed");
  assert(
    canary.observedAtMs >= fixture.candidateBoundaryMs,
    "Candidate canary receipt predates this update",
  );
  assert.equal(canary.copiedRows, fixture.rows.length, "Candidate canary did not admit every row");
  assert(canary.recoveryRows > 0, "Candidate canary did not recover copied history");
  assert.equal(
    canary.identity.commit,
    requireEnv("OPENCLAW_DOCKER_E2E_SELECTED_SHA"),
    "Copied-state canary did not run the selected candidate",
  );
  const candidateStartup = readJson(updateResult).steps?.find(
    (step) => step.name === "candidate-gateway-startup",
  );
  assert(candidateStartup, "Published updater did not report candidate Gateway startup");
  assert.equal(candidateStartup.exitCode, 0, "Candidate Gateway startup did not pass");
  const recoveryRows = inspectRecoveryRows(sourceDatabasePath(), fixture);
  assert(recoveryRows.length > 0, "Activated candidate did not record candidate-era recovery");
  const log = fs.readFileSync(gatewayLog, "utf8").slice(fixture.candidateLogOffset);
  assertLogIncludes(
    log,
    "[gateway] restart-loop breaker recovered; channel auto-start restored",
    "Activated candidate did not report channel autostart recovery",
  );
  writeJson(proofPath(), {
    status: "recovered",
    windowMs: WINDOW_MS,
    baselineVersion: process.env.OPENCLAW_UPGRADE_SURVIVOR_BASELINE_VERSION,
    candidate: canary.identity,
    copiedHistory: {
      seededRows: fixture.rows.length,
      rowsPresentAtCanaryAdmission: true,
      candidateStartupPassed: true,
      completedStoppedFailuresInsideWindow: 3,
      expiredUnknownFailures: 3,
      recoveryRecorded: true,
    },
    activatedHistory: {
      sourceRowsRetained: true,
      recoveryRecorded: true,
      channelAutostartRestored: true,
    },
  });
}

function seedGenuineFailures() {
  const fixture = readJson(fixturePath());
  const seededAtMs = Date.now();
  const insideWindowAtMs = seededAtMs - 4 * 60_000 - 5_000;
  const rows = [
    {
      boot_id: `${FIXTURE_PREFIX}recent-completed-unknown`,
      pid: 4343,
      started_at_ms: insideWindowAtMs - 100,
      completed_at_ms: insideWindowAtMs,
      outcome: "startup_failed",
      startup_reason: null,
      reason: "Synthetic recent genuine startup failure",
    },
    {
      boot_id: `${FIXTURE_PREFIX}recent-open-unknown`,
      pid: 4343,
      started_at_ms: insideWindowAtMs + 10,
      completed_at_ms: null,
      outcome: null,
      startup_reason: null,
      reason: null,
    },
    {
      boot_id: `${FIXTURE_PREFIX}recent-open-stopped`,
      pid: 4343,
      started_at_ms: insideWindowAtMs + 20,
      completed_at_ms: null,
      outcome: null,
      startup_reason: STOPPED_REASON,
      reason: null,
    },
  ];
  insertRows(sourceDatabasePath(), rows);
  writeJson(fixturePath(), {
    ...fixture,
    genuineSeededAtMs: seededAtMs,
    genuineRows: rows,
  });
}

function assertSuppressed(gatewayLog) {
  const fixture = readJson(fixturePath());
  assertRows(sourceDatabasePath(), fixture.rows, "Suppressed candidate");
  assertRows(sourceDatabasePath(), fixture.genuineRows, "Genuine crash fixture");
  assert(
    fixture.genuineRows.every((row) => {
      const observedAtMs = row.completed_at_ms ?? row.started_at_ms;
      const ageMs = Date.now() - observedAtMs;
      return ageMs >= 4 * 60_000 && ageMs < WINDOW_MS;
    }),
    "Genuine crash fixture did not remain between four and five minutes old",
  );
  // The managed start owner snapshots the prior log and truncates this path before launching.
  const log = fs.readFileSync(gatewayLog, "utf8");
  assertLogIncludes(
    log,
    "[gateway] restart-loop breaker tripped: 3 unclean boot(s)",
    "Candidate did not count the recent genuine/open startup failures",
  );
  assertLogIncludes(
    log,
    "suppressing channel/provider account auto-start",
    "Candidate did not preserve channel autostart suppression for genuine failures",
  );
  const database = new DatabaseSync(sourceDatabasePath(), { readOnly: true });
  let breakerRows;
  try {
    breakerRows = database
      .prepare(
        "SELECT boot_id, started_at_ms FROM gateway_boot_lifecycle WHERE startup_reason = ? AND started_at_ms >= ? ORDER BY started_at_ms",
      )
      .all(BREAKER_REASON, fixture.genuineSeededAtMs)
      .map((row) => Object.assign({}, row));
  } finally {
    database.close();
  }
  assert(breakerRows.length > 0, "Suppressed candidate did not persist its breaker transition");
  const proof = readJson(proofPath());
  writeJson(proofPath(), {
    ...proof,
    status: "passed",
    genuineCrashProtection: {
      recentFailures: 3,
      failuresOlderThanFourMinutes: true,
      completedUnknownCounted: true,
      openUnknownCounted: true,
      openStoppedCounted: true,
      breakerRecorded: true,
      channelAutostartSuppressed: true,
      allSeededRowsRetained: true,
    },
  });
  process.stdout.write(`GATEWAY_BOOT_LIFECYCLE_PROOF ${JSON.stringify(readJson(proofPath()))}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [command, ...args] = process.argv.slice(2);
  if (command === "seed") {
    seed();
  } else if (command === "write-canary-plugin") {
    writeCanaryPlugin(...args);
  } else if (command === "capture-candidate-boundary") {
    captureCandidateBoundary(...args);
  } else if (command === "assert-recovery") {
    assertRecovery(...args);
  } else if (command === "seed-genuine") {
    seedGenuineFailures(...args);
  } else if (command === "assert-suppressed") {
    assertSuppressed(...args);
  } else {
    throw new Error(`Unknown Gateway boot lifecycle survivor command: ${command ?? "<missing>"}`);
  }
}
