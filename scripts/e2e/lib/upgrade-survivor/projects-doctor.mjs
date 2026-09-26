import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  resolveWorkerCellExport,
  resolveWorkerCellFunctionBinding,
} from "./worker-cell-package.mjs";

// These chunks belong to the integrity-pinned published 2026.9.4 package.
const BASELINE_CHUNKS = {
  "project-registry-D_ymI9b-.mjs":
    "89ba1a94f0238ff7e5c9ca7d4b42bc2dcb7c666c042c67a3fb79a44a832713f5",
  "kysely-sync-CrjZjQJR.mjs": "529a18c25ace3d1e8d40a630f5ffb30857aa0684d54ae39f4f2518424ceae13b",
  "openclaw-state-db-DoQEJuhr.mjs":
    "d3a52e65d0bca8993cbb6d48ae5d51e475e3aced8c7b9e15da77733f4fc8abcf",
  "openclaw-state-db-m8z7pMTn.mjs":
    "0efee81689942591023d3d68bc67cdab21a86c38bafc7bb275f03d4d62d3ce10",
  "openclaw-state-db-cache-BXmHZWzx.mjs":
    "6e8c7fe9bb935220a23b2193b0132f2e3686b64941aebd233493464fb06a72a1",
};
const STAGES = new Set([
  "baseline",
  "after-update",
  "before-doctor",
  "after-doctor",
  "before-repeat",
  "after-repeat",
]);

function digest(file) {
  assert(fs.lstatSync(file).isFile(), `Expected a regular fixture file: ${file}`);
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
}

function within(root, file) {
  const relative = path.relative(root, file);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function context() {
  const required = (key) => {
    const value = process.env[key];
    assert(value && path.isAbsolute(value), `${key} must be an isolated absolute path`);
    return fs.realpathSync(value);
  };
  const root = required("OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT");
  const artifacts = required("OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT");
  const stateDir = required("OPENCLAW_STATE_DIR");
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  assert(
    configPath && within(stateDir, path.resolve(configPath)),
    "Config must belong to the scenario state",
  );
  assert(within(root, stateDir), "State must belong to the scenario runtime");
  const tempRoots = [required("TMPDIR"), required("XDG_CACHE_HOME")];
  assert(
    tempRoots.every((dir) => within(root, dir)),
    "Snapshot roots must belong to the scenario runtime",
  );
  return {
    root,
    artifacts,
    stateDir,
    configPath,
    tempRoots,
    databasePath: path.join(stateDir, "state", "openclaw.sqlite"),
    manifestPath: path.join(artifacts, "projects-inventory.json"),
  };
}

function snapshotPath(ctx, stage) {
  assert(STAGES.has(stage), `Unknown Projects snapshot stage: ${stage}`);
  return path.join(ctx.artifacts, `projects-${stage}.json`);
}

function fixture(ctx) {
  const expected = readJson(ctx.manifestPath);
  assert.equal(expected.root, ctx.root, "Projects fixture belongs to another runtime");
  assert.equal(
    expected.stateDir,
    ctx.stateDir,
    "Projects fixture belongs to another state directory",
  );
  assert.equal(expected.configPath, ctx.configPath, "Projects fixture belongs to another config");
  return expected;
}

function retainedSnapshots(roots) {
  const retained = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (/^openclaw-(?:sqlite-readonly-|doctor-lint-state-)/.test(entry.name)) {
        retained.push(file);
      }
      if (entry.isDirectory()) {
        visit(file);
      }
    }
  };
  for (const root of new Set(roots)) {
    visit(root);
  }
  return retained.toSorted((a, b) => a.localeCompare(b));
}

function sqliteFamily(databasePath) {
  return Object.fromEntries(
    ["", "-wal", "-shm", "-journal"].flatMap((suffix) => {
      const file = `${databasePath}${suffix}`;
      return fs.existsSync(file) ? [[suffix || "main", digest(file)]] : [];
    }),
  );
}

export function assertProjectsInventory(inventory, baseline) {
  assert.deepEqual(inventory.rows, baseline.rows, "Persisted project inventory changed");
  assert.deepEqual(inventory.schema, baseline.schema, "Projects table schema changed");
  assert.equal(inventory.workspace, baseline.workspace, "Configured workspace changed");
  assert.deepEqual(inventory.sentinels, baseline.sentinels, "Project or workspace files changed");
}

export function assertProjectsDoctorResult(report, before, after) {
  assert.equal(report.ok, true, "Projects Doctor reported an unhealthy result");
  assert.equal(report.checksRun, 1, "Projects Doctor must run exactly the selected check");
  assert.deepEqual(report.findings, [], "Projects Doctor skipped or failed inventory inspection");
  assertProjectsInventory(after, before);
  assert.deepEqual(
    after.sqliteFamily,
    before.sqliteFamily,
    "Read-only Doctor changed SQLite files",
  );
  assert.equal(after.configHash, before.configHash, "Read-only Doctor rewrote the config");
  assert.deepEqual(
    after.retainedSnapshots,
    before.retainedSnapshots,
    "Doctor retained a private snapshot",
  );
}

