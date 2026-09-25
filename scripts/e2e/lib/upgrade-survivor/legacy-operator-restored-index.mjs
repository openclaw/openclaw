import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  readSqliteTranscriptPayload,
  sqliteTranscriptPayloadColumns,
} from "../../../lib/sqlite-transcript-payload.mjs";

const KEY = "agent:main:upgrade-restored-index";
const SESSION = "upgrade-restored-index-history";
const LABEL = "Renamed after baseline import";
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const writeJson = (file, value) =>
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
const fixturePath = () => {
  assert(process.env.OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT);
  return path.join(
    process.env.OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT,
    "legacy-operator-restored-index.json",
  );
};
const artifact = (name) => path.join(path.dirname(fixturePath()), `restored-index-${name}`);

function fileIdentity(file) {
  const stat = fs.lstatSync(file, { bigint: true });
  assert(stat.isFile() && !stat.isSymbolicLink(), `not a regular fixture file: ${file}`);
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: Number(stat.size),
    mtimeNs: String(stat.mtimeNs),
    sha256: hash(fs.readFileSync(file)),
  };
}

function packageIdentity(manifest, buildInfo) {
  const parsed = JSON.parse(manifest);
  assert.equal(parsed.name, "openclaw");
  JSON.parse(buildInfo);
  return {
    version: parsed.version,
    manifestSha256: hash(manifest),
    buildInfoSha256: hash(buildInfo),
  };
}

function installedIdentity(root) {
  return packageIdentity(
    fs.readFileSync(path.join(root, "package.json")),
    fs.readFileSync(path.join(root, "dist/build-info.json")),
  );
}

