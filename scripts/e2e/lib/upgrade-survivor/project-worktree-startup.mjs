// The canonical survivor runner owns Doctor, update, Gateway, and shutdown.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  resolveWorkerCellExport,
  resolveWorkerCellFunctionBinding,
} from "./worker-cell-package.mjs";

const BASELINE = "3a9d69db306cd7f081e06254cb89c4bcc14a7107";
const BASELINE_AGENT_SCHEMA = 19;
const KEY = "agent:main:dashboard:legacy-project-worktree";
const OTHER_KEY = "agent:main:dashboard:legacy-project-sentinel";
const SESSION = "00000000-0000-4000-8000-000000000001";
const OTHER_SESSION = "00000000-0000-4000-8000-000000000002";
const STAGES = new Set([
  "published-import",
  "after-update",
  "before-schema",
  "before-startup",
  "after-first-stop",
  "after-doctor",
  "after-second-stop",
]);
const BASELINE_BINDINGS = {
  register: [
    "project-registry-D_ymI9b-.mjs",
    "registerProjectRegistry",
    "89ba1a94f0238ff7e5c9ca7d4b42bc2dcb7c666c042c67a3fb79a44a832713f5",
  ],
  worktrees: [
    "service-8NOwfzO8.mjs",
    "ManagedWorktreeService",
    "c2bc4b8a4ee3cf147115a044a9b72d6103103d789cb7a620e972f8c5a2ed2926",
  ],
  close: [
    "openclaw-state-db-m8z7pMTn.mjs",
    "closeOpenClawStateDatabaseByPath",
    "0efee81689942591023d3d68bc67cdab21a86c38bafc7bb275f03d4d62d3ce10",
  ],
  drain: [
    "global-singleton-Dc_stLtU.mjs",
    "drainGlobalSingletonLifecycleState",
    "aa27b41a8ee873d070aeca8a79f28439f82ac0d458b9016040ab07f89516d089",
  ],
  prepare: [
    "openclaw-state-db-readonly-Drry1uVZ.mjs",
    "prepareSqliteReadOnlyLocationSync",
    "ef1269283c79aa4e5d2024e0e65d2c7ccfc2e510afefab2121acda57727f185d",
  ],
  open: [
    "node-sqlite-B7YCpTW3.mjs",
    "openNodeSqliteDatabase",
    "cc80ae5eca2d6704f8a48afcf69ef5c7e2812d3e3cc29ad276e4930564451874",
  ],
};

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function digest(file) {
  assert(fs.lstatSync(file).isFile(), `Expected regular fixture file: ${file}`);
  return hash(fs.readFileSync(file));
}
function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
}
function childOf(root, file) {
  const relative = path.relative(root, file);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}
function context() {
  const get = (name) => {
    assert(path.isAbsolute(process.env[name] ?? ""), `Missing isolated ${name}`);
    return fs.realpathSync(process.env[name]);
  };
  const root = get("OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT");
  const artifacts = get("OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT");
  const stateDir = get("OPENCLAW_STATE_DIR");
  const config = process.env.OPENCLAW_CONFIG_PATH;
  assert(childOf(root, stateDir) && childOf(stateDir, config));
  const tempRoots = [get("TMPDIR"), get("XDG_CACHE_HOME")];
  assert(tempRoots.every((dir) => childOf(root, dir)));
  return {
    root,
    artifacts,
    stateDir,
    config,
    tempRoots,
    stateDb: path.join(stateDir, "state/openclaw.sqlite"),
    fixture: path.join(artifacts, "project-worktree-fixture.json"),
    importReceipt: path.join(artifacts, "project-worktree-import.json"),
  };
}
function sqliteFamily(file) {
  return Object.fromEntries(
    ["", "-wal", "-shm", "-journal"].flatMap((suffix) =>
      fs.existsSync(file + suffix) ? [[suffix || "main", digest(file + suffix)]] : [],
    ),
  );
}
function retainedSnapshots(roots) {
  const results = [];
  function visit(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (/^openclaw-(sqlite-readonly-|doctor-lint-state-)/.test(entry.name)) {
        results.push(file);
      }
      if (entry.isDirectory()) {
        visit(file);
      }
    }
  }
  for (const root of new Set(roots)) {
    visit(root);
  }
  return results.toSorted((a, b) => a.localeCompare(b));
}
function loadFixture(ctx) {
  const f = readJson(ctx.fixture);
  assert.equal(f.stateDir, ctx.stateDir);
  assert.equal(f.root, ctx.root);
  return f;
}