async function artifactPreservingReader(ctx, stage, packageRoot) {
  assert(
    packageRoot && path.isAbsolute(packageRoot),
    "Snapshot requires the installed package root",
  );
  const identity = readJson(
    path.join(
      ctx.artifacts,
      stage === "baseline" ? "baseline-package-identity.json" : "installed-package-identity.json",
    ),
  );
  assert.equal(
    fs.realpathSync(path.join(packageRoot, "openclaw.mjs")),
    identity.cli,
    "Snapshot package differs from the verified installed CLI",
  );
  const symbol = "withExistingOpenClawStateDatabaseArtifactPreservingReadOnly";
  const { createNativeTypeScriptParser } = await import("../../../lib/native-typescript.mts");
  const parser = createNativeTypeScriptParser({ cwd: packageRoot });
  let binding;
  try {
    binding = await resolveWorkerCellFunctionBinding(
      identity,
      packageRoot,
      "openclaw-state-db-readonly",
      symbol,
      parser,
    );
  } finally {
    parser.close();
  }
  const [name, exportName, sha256] = binding;
  const relative = `dist/${name}`;
  const file = path.join(packageRoot, relative);
  const bytes = fs.readFileSync(file);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    sha256,
    `Installed snapshot owner changed: ${relative}`,
  );
  const alias = resolveWorkerCellExport(bytes.toString("utf8"), exportName);
  assert(alias, "Installed artifact-preserving state reader export is missing");
  const module = await import(pathToFileURL(file).href);
  const read = module[alias];
  assert.equal(typeof read, "function", "Installed artifact-preserving state reader is missing");
  return {
    read,
    evidence: { file: relative, sha256, export: alias },
  };
}

async function snapshot(ctx, stage, packageRoot) {
  const expected = fixture(ctx);
  const familyBefore = sqliteFamily(ctx.databasePath);
  const reader = await artifactPreservingReader(ctx, stage, packageRoot);
  const observed = reader.read(
    ({ db }) => ({
      rows: db
        .prepare(
          "SELECT id, display_name, repo_root, origin_url, source, created_at_ms, updated_at_ms FROM projects ORDER BY id",
        )
        .all()
        .map((row) => Object.assign({}, row)),
      schema: db
        .prepare(
          "SELECT type, name, sql FROM sqlite_schema WHERE tbl_name = 'projects' ORDER BY type, name",
        )
        .all()
        .map((row) => Object.assign({}, row)),
    }),
    { path: ctx.databasePath, env: process.env },
  );
  assert(observed, "Projects state database is missing");
  const familyAfter = sqliteFamily(ctx.databasePath);
  assert.deepEqual(
    familyAfter,
    familyBefore,
    "Inventory observer changed SQLite files; Doctor mutation evidence is inconclusive",
  );
  const config = readJson(ctx.configPath);
  const result = {
    ...observed,
    observer: reader.evidence,
    workspace: config.agents?.defaults?.workspace,
    sentinels: Object.fromEntries(
      Object.keys(expected.sentinels).map((file) => [file, digest(file)]),
    ),
    configHash: digest(ctx.configPath),
    sqliteFamily: familyAfter,
    retainedSnapshots: retainedSnapshots(ctx.tempRoots),
  };
  assert.deepEqual(result.rows, [expected.row], "Expected exactly the seeded registered project");
  assert.equal(result.workspace, expected.workspace, "Configured workspace changed");
  assert.deepEqual(result.sentinels, expected.sentinels, "Synthetic project files changed");
  assert.deepEqual(result.retainedSnapshots, [], "A private SQLite/Doctor snapshot remains");
  if (stage !== "baseline") {
    assertProjectsInventory(result, readJson(snapshotPath(ctx, "baseline")));
  }
  writeJson(snapshotPath(ctx, stage), result);
}

