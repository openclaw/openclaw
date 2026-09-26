import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { compareReleaseVersions } from "../../../lib/release-version.mjs";
import {
  readSqliteTranscriptPayload,
  sqliteTranscriptPayloadColumns,
  transcriptIdentity,
} from "../../../lib/sqlite-transcript-payload.mjs";

const RESTORED_TRANSCRIPT = "agents/main/sessions/upgrade-restored-index-history.jsonl";
const MINIMUM_BASELINE = "2026.9.4";
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const writeJson = (file, value) =>
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
const quoteIdentifier = (value) => `"${value.replaceAll('"', '""')}"`;
const compareSessionKeys = (left, right) =>
  left.key < right.key ? -1 : left.key > right.key ? 1 : 0;

function hashFile(file) {
  const hash = createHash("sha256");
  const descriptor = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let size;
    while ((size = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, size));
    }
    return hash.digest("hex");
  } finally {
    fs.closeSync(descriptor);
  }
}

function containedPath(root, relative) {
  assert(typeof relative === "string" && relative.length > 0, "missing inventory path");
  assert(!path.isAbsolute(relative), `absolute inventory path: ${relative}`);
  const result = path.resolve(fs.realpathSync(root), relative);
  const within = (candidate) => {
    const suffix = path.relative(fs.realpathSync(root), candidate);
    return (
      suffix && suffix !== ".." && !suffix.startsWith(`..${path.sep}`) && !path.isAbsolute(suffix)
    );
  };
  assert(within(result), `inventory path escaped its root: ${relative}`);
  if (fs.existsSync(result)) {
    assert(within(fs.realpathSync(result)), `inventory link escaped its root: ${relative}`);
  }
  return result;
}

function tableInventory(database, table) {
  const statement = database.prepare(`SELECT * FROM ${quoteIdentifier(table)}`);
  statement.setReadBigInts(true);
  const columns = statement.columns().map((column) => column.name);
  const rows = statement.all().map((row) =>
    JSON.stringify(
      columns.map((column) => row[column]),
      (_key, value) => {
        if (typeof value === "bigint") {
          return { integer: value.toString() };
        }
        if (value instanceof Uint8Array) {
          return { blob: Buffer.from(value).toString("base64") };
        }
        return value;
      },
    ),
  );
  // Sort serialized rows, including their IDs and payloads, independently of
  // SQLite's physical layout and backup VACUUM page order.
  rows.sort();
  const hash = createHash("sha256");
  for (const row of rows) {
    hash.update(`${row}\n`);
  }
  return { table, columns, rows: rows.length, sha256: hash.digest("hex") };
}

function databaseInventory(stateDir, specimen) {
  const file = containedPath(stateDir, specimen.relative);
  if (!fs.existsSync(file)) {
    return { ...specimen, present: false };
  }
  // This observer cannot initialize or migrate the database it is measuring.
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    database.exec("BEGIN");
    const userVersion = database.prepare("PRAGMA user_version").get().user_version;
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => row.name);
    const metadata = tables.includes("schema_meta")
      ? database
          .prepare("SELECT role, schema_version, agent_id FROM schema_meta ORDER BY meta_key")
          .all()
          .map((row) => Object.assign({}, row))
      : [];
    let contentVersion = userVersion;
    if (specimen.kind === "state" && tables.includes("config_machine_state")) {
      const row = database
        .prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?")
        .get("state.schema.contentVersion");
      if (row) {
        contentVersion = Math.max(userVersion, JSON.parse(row.value_json));
      }
    }
    const logicalTables =
      specimen.kind === "agent"
        ? tables.filter(
            (table) =>
              table.startsWith("session_") ||
              table.startsWith("transcript_") ||
              [
                "conversations",
                "conversation_deliveries",
                "trajectory_runtime_events",
                "acp_parent_stream_events",
              ].includes(table),
          )
        : [];
    const sessions =
      specimen.kind === "agent" && tables.includes("session_nodes")
        ? database
            .prepare(
              "SELECT session_key AS key, json_extract(entry_json, '$.sessionId') AS sessionId FROM session_nodes WHERE json_type(entry_json, '$.sessionId') = 'text' ORDER BY session_key",
            )
            .all()
            // Published session listing excludes hidden internal-effects rows
            // and retained windows whose entry no longer has a session ID.
            .filter((row) => !/^agent:[^:]+:internal-session-effects:/u.test(row.key))
            .map((row) => ({ key: row.key, sessionId: row.sessionId }))
            .toSorted(compareSessionKeys)
        : [];
    return {
      ...specimen,
      present: true,
      userVersion,
      contentVersion,
      metadata,
      sessions,
      tables: logicalTables.map((table) => tableInventory(database, table)),
    };
  } finally {
    database.close();
  }
}