async function owners(ctx, packageRoot, baseline, bindingFile) {
  const identity = readJson(
    path.join(
      ctx.artifacts,
      baseline ? "baseline-package-identity.json" : "installed-package-identity.json",
    ),
  );
  const candidateCommit = process.env.OPENCLAW_UPGRADE_SURVIVOR_CANDIDATE_COMMIT;
  if (!baseline) {
    assert.match(candidateCommit ?? "", /^[a-f0-9]{40}$/u);
  }
  assert.equal(identity.buildInfo.commit, baseline ? BASELINE : candidateCommit);
  assert.equal(fs.realpathSync(path.join(packageRoot, "openclaw.mjs")), identity.cli);
  let bindings = BASELINE_BINDINGS;
  let agentSchema = BASELINE_AGENT_SCHEMA;
  if (!baseline) {
    const approved = readJson(bindingFile);
    assert.equal(approved.commit, candidateCommit);
    assert.deepEqual(
      Object.keys(approved.operations).toSorted((a, b) => a.localeCompare(b)),
      ["open", "prepare"],
    );
    assert.equal(approved.operations.open[1], "openNodeSqliteDatabase");
    assert.equal(approved.operations.prepare[1], "prepareSqliteReadOnlyLocationSync");
    assert.equal(
      readJson(path.join(packageRoot, "package.json")).openclaw.schemaVersions.agent,
      approved.agentSchema,
    );
    bindings = approved.operations;
    agentSchema = approved.agentSchema;
  }
  return {
    ...(await loadBindings(identity, packageRoot, bindings)),
    identity,
    baseline,
    agentSchema,
  };
}

async function loadBindings(identity, packageRoot, bindings) {
  const api = {};
  const evidence = [];
  for (const [role, [name, symbol, expectedHash]] of Object.entries(bindings)) {
    assert.equal(path.basename(name), name);
    const relative = `dist/${name}`;
    const file = path.join(packageRoot, relative);
    assert.equal(digest(file), expectedHash, `Owner hash changed: ${role}`);
    assert.equal(
      identity.files[relative]?.sha256,
      expectedHash,
      `Owner differs from installed identity: ${role}`,
    );
    const alias = resolveWorkerCellExport(fs.readFileSync(file, "utf8"), symbol);
    assert(alias, `Missing exact owner export: ${symbol}`);
    const module = await import(pathToFileURL(file).href);
    assert.equal(typeof module[alias], "function");
    api[role] = module[alias];
    evidence.push({ role, relative, symbol, alias, sha256: expectedHash });
  }
  return { api, evidence };
}

