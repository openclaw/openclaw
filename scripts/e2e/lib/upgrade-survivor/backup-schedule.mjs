import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readJson } from "../fixtures/common.mjs";

const root = process.env.OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT;
const artifacts = process.env.OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT;
const stateDir = process.env.OPENCLAW_STATE_DIR;
const configPath = process.env.OPENCLAW_CONFIG_PATH;
assert(root && artifacts && stateDir && configPath, "Missing isolated survivor paths");
const repository = path.join(root, "git-backups");
const archive = path.join(root, "archive-backup.tar.gz");
const beforePath = path.join(artifacts, "backup-schedule-before.json");
const declarationKey = "openclaw-backup-scheduled";

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function cli(label, args, json = false) {
  const started = Date.now();
  const result = spawnSync("openclaw", args, {
    encoding: "utf8",
    timeout: 900_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  fs.writeFileSync(path.join(artifacts, `${label}.out`), result.stdout ?? "");
  fs.writeFileSync(path.join(artifacts, `${label}.err`), result.stderr ?? "");
  console.log(`${label}: exit=${result.status} durationMs=${Date.now() - started}`);
  assert.equal(result.status, 0, `${label} failed: ${result.stderr}\n${result.stdout}`);
  return json ? JSON.parse(result.stdout) : result.stdout;
}

function rpc(label, method, params = {}) {
  return cli(
    label,
    ["gateway", "call", method, "--params", JSON.stringify(params), "--json"],
    true,
  );
}

function schedule(label) {
  const result = cli(label, ["cron", "list", "--all", "--json"], true);
  const jobs = result.jobs.filter((job) => job.declarationKey === declarationKey);
  assert.equal(jobs.length, 1, "Expected exactly one Gateway-owned Git backup schedule");
  const job = jobs[0];
  assert.equal(job.enabled, true);
  assert.deepEqual(job.schedule.kind, "every");
  assert.equal(job.schedule.everyMs, 86_400_000);
  assert.equal(job.payload.kind, "command");
  assert.deepEqual(job.payload.argv, [
    "openclaw",
    "backup",
    "git",
    "create",
    "--repository",
    repository,
    "--all",
  ]);
  return { id: job.id, declarationKey: job.declarationKey, argv: job.payload.argv };
}

function ledgerRows() {
  const db = new DatabaseSync(path.join(stateDir, "state", "openclaw.sqlite"), { readOnly: true });
  try {
    return db
      .prepare(
        "SELECT id, created_at, archive_path, status, manifest_json FROM backup_runs ORDER BY created_at, id",
      )
      .all()
      .map((row) => Object.assign({}, row));
  } finally {
    db.close();
  }
}

function doctorErrors(label) {
  const report = cli(label, ["doctor", "--lint", "--json", "--severity-min", "error"], true);
  assert(report.checksRun > 0, "Doctor ran no checks");
  return report.findings.filter((finding) => finding.severity === "error");
}

function assertNoStorageConfig() {
  assert.equal(
    readJson(configPath).storage?.locations,
    undefined,
    "Upgrade wrote storage.locations",
  );
}

const mode = process.argv[2];
const packageRoot = process.argv[3];
if (mode === "configure") {
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, "MEMORY.md"), "Preserve this existing backup schedule.\n");
  for (const [key, value] of Object.entries({
    "gateway.mode": "local",
    "gateway.auth": { mode: "token", token: process.env.GATEWAY_AUTH_TOKEN_REF },
    "agents.defaults.workspace": workspace,
  })) {
    cli(`backup-config-${key}`, ["config", "set", key, JSON.stringify(value), "--strict-json"]);
  }
  cli("backup-baseline-doctor", ["doctor", "--fix", "--non-interactive"]);
  cli("backup-git-init", ["backup", "git", "init", "--repository", repository, "--json"], true);
  assertNoStorageConfig();
} else if (mode === "seed") {
  cli("backup-enable", ["backup", "enable", "--repository", repository, "--every", "24h"]);
  const original = schedule("backup-cron-before");
  cli(
    "backup-git-create",
    ["backup", "git", "create", "--repository", repository, "--all", "--json"],
    true,
  );
  cli("backup-archive-create", ["backup", "create", "--output", archive, "--json"], true);
  const rows = ledgerRows().filter(
    (row) => row.archive_path === repository || row.archive_path === archive,
  );
  assert.equal(rows.length, 2, "Baseline must record both Git and archive outcomes");
  assert(
    rows.every((row) => row.status === "ok"),
    "Baseline backups must succeed",
  );
  const errors = doctorErrors("backup-doctor-before");
  assertNoStorageConfig();
  const baseline = readJson(path.join(packageRoot, "dist", "build-info.json"));
  assert.equal(baseline.version, "2026.9.7");
  writeJson(beforePath, { baseline, schedule: original, rows, errors });
  console.log(
    `Seeded Git schedule ${original.declarationKey} and ${rows.length} successful ledger rows.`,
  );
} else if (mode === "assert") {
  const before = readJson(beforePath);
  assert.deepEqual(
    schedule("backup-cron-after"),
    before.schedule,
    "Upgrade changed schedule identity, declaration, or argv",
  );
  const status = rpc("backup-status-after", "backup.status");
  const active = status.schedules.find((entry) => entry.id === before.schedule.id);
  assert(active, "backup.status omitted the existing schedule");
  assert.equal(active.mode, "git");
  assert.equal(active.target, repository);
  assert.equal(active.enabled, true);
  assert.equal(active.everyMs, 86_400_000);
  for (const row of before.rows) {
    const target = status.targets.find((entry) => entry.latest.id === row.id);
    assert(target, `backup.status omitted pre-update row ${row.id}`);
    assert.equal(target.kind, row.archive_path === repository ? "git" : "archive");
    assert.equal(target.latest.archivePath, row.archive_path);
    assert.equal(target.latest.createdAt, row.created_at);
    assert.equal(target.latest.status, "ok");
    assert.equal(target.latestOk.id, row.id);
  }
  const rows = ledgerRows();
  for (const row of before.rows) {
    assert.deepEqual(
      rows.find((entry) => entry.id === row.id),
      row,
      "Upgrade rewrote a pre-update ledger row",
    );
  }
  const overview = cli("backup-overview-after", ["status"]);
  assert.match(overview, /Backups[^\n]*last ok/u, "openclaw status omitted successful backup line");
  const errors = doctorErrors("backup-doctor-after");
  assert.deepEqual(errors, before.errors, "Doctor introduced new errors");
  assertNoStorageConfig();
  assert.deepEqual(status.locations, [], "backup.status invented storage locations");
  const plugins = rpc("backup-plugins-after", "plugins.list");
  const cloudflare = plugins.plugins.find((entry) => entry.id === "cloudflare");
  assert(cloudflare, "Plugin inventory omitted bundled Cloudflare");
  assert(
    ["disabled", "unloaded"].includes(cloudflare.runtime?.state),
    "Cloudflare activated without an R2 location",
  );
  assert.equal(cloudflare.enabled, false, "Cloudflare became enabled");
  const result = {
    baseline: before.baseline,
    candidate: readJson(path.join(packageRoot, "dist", "build-info.json")),
    schedule: { ...before.schedule, mode: active.mode, preserved: true },
    ledgerRows: before.rows.map((row) => ({ id: row.id, preserved: true, visibleInStatus: true })),
    statusLine: overview.split("\n").find((line) => /Backups/u.test(line)),
    doctor: { baselineErrors: before.errors.length, candidateErrors: errors.length, newErrors: 0 },
    storageLocationsWritten: false,
    cloudflare: { enabled: cloudflare.enabled, runtime: cloudflare.runtime.state },
  };
  writeJson(path.join(artifacts, "backup-schedule.json"), result);
  console.log(JSON.stringify(result, null, 2));
} else {
  throw new Error("Expected configure, seed, or assert");
}