function inventory(stateDir, specimens, files) {
  return {
    databases: specimens.map((specimen) => databaseInventory(stateDir, specimen)),
    files: files.map((file) => ({
      ...file,
      sha256: hashFile(containedPath(stateDir, file.relative)),
    })),
  };
}

function canonicalRestoredTranscript(schema, runtime) {
  const agent = schema.agents.find((item) => item.agentId === "main");
  const file = agent?.files.find((item) => item.relative === RESTORED_TRANSCRIPT);
  if (!file) {
    return null;
  }
  assert.equal(runtime.version, "2026.9.4", "unqualified volatile transcript baseline");
  assert.equal(file.kind, "transcript", "unqualified volatile transcript kind");
  const events = fs
    .readFileSync(containedPath(schema.stateDir, file.relative), "utf8")
    .split(/\r?\n/u)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
  const sessionId = "upgrade-restored-index-history";
  assert.equal(events[0]?.type, "session", "volatile transcript header missing");
  assert.equal(events[0].id, sessionId, "volatile transcript session changed");
  assert(
    events.length > 1 &&
      events
        .slice(1)
        .every((event) => event.type === "message" && typeof event.message?.content === "string"),
    "volatile omission requires the text-only restored-index fixture",
  );
  const database = new DatabaseSync(containedPath(schema.stateDir, agent.databaseRelative), {
    readOnly: true,
  });
  try {
    const canonical = database
      .prepare(
        `SELECT ${sqliteTranscriptPayloadColumns(database)} FROM transcript_events WHERE session_id = ? ORDER BY seq`,
      )
      .all(sessionId)
      .map((row) => transcriptIdentity(JSON.parse(readSqliteTranscriptPayload(row))));
    assert.deepEqual(
      canonical,
      events.map(transcriptIdentity),
      "volatile transcript lacks exact canonical history before backup",
    );
    return {
      relative: file.relative,
      kind: file.kind,
      sha256: file.sha256,
      sessionId,
      canonicalEventCount: canonical.length,
    };
  } finally {
    database.close();
  }
}