async function prepareSchema(ctx, packageRoot, bindings) {
  const owner = await owners(ctx, packageRoot, false, bindings);
  const before = readJson(path.join(ctx.artifacts, "worktree-before-schema.json"));
  assert.equal(before.agent.schema.userVersion, BASELINE_AGENT_SCHEMA);
  assert(
    owner.agentSchema > BASELINE_AGENT_SCHEMA,
    "Expected a published-to-candidate schema upgrade",
  );
  const require = createRequire(path.join(packageRoot, "package.json"));
  const parserPath = fs.realpathSync(require.resolve("typescript"));
  assert(childOf(fs.realpathSync(packageRoot), parserPath), "Use the installed package's parser");
  const ts = require(parserPath);
  assert.equal(
    ts.version,
    readJson(path.join(packageRoot, "package.json")).dependencies.typescript,
  );
  const doctorBindings = {};
  for (const [role, prefix, symbol] of [
    ["lock", "doctor-sqlite-maintenance-lock", "withDoctorSqliteMaintenanceLock"],
    ["migrate", "state-migrations.media-persistence", "migrateLegacyMediaPersistence"],
    ["drain", "global-singleton", "drainGlobalSingletonLifecycleState"],
    ["close", "openclaw-state-db-cache", "closeOpenClawStateDatabaseByPathAsync"],
  ]) {
    doctorBindings[role] = resolveWorkerCellFunctionBinding(
      owner.identity,
      packageRoot,
      prefix,
      symbol,
      ts,
    );
  }
  const doctor = await loadBindings(owner.identity, packageRoot, doctorBindings);
  const { agentDb } = readJson(ctx.importReceipt);
  const errors = [];
  let result;
  try {
    result = await doctor.api.lock({
      env: process.env,
      operation: "project worktree fixture schema preparation",
      run: () =>
        doctor.api.migrate({
          env: process.env,
          configuredAgentDatabaseTargets: [{ agentId: "main", path: agentDb }],
        }),
    });
  } catch (error) {
    errors.push(error);
  }
  for (const [operation, argument] of [
    [doctor.api.drain, "close"],
    [doctor.api.close, ctx.stateDb],
  ]) {
    try {
      await operation(argument);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) {
    throw new AggregateError(errors, "Doctor schema preparation did not settle");
  }
  writeJson(path.join(ctx.artifacts, "worktree-schema-doctor.json"), {
    ownerBindings: doctor.evidence,
    parser: { version: ts.version, sha256: digest(parserPath) },
    fromSchema: before.agent.schema,
    targetSchema: owner.agentSchema,
    result,
  });
  assert.deepEqual(
    result,
    {
      changes: [
        `Upgraded agent database schema in ${agentDb}: v${BASELINE_AGENT_SCHEMA} -> v${owner.agentSchema}.`,
      ],
      warnings: [],
    },
    "Doctor schema preparation warned, refused, or changed more than the schema",
  );
}

async function inspectDatabase(owner, file, read) {
  const before = sqliteFamily(file);
  const prepared = owner.api.prepare(file);
  assert.notEqual(
    prepared.location,
    file,
    "Observer must use the snapshot owner's private location",
  );
  let db;
  let value;
  const errors = [];
  try {
    db = owner.api.open(prepared.location, { readOnly: true });
    value = read(db);
  } catch (error) {
    errors.push(error);
  }
  try {
    db?.close();
  } catch (error) {
    errors.push(error);
  }
  // A failed native close retains the prepared files; never delete beneath it.
  if (db?.isOpen !== true) {
    try {
      const cleaned = owner.baseline ? prepared.cleanup() : await prepared.cleanupAsync();
      assert.equal(cleaned, true, "Private observer cleanup failed");
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) {
    throw new AggregateError(errors, "Project startup observer did not settle");
  }
  assert.deepEqual(sqliteFamily(file), before, "Observer modified source SQLite files");
  return value;
}

async function seed(ctx, packageRoot) {
  assert(!fs.existsSync(ctx.fixture));
  const fixtureRoot = path.dirname(ctx.stateDir);
  const repo = path.join(fixtureRoot, "project-repo");
  const workspace = path.join(fixtureRoot, "agent-default");
  fs.mkdirSync(path.join(repo, "packages/app"), { recursive: true });
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(repo, "README.md"), "Published-owner project fixture\n", {
    flag: "wx",
  });
  fs.writeFileSync(path.join(repo, "packages/app/SENTINEL.txt"), "Project history — 東京\n", {
    flag: "wx",
  });
  fs.writeFileSync(path.join(workspace, "SENTINEL.txt"), "Distinct agent workspace\n", {
    flag: "wx",
  });
  const gitEnv = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: "/dev/null",
    GIT_CONFIG_KEY_1: "commit.gpgsign",
    GIT_CONFIG_VALUE_1: "false",
    GIT_AUTHOR_NAME: "OpenClaw Synthetic Proof",
    GIT_AUTHOR_EMAIL: "proof@example.invalid",
    GIT_COMMITTER_NAME: "OpenClaw Synthetic Proof",
    GIT_COMMITTER_EMAIL: "proof@example.invalid",
  };
  // Published worktree Git helpers read the one-shot process environment.
  Object.assign(process.env, gitEnv);
  const owner = await owners(ctx, packageRoot, true);
  const git = (...args) =>
    execFileSync("git", args, { cwd: repo, env: gitEnv, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  git("add", "README.md", "packages/app/SENTINEL.txt");
  git("commit", "-q", "-m", "Synthetic legacy import source");
  const commit = git("rev-parse", "HEAD");
  const legacyStore = path.join(ctx.stateDir, "agents/main/sessions/sessions.json");
  fs.mkdirSync(path.dirname(legacyStore), { recursive: true });
  const cfg = {
    gateway: {
      mode: "local",
      bind: "loopback",
      auth: { mode: "token", token: process.env.GATEWAY_AUTH_TOKEN_REF },
      controlUi: { enabled: false },
    },
    agents: { list: [{ id: "main", default: true, workspace }] },
    session: { store: legacyStore },
    plugins: { enabled: false },
  };
  assert(cfg.gateway.auth.token, "Use the canonical synthetic survivor token");
  fs.writeFileSync(ctx.config, JSON.stringify(cfg, null, 2) + "\n");
  let project, worktree;
  const errors = [];
  try {
    project = await owner.api.register(
      { path: repo, name: "Legacy migration project" },
      { env: gitEnv },
    );
    const service = new owner.api.worktrees({
      env: gitEnv,
      getConfig: () => ({ worktreeRoot: path.join(fixtureRoot, "managed") }),
    });
    worktree = await service.create({
      repoRoot: project.repoRoot,
      name: "legacy-project-workspace",
      baseRef: "main",
      checkoutCommit: commit,
      ownerKind: "session",
      ownerId: KEY,
      runSetupScript: false,
    });
    assert.equal(worktree.ownerId, KEY);
    assert.equal(worktree.repoRoot, project.repoRoot);
  } catch (error) {
    errors.push(error);
  }
  try {
    await owner.api.drain("close");
  } catch (error) {
    errors.push(error);
  }
  try {
    owner.api.close(ctx.stateDb);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length) {
    throw new AggregateError(errors, "Published fixture owners did not settle");
  }
  const spawnedCwd = path.join(worktree.path, "packages/app");
  const entries = {
    [KEY]: {
      sessionId: SESSION,
      updatedAt: 10,
      lastActivityAt: 10,
      projectId: project.id,
      spawnedCwd,
      worktree: { id: worktree.id, branch: worktree.branch, repoRoot: worktree.repoRoot },
      sessionFile: `${SESSION}.jsonl`,
    },
    [OTHER_KEY]: { sessionId: OTHER_SESSION, updatedAt: 20, sessionFile: `${OTHER_SESSION}.jsonl` },
  };
  writeJson(legacyStore, entries);
  for (const id of [SESSION, OTHER_SESSION]) {
    const events = [
      { type: "session", id, version: 3 },
      {
        type: "message",
        id: `message-${id}`,
        parentId: null,
        message: { role: "user", content: "Preserve this imported history." },
      },
    ];
    fs.writeFileSync(
      path.join(path.dirname(legacyStore), `${id}.jsonl`),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
      { flag: "wx" },
    );
  }
  const inputFiles = [
    legacyStore,
    ...[SESSION, OTHER_SESSION].map((id) => path.join(path.dirname(legacyStore), `${id}.jsonl`)),
  ];
  const sentinels = [
    path.join(repo, "README.md"),
    path.join(repo, "packages/app/SENTINEL.txt"),
    path.join(spawnedCwd, "SENTINEL.txt"),
    path.join(workspace, "SENTINEL.txt"),
  ];
  writeJson(ctx.fixture, {
    provenance:
      "synthetic supported legacy-format input; published9.4 project/worktree owners; not a historical generated session",
    root: ctx.root,
    stateDir: ctx.stateDir,
    baselineCommit: BASELINE,
    project,
    worktree,
    commit,
    workspace,
    legacyStore,
    sessionKey: KEY,
    unrelatedSessionKey: OTHER_KEY,
    entries,
    inputHashes: Object.fromEntries(inputFiles.map((f) => [f, digest(f)])),
    sentinelHashes: Object.fromEntries(sentinels.map((f) => [f, digest(f)])),
    ownerBindings: owner.evidence,
  });
}

export function assertProjectWorktreeImportReport(report, legacyStore, dryRun, manifest) {
  assert.equal(report.mode, "import");
  assert.equal(report.targets.length, 1);
  const target = report.targets[0];
  assert.equal(target.agentId, "main");
  assert.equal(target.storePath, legacyStore);
  assert.equal(target.legacyEntries, 2);
  assert.equal(target.referencedTranscriptFiles, 2);
  assert.equal(target.sqliteEntries, 2);
  assert.equal(target.importedEntries, 2);
  assert.equal(target.importedTranscriptEvents, 4);
  // Fresh imports record pre-archive validation in the manifest, not these counters.
  assert.equal(target.validatedEntries, 0);
  assert.equal(target.validatedTranscriptEvents, 0);
  assert.deepEqual(target.issues, []);

  assert.equal(dryRun.mode, "dry-run");
  assert.equal(dryRun.targets.length, 1);
  const dryTarget = dryRun.targets[0];
  assert.equal(dryTarget.agentId, target.agentId);
  assert.equal(dryTarget.storePath, target.storePath);
  assert.equal(dryTarget.sqlitePath, target.sqlitePath);
  assert.equal(dryTarget.legacyEntries, 2);
  assert.equal(dryTarget.referencedTranscriptFiles, 2);
  assert.equal(dryTarget.sqliteEntries, 0);
  assert.equal(dryTarget.importedEntries, 0);
  assert.equal(dryTarget.importedTranscriptEvents, 0);
  assert.equal(dryTarget.validatedEntries, 2);
  assert.equal(dryTarget.validatedTranscriptEvents, 4);
  assert.deepEqual(dryTarget.issues, []);

  assert(manifest.completedAt && !manifest.failedAt, "Published import did not complete");
  assert.equal(manifest.runId, report.migrationRun.runId);
  assert.equal(manifest.targets.length, 1);
  const manifestTarget = manifest.targets[0];
  assert.equal(manifestTarget.agentId, target.agentId);
  assert.equal(manifestTarget.storePath, target.storePath);
  assert.equal(manifestTarget.sqlitePath, target.sqlitePath);
  assert.equal(manifestTarget.validationBeforeArchive, "passed");
  assert.deepEqual(manifestTarget.issues, []);
  return target;
}

function assertImport(ctx, reportFile) {
  const f = loadFixture(ctx);
  const report = readJson(reportFile);
  const backupFile = path.join(ctx.artifacts, "worktree-backup.json");
  const backup = readJson(backupFile);
  assert.equal(backup.verified, true, "Published backup was not verified");
  assert(childOf(ctx.artifacts, backup.archivePath));
  assert(
    report.migrationRun?.manifestPath && childOf(ctx.stateDir, report.migrationRun.manifestPath),
  );
  const manifest = readJson(report.migrationRun.manifestPath);
  const dryRunFile = path.join(ctx.artifacts, "worktree-dry-run.json");
  const target = assertProjectWorktreeImportReport(
    report,
    f.legacyStore,
    readJson(dryRunFile),
    manifest,
  );
  assert(childOf(ctx.stateDir, target.sqlitePath));
  const moves = manifest.targets[0].completedMoves;
  for (const [source, expected] of Object.entries(f.inputHashes)) {
    const matching = moves.filter((move) => move.sourcePath === source);
    assert.equal(matching.length, 1, `Missing unique archived original: ${source}`);
    assert(childOf(ctx.stateDir, matching[0].archivePath));
    assert.equal(digest(matching[0].archivePath), expected, "Archived legacy input bytes changed");
  }
  writeJson(ctx.importReceipt, {
    agentDb: target.sqlitePath,
    importReportSha256: digest(reportFile),
    dryRunReportSha256: digest(dryRunFile),
    manifestPath: report.migrationRun.manifestPath,
    manifestSha256: digest(report.migrationRun.manifestPath),
    archivedInputHashes: f.inputHashes,
    backupReportSha256: digest(backupFile),
    backupArchivePath: backup.archivePath,
    backupArchiveSha256: digest(backup.archivePath),
  });
}

export function assertProjectWorktreeStartupLog(log, start) {
  assert(["first", "second"].includes(start));
  const backfills = [
    ...log.matchAll(
      /session: recorded canonical workspaces for (\d+) managed-worktree session\(s\)/g,
    ),
  ].map((match) => Number(match[1]));
  assert.deepEqual(backfills, [], "Gateway startup performed a Doctor-owned workspace repair");
  assert.match(log, /(?:\[shutdown\]|shutdown) completed cleanly in \d+ms/);
  assert(
    !/(?:\[shutdown\]|shutdown) (?:completed in \d+ms with warnings:|failed in \d+ms)/.test(log),
  );
  return { backfills, cleanShutdown: true };
}

export function assertProjectWorktreeStartupPreservation(actual, original, expectedWorkspace) {
  assert.deepEqual(actual.shared, original.shared);
  assert.deepEqual(actual.agent.transcript, original.agent.transcript);
  assert.equal(actual.agent.sessions.length, original.agent.sessions.length);
  for (const row of actual.agent.sessions) {
    const before = original.agent.sessions.find((s) => s.session_key === row.session_key);
    assert(before, `Unexpected session row: ${row.session_key}`);
    if (row.session_key !== KEY || expectedWorkspace === undefined) {
      assert.deepEqual(row, before);
      continue;
    }
    const expected = JSON.parse(before.entry_json);
    expected.worktree.canonicalWorkspaceDir = expectedWorkspace;
    assert.deepEqual(JSON.parse(row.entry_json), expected);
    assert.equal(row.updated_at, before.updated_at);
    assert.equal(row.current_session_id, before.current_session_id);
  }
}

async function snapshot(ctx, stage, packageRoot, bindings) {
  assert(STAGES.has(stage));
  const f = loadFixture(ctx),
    imported = readJson(ctx.importReceipt);
  const owner = await owners(ctx, packageRoot, stage === "published-import", bindings);
  const rows = (stmt) => stmt.all().map((row) => Object.assign({}, row));
  const shared = await inspectDatabase(owner, ctx.stateDb, (db) => ({
    project: rows(db.prepare("SELECT * FROM projects ORDER BY id")),
    worktrees: rows(db.prepare("SELECT * FROM worktrees ORDER BY id")),
  }));
  const agent = await inspectDatabase(owner, imported.agentDb, (db) => ({
    schema: {
      userVersion: db.prepare("PRAGMA user_version").get().user_version,
      metadataVersion: db
        .prepare("SELECT schema_version FROM schema_meta WHERE meta_key = 'primary'")
        .get().schema_version,
      agentId: db.prepare("SELECT agent_id FROM schema_meta WHERE meta_key = 'primary'").get()
        .agent_id,
    },
    sessions: rows(
      db.prepare(
        "SELECT session_key,current_session_id,entry_json,updated_at FROM session_nodes WHERE session_key IN ('agent:main:dashboard:legacy-project-worktree','agent:main:dashboard:legacy-project-sentinel') ORDER BY session_key",
      ),
    ),
    transcript: rows(
      db.prepare(
        "SELECT session_id,seq,event_json,created_at FROM transcript_events WHERE session_id IN ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002') ORDER BY session_id,seq",
      ),
    ),
  }));
  const expectedSchema = ["published-import", "before-schema"].includes(stage)
    ? BASELINE_AGENT_SCHEMA
    : owner.agentSchema;
  assert.deepEqual(agent.schema, {
    userVersion: expectedSchema,
    metadataVersion: expectedSchema,
    agentId: "main",
  });
  assert.equal(agent.sessions.length, 2);
  assert.equal(agent.transcript.length, 4);
  const row = agent.sessions.find((s) => s.session_key === KEY);
  const entry = JSON.parse(row.entry_json);
  assert.equal(row.current_session_id, SESSION);
  assert.equal(row.updated_at, 10);
  assert.equal(entry.projectId, f.project.id);
  assert.equal(entry.spawnedCwd, f.entries[KEY].spawnedCwd);
  assert.equal(entry.worktree.id, f.worktree.id);
  assert.equal(entry.worktree.repoRoot, f.project.repoRoot);
  assert.equal(entry.updatedAt, 10);
  assert.equal(entry.lastActivityAt, 10);
  const expectedWorkspace = ["after-update", "after-doctor", "after-second-stop"].includes(stage)
    ? f.project.repoRoot
    : undefined;
  assert.equal(
    entry.worktree.canonicalWorkspaceDir,
    expectedWorkspace,
    "Unexpected migration stage; do not delete metadata to recreate a legacy specimen",
  );
  for (const [file, expected] of Object.entries(f.sentinelHashes)) {
    assert.equal(digest(file), expected);
  }
  assert.deepEqual(retainedSnapshots(ctx.tempRoots), [], "Observer retained private snapshots");
  const result = {
    stage,
    shared,
    agent,
    ownerBindings: owner.evidence,
    sentinelHashes: f.sentinelHashes,
  };
  if (stage !== "published-import") {
    const original = readJson(path.join(ctx.artifacts, "worktree-published-import.json"));
    assertProjectWorktreeStartupPreservation(result, original, expectedWorkspace);
  }
  if (stage === "after-second-stop") {
    const repaired = readJson(path.join(ctx.artifacts, "worktree-after-doctor.json"));
    assert.deepEqual(
      agent,
      repaired.agent,
      "Second startup changed repaired session/history bytes",
    );
    assert.deepEqual(shared, repaired.shared);
  }
  writeJson(path.join(ctx.artifacts, `worktree-${stage}.json`), result);
}

async function main() {
  const [mode, ...args] = process.argv.slice(2),
    ctx = context();
  if (mode === "seed") {
    assert.equal(args.length, 1);
    await seed(ctx, args[0]);
  } else if (mode === "assert-import") {
    assert.equal(args.length, 1);
    assertImport(ctx, args[0]);
  } else if (mode === "snapshot") {
    assert.equal(args.length, 3);
    await snapshot(ctx, ...args);
  } else if (mode === "prepare-schema") {
    assert.equal(args.length, 2);
    await prepareSchema(ctx, ...args);
  } else if (mode === "assert-logs") {
    assert.equal(args.length, 2);
    const [start, file] = args;
    const log = fs.readFileSync(file, "utf8");
    const result = assertProjectWorktreeStartupLog(log, start);
    writeJson(path.join(ctx.artifacts, `worktree-${start}-startup-log.json`), {
      ...result,
      logSha256: digest(file),
    });
  } else {
    throw new Error(
      "Expected seed, assert-import, snapshot, prepare-schema, or assert-logs; see reviewed recipe for arguments",
    );
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