async function seed(ctx, packageRoot) {
  assert(
    packageRoot && path.isAbsolute(packageRoot),
    "Seed requires the installed published package root",
  );
  const manifest = readJson(path.join(packageRoot, "package.json"));
  assert.equal(manifest.name, "openclaw");
  assert.equal(manifest.version, "2026.9.4", "Fixture must be created by the published baseline");
  assert(!fs.existsSync(ctx.manifestPath), "Projects fixture was already seeded");
  for (const [file, expectedHash] of Object.entries(BASELINE_CHUNKS)) {
    assert.equal(
      digest(path.join(packageRoot, "dist", file)),
      expectedHash,
      `Published module changed: ${file}`,
    );
  }
  const workspace = path.join(ctx.root, "workspace");
  const registered = path.join(ctx.root, "registered");
  const sentinels = {};
  for (const [dir, text] of [
    [workspace, "workspace survives update — 東京\n"],
    [registered, "registered project survives update — λ\n"],
  ]) {
    fs.mkdirSync(dir, { recursive: true });
    assert(
      !fs.existsSync(path.join(dir, ".git")),
      "Projects fixture must not contain a Git checkout",
    );
    const file = path.join(dir, "PROJECTS-PROOF.txt");
    fs.writeFileSync(file, text, { flag: "wx" });
    sentinels[file] = digest(file);
  }
  const cfg = {
    gateway: {
      mode: "local",
      bind: "loopback",
      auth: { mode: "token", token: "projects-doctor-survivor-token" },
      controlUi: { enabled: false },
    },
    agents: { defaults: { workspace, heartbeat: { every: "0m" } } },
    plugins: { enabled: false },
  };
  fs.writeFileSync(ctx.configPath, `${JSON.stringify(cfg, null, 2)}\n`);
  const row = {
    id: "doctor-upgrade-registered",
    display_name: "Doctor upgrade inventory — 東京",
    repo_root: registered,
    origin_url: null,
    source: "registered",
    created_at_ms: 1789430400000,
    updated_at_ms: 1789430400000,
  };
  const load = (file) => import(pathToFileURL(path.join(packageRoot, "dist", file)).href);
  const state = await load("openclaw-state-db-m8z7pMTn.mjs");
  const { n: listProjectRegistry } = await load("project-registry-D_ymI9b-.mjs");
  const { i: getNodeSqliteKysely, n: executeSqliteQuerySync } = await load(
    "kysely-sync-CrjZjQJR.mjs",
  );
  const options = { path: ctx.databasePath, env: process.env };
  try {
    // The published list owner bootstraps its own schema without probing Git.
    const initial = listProjectRegistry(cfg, options);
    assert.equal(
      initial.length,
      1,
      "Expected only the configured workspace before fixture insertion",
    );
    assert.equal(initial[0].source, "workspace");
    state.runOpenClawStateWriteTransaction(
      ({ db }) => {
        executeSqliteQuerySync(db, getNodeSqliteKysely(db).insertInto("projects").values(row));
      },
      options,
      { operationLabel: "projects.upgrade.fixture" },
    );
    const inventory = listProjectRegistry(cfg, options);
    assert.equal(inventory.length, 2);
    assert.deepEqual(
      inventory.find((project) => project.id === row.id),
      {
        id: row.id,
        displayName: row.display_name,
        repoRoot: row.repo_root,
        source: row.source,
      },
    );
    assert.equal(inventory.find((project) => project.source === "workspace")?.repoRoot, workspace);
  } finally {
    state.closeOpenClawStateDatabaseByPath(ctx.databasePath);
  }
  assert.equal(
    state.isOpenClawStateDatabaseOpen(ctx.databasePath),
    false,
    "Published fixture writer did not close",
  );
  writeJson(ctx.manifestPath, {
    root: ctx.root,
    stateDir: ctx.stateDir,
    configPath: ctx.configPath,
    baselineVersion: manifest.version,
    baselineChunks: BASELINE_CHUNKS,
    row,
    workspace,
    sentinels,
  });
  await snapshot(ctx, "baseline", packageRoot);
}

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  const ctx = context();
  if (mode === "seed") {
    assert.equal(args.length, 1);
    await seed(ctx, args[0]);
  } else if (mode === "snapshot") {
    assert.equal(args.length, 2);
    await snapshot(ctx, args[0], args[1]);
  } else if (mode === "assert-doctor") {
    assert.equal(args.length, 3);
    const [reportPath, before, after] = args;
    assertProjectsDoctorResult(
      readJson(reportPath),
      readJson(snapshotPath(ctx, before)),
      readJson(snapshotPath(ctx, after)),
    );
    writeJson(path.join(ctx.artifacts, `projects-${after}-assertion.json`), {
      ok: true,
      before,
      after,
    });
  } else if (mode === "assert-final") {
    assert.equal(args.length, 0);
    for (const stage of STAGES) {
      assert(fs.existsSync(snapshotPath(ctx, stage)), `Missing Projects phase: ${stage}`);
    }
    for (const stage of ["after-doctor", "after-repeat"]) {
      assert.equal(readJson(path.join(ctx.artifacts, `projects-${stage}-assertion.json`)).ok, true);
    }
    const baseline = readJson(snapshotPath(ctx, "baseline"));
    const final = readJson(snapshotPath(ctx, "after-repeat"));
    assertProjectsInventory(final, baseline);
    writeJson(path.join(ctx.artifacts, "projects-doctor-result.json"), {
      ok: true,
      baselineVersion: "2026.9.4",
      storedProjects: final.rows.length,
      workspace: final.workspace,
      doctorInvocations: 2,
    });
  } else {
    throw new Error(`Unknown Projects Doctor fixture mode: ${mode}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