function archiveMembers(archive) {
  return new Set(
    execFileSync("tar", ["-tzf", archive], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
      .split("\n")
      .filter(Boolean)
      .map((member) => member.replace(/^\.\//u, "").replace(/\/$/u, "")),
  );
}

function runtimeIdentity(packageRoot, entry) {
  const manifest = readJson(path.join(packageRoot, "package.json"));
  assert.equal(manifest.name, "openclaw", "retained runtime is not OpenClaw");
  assert(
    Number.isSafeInteger(manifest.openclaw?.schemaVersions?.agent),
    "baseline agent schema missing",
  );
  return {
    packageRoot,
    entry,
    version: manifest.version,
    schemaVersions: manifest.openclaw.schemaVersions,
    manifestSha256: hashFile(path.join(packageRoot, "package.json")),
    entrySha256: hashFile(entry),
  };
}

function runBaseline(runtime, args, output, env = process.env) {
  const result = spawnSync(process.execPath, [runtime.entry, ...args], {
    encoding: "utf8",
    env,
    timeout: 900_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  fs.writeFileSync(output, result.stdout ?? "", { mode: 0o600 });
  fs.writeFileSync(`${output}.err`, result.stderr ?? "", { mode: 0o600 });
  assert.equal(
    result.status,
    0,
    `baseline ${args.slice(0, 2).join(" ")} failed; see ${output}.err`,
  );
  return readJson(output);
}

function eligibility(version, resultFile) {
  const comparison = compareReleaseVersions(version, MINIMUM_BASELINE);
  assert.notEqual(comparison, null, "invalid baseline release version");
  const required = comparison >= 0;
  writeJson(resultFile, {
    status: required ? "pending" : "not-applicable",
    baselineVersion: version,
    minimumBaseline: MINIMUM_BASELINE,
    ...(required ? {} : { reason: "Published baseline predates database preflight-agent." }),
  });
  return required ? "required" : "not-applicable";
}

function capture(schemaFile, packageRoot, entry, runtimeRoot, resultFile) {
  const schema = readJson(schemaFile);
  const runtime = runtimeIdentity(packageRoot, entry);
  assert.equal(runtime.version, schema.baselineVersion, "retained baseline version changed");
  const specimens = schema.databases.map(({ kind, relative }) => ({ kind, relative }));
  for (const agent of schema.agents) {
    const existing = specimens.find((specimen) => specimen.relative === agent.databaseRelative);
    if (existing) {
      existing.agentId = agent.agentId;
    } else {
      specimens.push({ kind: "agent", relative: agent.databaseRelative, agentId: agent.agentId });
    }
  }
  const files = schema.agents
    .flatMap((agent) => agent.files)
    .filter((file) => file.kind !== "sqlite-runtime")
    .map(({ relative, kind }) => ({ relative, kind }));
  const before = inventory(schema.stateDir, specimens, files);
  for (const file of schema.agents.flatMap((agent) => agent.files)) {
    if (file.kind !== "sqlite-runtime") {
      assert.equal(
        before.files.find((item) => item.relative === file.relative)?.sha256,
        file.sha256,
        "baseline legacy file changed before backup",
      );
    }
  }
  for (const expected of schema.databases) {
    const observed = before.databases.find((database) => database.relative === expected.relative);
    assert.equal(
      observed.present ? observed.userVersion : null,
      expected.userVersion,
      "baseline schema changed before backup",
    );
    assert.equal(
      observed.present ? observed.contentVersion : null,
      expected.contentVersion,
      "baseline content schema changed before backup",
    );
  }
  const agents = before.databases.filter(
    (database) => database.kind === "agent" && database.present,
  );
  assert(
    agents.some(
      (database) =>
        database.sessions.length > 0 &&
        database.tables.some((table) => table.table === "transcript_events" && table.rows > 0),
    ),
    "rollback proof requires a real baseline transcript",
  );
  for (const agent of agents) {
    assert.equal(
      agent.userVersion,
      runtime.schemaVersions.agent,
      "baseline agent is not at its published schema",
    );
  }
  const canonicalTranscript = canonicalRestoredTranscript(schema, runtime);
  const artifacts = path.dirname(resultFile);
  const archivePath = path.join(runtimeRoot, "before-update.tar.gz");
  const created = runBaseline(
    runtime,
    ["backup", "create", "--verify", "--output", archivePath, "--json"],
    path.join(artifacts, "backup-rollback-create.json"),
  );
  assert.equal(created.verified, true, "baseline backup was not verified");
  assert.equal(created.dryRun, false, "baseline backup was only a dry run");
  assert.equal(
    path.resolve(created.archivePath),
    path.resolve(archivePath),
    "baseline backup archive changed",
  );
  const assets = created.assets.filter(
    (asset) =>
      asset.kind === "state" &&
      fs.realpathSync(asset.sourcePath) === fs.realpathSync(schema.stateDir),
  );
  assert.equal(assets.length, 1, "backup lacks one unambiguous state asset");
  containedPath(runtimeRoot, assets[0].archivePath);
  const members = archiveMembers(archivePath);
  const omittedRawTranscripts = [];
  for (const file of before.files) {
    const archiveMember = path.posix.join(assets[0].archivePath, file.relative);
    if (members.has(archiveMember)) {
      continue;
    }
    assert.equal(
      file.relative,
      canonicalTranscript?.relative,
      "unqualified file missing from backup archive",
    );
    assert(
      Number.isSafeInteger(created.skippedVolatileCount) && created.skippedVolatileCount >= 1,
      "published backup lacks aggregate volatile omission evidence",
    );
    omittedRawTranscripts.push({
      ...canonicalTranscript,
      archiveMember,
      reason: "published-2026.9.4-volatile-transcript",
    });
  }
  assert.deepEqual(
    inventory(schema.stateDir, specimens, files),
    before,
    "backup changed baseline session state",
  );
  writeJson(resultFile, {
    status: "captured",
    baselineVersion: runtime.version,
    runtime,
    runtimeRoot,
    candidateVersion: schema.candidateVersion,
    candidateSchemaVersions: schema.candidateSchemaVersions,
    sourceStateDir: schema.stateDir,
    before,
    backupCreate: created,
    omittedRawTranscripts,
    rawTranscriptRestoration: omittedRawTranscripts.length
      ? "unsupported-by-published-backup"
      : "verified",
    archive: {
      path: archivePath,
      sha256: hashFile(archivePath),
      archiveRoot: created.archiveRoot,
      stateAsset: assets[0].archivePath,
    },
  });
  return "captured";
}

function verify(resultFile, candidateSchemaFile) {
  const proof = readJson(resultFile);
  if (proof.status === "not-applicable") {
    return "not-applicable";
  }
  assert.equal(proof.status, "captured", "baseline backup capture is incomplete");
  const candidate = readJson(candidateSchemaFile);
  assert.equal(
    candidate.candidateVersion,
    proof.candidateVersion,
    "candidate schema evidence version changed",
  );
  assert.equal(candidate.stateDir, proof.sourceStateDir, "candidate schema evidence state changed");
  assert.deepEqual(
    candidate.candidateSchemaVersions,
    proof.candidateSchemaVersions,
    "candidate schema targets changed",
  );
  for (const database of proof.before.databases.filter((item) => item.present)) {
    assert(
      candidate.databases.some(
        (item) => item.relative === database.relative && item.kind === database.kind,
      ),
      "candidate schema evidence is missing a baseline database",
    );
  }
  for (const database of candidate.databases) {
    assert.equal(
      database.contentVersion,
      proof.candidateSchemaVersions[database.kind],
      "candidate migration was not verified",
    );
  }
  assert.deepEqual(
    runtimeIdentity(proof.runtime.packageRoot, proof.runtime.entry),
    proof.runtime,
    "retained baseline runtime changed",
  );
  assert.equal(
    hashFile(proof.archive.path),
    proof.archive.sha256,
    "backup archive changed after capture",
  );
  const staging = path.join(proof.runtimeRoot, "restored");
  const selector = path.join(proof.runtimeRoot, "selector");
  fs.mkdirSync(selector, { mode: 0o700 });
  // Neither restore nor preflight may select the migrated candidate's state.
  // The database under inspection is supplied explicitly to preflight-agent.
  const env = {
    ...process.env,
    HOME: selector,
    USERPROFILE: selector,
    OPENCLAW_HOME: selector,
    OPENCLAW_STATE_DIR: path.join(selector, "state"),
    OPENCLAW_CONFIG_PATH: path.join(selector, "state", "openclaw.json"),
  };
  delete env.OPENCLAW_PROFILE;
  delete env.OPENCLAW_AGENT_DIR;
  delete env.PI_CODING_AGENT_DIR;
  const artifacts = path.dirname(resultFile);
  const restored = runBaseline(
    proof.runtime,
    ["backup", "restore", proof.archive.path, "--target", staging, "--json"],
    path.join(artifacts, "backup-rollback-restore.json"),
    env,
  );
  assert.equal(restored.ok, true, "baseline backup restore failed verification");
  assert.equal(path.resolve(restored.targetPath), staging, "backup restore target changed");
  assert.equal(
    path.resolve(restored.archivePath),
    path.resolve(proof.archive.path),
    "restored archive changed",
  );
  assert.equal(restored.archiveRoot, proof.archive.archiveRoot, "restored archive root changed");
  const stateDir = containedPath(staging, proof.archive.stateAsset);
  const specimens = proof.before.databases.map(({ kind, relative, agentId }) => ({
    kind,
    relative,
    ...(agentId ? { agentId } : {}),
  }));
  const members = archiveMembers(proof.archive.path);
  for (const omitted of proof.omittedRawTranscripts) {
    assert.equal(omitted.relative, RESTORED_TRANSCRIPT, "unqualified restored omission");
    assert.equal(proof.runtime.version, "2026.9.4", "unqualified restored baseline");
    assert.equal(
      members.has(omitted.archiveMember),
      false,
      "omitted transcript is present in archive",
    );
    assert.equal(
      fs.existsSync(containedPath(stateDir, omitted.relative)),
      false,
      "omitted raw transcript unexpectedly restored",
    );
  }
  const expected = {
    ...proof.before,
    files: proof.before.files.filter(
      (file) => !proof.omittedRawTranscripts.some((omitted) => omitted.relative === file.relative),
    ),
  };
  const files = expected.files.map(({ relative, kind }) => ({ relative, kind }));
  assert.deepEqual(
    inventory(stateDir, specimens, files),
    expected,
    "restored baseline inventory differs",
  );
  const preflights = [];
  for (const database of proof.before.databases) {
    if (database.kind !== "agent" || !database.present) {
      continue;
    }
    const output = path.join(artifacts, `backup-rollback-preflight-${database.agentId}.json`);
    const preflight = runBaseline(
      proof.runtime,
      [
        "database",
        "preflight-agent",
        containedPath(stateDir, database.relative),
        "--agent-id",
        database.agentId,
        "--json",
      ],
      output,
      env,
    );
    assert.equal(
      preflight.schema,
      "openclaw.agent-schema-preflight.v1",
      "invalid baseline preflight result",
    );
    assert.equal(preflight.agentId, database.agentId, "baseline preflight owner changed");
    assert.equal(
      preflight.databasePath,
      containedPath(stateDir, database.relative),
      "baseline preflight inspected the wrong database",
    );
    assert.equal(preflight.status, "exact", "restored database is not exact for the baseline");
    assert.equal(
      preflight.foundVersion,
      database.userVersion,
      "baseline preflight found the wrong schema",
    );
    assert.equal(
      preflight.targetVersion,
      proof.runtime.schemaVersions.agent,
      "preflight ran with the wrong baseline target",
    );
    assert.equal(preflight.requiresWrite, false, "baseline preflight requires migration");
    assert.deepEqual(preflight.issues, [], "baseline preflight reported issues");
    preflights.push({
      agentId: database.agentId,
      output,
      status: preflight.status,
      foundVersion: preflight.foundVersion,
      targetVersion: preflight.targetVersion,
    });
  }
  assert.deepEqual(
    inventory(stateDir, specimens, files),
    expected,
    "baseline preflight mutated restored history",
  );
  fs.mkdirSync(env.OPENCLAW_STATE_DIR, { recursive: true, mode: 0o700 });
  writeJson(env.OPENCLAW_CONFIG_PATH, {
    agents: {
      ownership: "explicit",
      entries: Object.fromEntries(
        proof.before.databases
          .filter((database) => database.kind === "agent")
          .map((database) => [database.agentId, {}]),
      ),
    },
  });
  const sessionReads = [];
  for (const database of proof.before.databases) {
    if (database.kind !== "agent" || !database.present) {
      continue;
    }
    const databasePath = containedPath(stateDir, database.relative);
    const output = path.join(artifacts, `backup-rollback-sessions-${database.agentId}.json`);
    // v2026.9.4 sessions.ts uses listSessionEntriesReadOnly for this explicit
    // store. Transcript bytes are proved separately by the SQL inventory.
    const listing = runBaseline(
      proof.runtime,
      [
        "sessions",
        "--store",
        databasePath,
        "--agent",
        database.agentId,
        "--limit",
        "all",
        "--json",
      ],
      output,
      env,
    );
    assert.equal(listing.path, databasePath, "baseline session consumer read the wrong store");
    assert.equal(
      listing.count,
      database.sessions.length,
      "baseline session consumer lost sessions",
    );
    assert.equal(
      listing.totalCount,
      database.sessions.length,
      "baseline session consumer total changed",
    );
    assert.equal(listing.hasMore, false, "baseline session consumer truncated its results");
    assert.equal(listing.limitApplied, null, "baseline session consumer applied a limit");
    const identities = listing.sessions
      .map(({ key, sessionId }) => ({ key, sessionId }))
      .toSorted(compareSessionKeys);
    assert.deepEqual(
      identities,
      database.sessions,
      "baseline session consumer returned different identities",
    );
    sessionReads.push({
      agentId: database.agentId,
      output,
      path: databasePath,
      count: listing.count,
    });
  }
  assert.deepEqual(
    inventory(stateDir, specimens, files),
    expected,
    "baseline session consumer mutated restored history",
  );
  writeJson(resultFile, {
    ...proof,
    status: "passed",
    restoredStateDir: stateDir,
    preflights,
    sessionReads,
  });
  return "passed";
}

const [command, ...args] = process.argv.slice(2);
try {
  assert(
    (command === "eligibility" && args.length === 2) ||
      (command === "capture" && args.length === 5) ||
      (command === "verify" && args.length === 2),
    "usage: backup-rollback.mjs eligibility <baseline-version> <result.json> | capture <schema-before.json> <baseline-package> <baseline-entry> <runtime-root> <result.json> | verify <result.json> <schema-after.json>",
  );
  process.stdout.write(
    `${command === "eligibility" ? eligibility(...args) : command === "capture" ? capture(...args) : verify(...args)}\n`,
  );
} catch (error) {
  const resultFile = command === "capture" ? args[4] : command === "verify" ? args[0] : undefined;
  if (resultFile && fs.existsSync(resultFile)) {
    writeJson(resultFile, {
      ...readJson(resultFile),
      status: "failed",
      failure: { command, message: error.message },
    });
  }
  process.stderr.write(`Backup rollback proof failed: ${error.message}\n`);
  process.exitCode = 1;
}