function cli(args, name) {
  const result = spawnSync("openclaw", args, {
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
    killSignal: "SIGKILL",
  });
  fs.writeFileSync(artifact(`${name}.out`), result.stdout ?? "");
  fs.writeFileSync(artifact(`${name}.err`), result.stderr ?? "");
  assert.equal(result.status, 0, `${name} failed; see fixture artifacts`);
  const start = result.stdout.search(/^\s*\{/mu);
  assert(start >= 0, `${name} omitted JSON`);
  return JSON.parse(result.stdout.slice(start));
}

function doctor(mode, fixture, name) {
  return cli(
    [
      "doctor",
      "--session-sqlite",
      mode,
      "--session-sqlite-agent",
      "main",
      "--session-sqlite-store",
      fixture.index,
      "--json",
    ],
    name,
  );
}

function sessionState(fixture, stateDir = fixture.stateDir) {
  const database = new DatabaseSync(path.join(stateDir, fixture.databaseRelative), {
    readOnly: true,
  });
  try {
    database.exec("BEGIN");
    const row = database
      .prepare("SELECT current_session_id, entry_json FROM session_nodes WHERE session_key = ?")
      .get(KEY);
    assert(row, "restored-index fixture session is missing");
    const entry = JSON.parse(row.entry_json);
    const events = database
      .prepare(
        `SELECT ${sqliteTranscriptPayloadColumns(database)} FROM transcript_events WHERE session_id = ? ORDER BY seq`,
      )
      .all(SESSION)
      .map((event) => readSqliteTranscriptPayload(event));
    return {
      currentSessionId: row.current_session_id,
      label: entry.label ?? null,
      pinnedAt: entry.pinnedAt ?? null,
      updatedAt: entry.updatedAt ?? null,
      lastActivityAt: entry.lastActivityAt ?? null,
      events,
    };
  } finally {
    database.close();
  }
}

function assertCurrent(fixture, observed) {
  assert.equal(observed.label, LABEL);
  assert(Number.isFinite(observed.pinnedAt) && observed.pinnedAt > 0, "current pin was lost");
  assert.equal(observed.currentSessionId, SESSION);
  assert.deepEqual(
    observed,
    fixture.current,
    "restored index replaced current metadata or history",
  );
}

function seed(baselineRoot, candidateTarball) {
  assert(!fs.existsSync(fixturePath()), "fixture already exists");
  const stateDir = fs.realpathSync(process.env.OPENCLAW_STATE_DIR);
  const directory = path.join(stateDir, "agents/main/sessions");
  const index = path.join(directory, "sessions.json");
  const transcript = path.join(directory, `${SESSION}.jsonl`);
  const baseline = installedIdentity(baselineRoot);
  assert.equal(baseline.version, "2026.9.4");
  const packed = (name) => execFileSync("tar", ["-xOf", candidateTarball, `package/${name}`]);
  const candidate = packageIdentity(packed("package.json"), packed("dist/build-info.json"));
  assert.notEqual(candidate.buildInfoSha256, baseline.buildInfoSha256);
  fs.mkdirSync(directory, { recursive: true });
  // Legacy files are import inputs; the installed baseline produces the database and receipt.
  fs.writeFileSync(
    index,
    JSON.stringify({
      [KEY]: {
        sessionId: SESSION,
        sessionFile: path.basename(transcript),
        label: "Original legacy label",
        channel: "cli",
        chatType: "direct",
        sessionStartedAt: 1710000000000,
        updatedAt: 1710000001000,
      },
    }),
    { mode: 0o600, flag: "wx" },
  );
  fs.writeFileSync(
    transcript,
    [
      { type: "session", id: SESSION, version: 3 },
      {
        type: "message",
        id: "restored-history-1",
        parentId: null,
        message: { role: "user", content: "Retained restored-index history" },
      },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n") + "\n",
    { mode: 0o600, flag: "wx" },
  );
  const fixture = { stateDir, index, transcript, baseline, candidate };
  const report = doctor("import", fixture, "baseline-import");
  const target = report.targets.find((item) => item.storePath === index && item.agentId === "main");
  assert(target && target.importedEntries > 0);
  fixture.databaseRelative = path.relative(stateDir, target.sqlitePath);
  assert(!fixture.databaseRelative.startsWith("..") && !path.isAbsolute(fixture.databaseRelative));
  fixture.manifest = report.migrationRun.manifestPath;
  const manifest = readJson(fixture.manifest);
  assert(manifest.completedAt && manifest.openClawVersion === baseline.version);
  const owner = manifest.targets.find(
    (item) => item.storePath === index && item.sqlitePath === target.sqlitePath,
  );
  assert(owner && owner.validationBeforeArchive === "passed");
  fixture.originals = [index, transcript].map((sourcePath) => {
    const move = owner.completedMoves.find((item) => item.sourcePath === sourcePath);
    assert(move?.artifact && move.artifact.disposal.state === "retained");
    assert(!fs.existsSync(sourcePath), "baseline did not archive original");
    return { sourcePath, archivePath: move.archivePath, identity: fileIdentity(move.archivePath) };
  });
  assert(
    sessionState(fixture).events.some((event) => event.includes("Retained restored-index history")),
  );
  writeJson(fixturePath(), fixture);
}

function patch() {
  const fixture = readJson(fixturePath());
  cli(
    [
      "gateway",
      "call",
      "sessions.patch",
      "--params",
      JSON.stringify({
        key: KEY,
        agentId: "main",
        expectedSessionId: SESSION,
        label: LABEL,
        pinned: true,
      }),
      "--json",
    ],
    "baseline-patch",
  );
  fixture.current = sessionState(fixture);
  assert.equal(fixture.current.label, LABEL);
  assert(Number.isFinite(fixture.current.pinnedAt) && fixture.current.pinnedAt > 0);
  assert.equal(fixture.current.currentSessionId, SESSION);
  writeJson(fixturePath(), fixture);
}

function restore() {
  const fixture = readJson(fixturePath());
  doctor("restore", fixture, "baseline-restore");
  const manifest = readJson(fixture.manifest);
  for (const original of fixture.originals) {
    assert(manifest.restore.restoredFiles.includes(original.sourcePath));
    assert(manifest.restore.consumedArchives.includes(original.archivePath));
    assert.deepEqual(fileIdentity(original.sourcePath), original.identity);
  }
  fixture.receiptIdentity = fileIdentity(fixture.manifest);
  assertCurrent(fixture, sessionState(fixture));
  writeJson(fixturePath(), fixture);
}

function assertArchived(fixture) {
  const directory = path.dirname(fixture.manifest);
  const receipts = fs
    .readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => ({
      file: path.join(directory, name),
      value: readJson(path.join(directory, name)),
    }));
  const match = receipts.find(
    ({ file, value }) =>
      file !== fixture.manifest &&
      value.completedAt &&
      value.openClawVersion === fixture.candidate.version &&
      value.targets.some(
        (target) =>
          target.agentId === "main" &&
          target.storePath === fixture.index &&
          target.sqlitePath === path.join(fixture.stateDir, fixture.databaseRelative) &&
          target.validationBeforeArchive === "passed" &&
          fixture.originals.every((original) =>
            target.completedMoves.some(
              (move) =>
                move.sourcePath === original.sourcePath &&
                fs.existsSync(move.archivePath) &&
                move.artifact?.disposal.state === "retained" &&
                move.artifact.identity.sha256 === original.identity.sha256 &&
                fileIdentity(move.archivePath).sha256 === original.identity.sha256,
            ),
          ),
      ),
  );
  assert(match, "candidate historical import has no verified completed archive receipt");
  for (const original of fixture.originals) {
    assert(!fs.existsSync(original.sourcePath));
  }
  assertCurrent(fixture, sessionState(fixture));
  return match.file;
}

function postUpdate(candidateRoot) {
  const fixture = readJson(fixturePath());
  assert.deepEqual(installedIdentity(candidateRoot), fixture.candidate);
  const current = sessionState(fixture);
  assertCurrent(fixture, current);
  const manifest = assertArchived(fixture);
  writeJson(artifact("post-update.json"), {
    status: "passed",
    baseline: fixture.baseline,
    candidate: fixture.candidate,
    manifest,
    manifestIdentity: fileIdentity(manifest),
    current,
  });
}

function candidateImport(candidateRoot) {
  const fixture = readJson(fixturePath());
  assert.deepEqual(installedIdentity(candidateRoot), fixture.candidate);
  // The shipped updater already imported the originals. Repeat through its supported CLI boundary.
  doctor("import", fixture, "candidate-import");
  assertArchived(fixture);
  writeJson(artifact("candidate-import.json"), {
    status: "passed",
    current: sessionState(fixture),
  });
}

function rollback(proofPath) {
  const fixture = readJson(fixturePath());
  const proof = readJson(proofPath);
  assert.equal(proof.status, "passed");
  assertCurrent(fixture, sessionState(fixture, proof.restoredStateDir));
  for (const file of [
    ...fixture.originals.map((item) => ({ path: item.sourcePath, identity: item.identity })),
    { path: fixture.manifest, identity: fixture.receiptIdentity },
  ]) {
    const relative = path.relative(fixture.stateDir, file.path);
    const omitted = proof.omittedRawTranscripts.find((item) => item.relative === relative);
    if (omitted) {
      assert.equal(file.path, fixture.transcript, "only the raw fixture transcript may be omitted");
      assert.equal(proof.baselineVersion, "2026.9.4");
      assert.equal(omitted.reason, "published-2026.9.4-volatile-transcript");
      assert.equal(omitted.sha256, file.identity.sha256);
      assert.equal(proof.rawTranscriptRestoration, "unsupported-by-published-backup");
      continue;
    }
    const restored = path.join(proof.restoredStateDir, relative);
    assert.equal(fileIdentity(restored).sha256, file.identity.sha256);
  }
  writeJson(artifact("rollback.json"), {
    status: "passed",
    baseline: fixture.baseline,
    rawTranscriptRestoration: proof.rawTranscriptRestoration,
    omittedRawTranscripts: proof.omittedRawTranscripts,
  });
}

const [command, ...args] = process.argv.slice(2);
const actions = {
  seed,
  patch,
  restore,
  "post-update": postUpdate,
  "candidate-import": candidateImport,
  rollback,
};
assert(Object.hasOwn(actions, command), "unknown restored-index fixture action");
actions[command](...args);
