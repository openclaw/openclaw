import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import nodeTest from "node:test";
import { makeReleaseFixture, events } from "./worker-config-owner-fixture.mjs";

// The production proof intentionally checks real Linux procfs, not a fixture lock flag.
const test = (name, fn) =>
  nodeTest(
    name,
    { skip: process.platform !== "linux" && "requires real Linux procfs flock proof" },
    fn,
  );

const shaB = "b".repeat(40),
  shaC = "c".repeat(40);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const descriptor = (path) => {
  const s = lstatSync(path);
  return { path, device: s.dev, inode: s.ino, sha256: digest(readFileSync(path)) };
};
function proof(f, ...args) {
  const r = spawnSync("bash", ["-c", 'exec 9<>"$OPENCLAW_TEAM_LOCK_FILE"; flock -n 9 || exit 75; exec "$@"', "retained-proof", process.execPath, f.library, ...args], { env: f.env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}
function call(f, action, input, { lock = true, preload } = {}) {
  const args = [
    ...(preload ? ["--import", preload] : []),
    f.library,
    "retained-repair-preparation",
    action,
    f.serving,
    "@stdin",
  ];
  return spawnSync(
    "bash",
    [
      "-c",
      lock === "unlocked"
        ? 'exec 9>"$OPENCLAW_TEAM_LOCK_FILE"; exec "$@"'
        : lock === "shared"
          ? 'exec 9>"$OPENCLAW_TEAM_LOCK_FILE"; flock -sn 9 || exit 75; exec "$@"'
          : lock
            ? 'exec 9>"$OPENCLAW_TEAM_LOCK_FILE"; flock -n 9 || exit 75; exec "$@"'
            : 'exec "$@"',
      "retained-test",
      process.execPath,
      ...args,
    ],
    { env: f.env, encoding: "utf8", input: JSON.stringify(input), timeout: 30000 },
  );
}
function success(f, action, input, options) {
  const r = call(f, action, input, options);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}
function fixture(t, { b = shaB, c = shaC } = {}) {
  const shaB = b,
    shaC = c;
  const f = makeReleaseFixture(t);
  const closure = join(f.root, "controller");
  mkdirSync(closure, { mode: 0o755 });
  for (const name of [
    "openclaw-release-deploy",
    "release-lib.mjs",
    "gateway-suspension-contract.mjs",
    "startup-profile.mjs",
  ]) {
    const source =
      name === "release-lib.mjs" && process.env.RETAINED_REPAIR_BASELINE_LIBRARY
        ? process.env.RETAINED_REPAIR_BASELINE_LIBRARY
        : join(import.meta.dirname, name);
    copyFileSync(source, join(closure, name));
    chmodSync(join(closure, name), name === "openclaw-release-deploy" ? 0o755 : 0o644);
  }
  writeFileSync(f.lockFile, "", { mode: 0o600 });
  f.library = join(closure, "release-lib.mjs");
  f.env.OPENCLAW_TEAM_RELEASE_LIB = f.library;
  f.env.OPENCLAW_TEAM_DEPLOY_EXECUTABLE = join(closure, "openclaw-release-deploy");
  f.b = f.addRelease(shaB);
  f.c = f.addRelease(shaC);
  unlinkSync(join(f.serving, "current"));
  symlinkSync(f.b, join(f.serving, "current"));
  symlinkSync(f.initial, join(f.serving, "previous"));
  unlinkSync(join(f.root, "proc", String(f.pid), "cwd"));
  symlinkSync(f.b, join(f.root, "proc", String(f.pid), "cwd"));
  unlinkSync(join(f.root, "proc", String(f.pid), "exe"));
  symlinkSync(process.execPath, join(f.root, "proc", String(f.pid), "exe"));
  const boot = join(f.root, "proc/sys/kernel/random");
  mkdirSync(boot, { recursive: true });
  writeFileSync(join(boot, "boot_id"), "11111111-1111-4111-8111-111111111111\n");
  const db = new DatabaseSync(f.agentDatabasePath);
  db.exec(
    "INSERT INTO session_windows VALUES ('synthetic-generation','agent:controller-test-agent:existing'); INSERT INTO transcript_rewrite_watermarks VALUES ('synthetic-generation','generation-one');",
  );
  db.close();
  f.witness = proof(f, "session-preservation-witness", f.initial, f.b, f.databasePath);
  f.originalPath = join(f.serving, "journal", "original-" + randomUUID() + ".json");
  writeFileSync(f.originalPath, JSON.stringify(f.witness), { mode: 0o600 });
  const { path, ...originalDescriptor } = descriptor(f.originalPath);
  f.record = {
    version: 1,
    phase: "ROLLBACK_FAILED",
    topology: "system",
    createdAt: "2026-01-01T00:00:00.000Z",
    predecessor: proof(f, "validate-release", f.initial, f.sha, String(process.getuid()), "sealed"),
    candidate: proof(f, "validate-release", f.b, shaB, String(process.getuid()), "sealed"),
    process: { pid: 99, generation: "990", instance: "historical-original-instance" },
    pointerTopology: {
      current: { present: true, sha: f.sha },
      previous: { present: false, sha: null },
    },
    services: {
      system: { unitFileState: "enabled", activeState: "active" },
      user: { unitFileState: "disabled", activeState: "inactive" },
    },
    suspension: { id: randomUUID(), expiresAtMs: 1, terminalPolicy: "preserve", status: "ready" },
    protectedPaths: proof(f, "fingerprint", f.config, f.databasePath),
    originalWitness: { name: path.split("/").at(-1), ...originalDescriptor },
  };
  writeFileSync(f.journal, JSON.stringify(f.record) + "\n", { mode: 0o600 });
  f.request = {
    version: 1,
    operation: randomUUID(),
    source: descriptor(f.journal),
    target: { sha: shaC, manifestSha256: descriptor(join(f.c, "deployment.json")).sha256 },
    process: { pid: f.pid, generation: f.start },
  };
  f.original = readFileSync(f.journal);
  f.originalWitness = readFileSync(f.originalPath);
  f.originalJournalIdentity = descriptor(f.journal);
  f.beforeConfig = descriptor(f.config);
  f.beforeDatabase = readFileSync(f.databasePath);
  f.beforeAgent = readFileSync(f.agentDatabasePath);
  return f;
}
function untouched(f) {
  assert.deepEqual(readFileSync(f.journal), f.original);
  assert.deepEqual(descriptor(f.journal), f.originalJournalIdentity);
  assert.deepEqual(readFileSync(f.originalPath), f.originalWitness);
  assert.equal(readlinkSync(join(f.serving, "current")), f.b);
  assert.equal(readlinkSync(join(f.serving, "previous")), f.initial);
  assert.doesNotMatch(events(f), /service\..*\.(stop|start|restart)|suspension|native\.update/);
}
function replace(path, bytes, mode = 0o600) {
  writeFileSync(path + ".new", bytes, { mode });
  renameSync(path + ".new", path);
}
function journal(f, change) {
  const value = JSON.parse(f.original);
  change(value);
  writeFileSync(f.journal, JSON.stringify(value));
  f.request.source = descriptor(f.journal);
}
function sealedReplace(path, change) {
  const value = JSON.parse(readFileSync(path));
  change(value);
  chmodSync(path, 0o644);
  writeFileSync(path, JSON.stringify(value));
  chmodSync(path, 0o444);
}
function addSession(f, key = "post-failure") {
  const db = new DatabaseSync(f.agentDatabasePath);
  const session = "session-" + key;
  db.prepare("INSERT INTO session_nodes VALUES (?,?,?,?,NULL)").run(
    "agent:controller-test-agent:" + key,
    session,
    JSON.stringify({ sessionId: session, updatedAt: 2 }),
    2,
  );
  db.prepare("INSERT INTO session_windows VALUES (?,?)").run(
    session,
    "agent:controller-test-agent:" + key,
  );
  db.prepare("INSERT INTO transcript_rewrite_watermarks VALUES (?,?)").run(
    session,
    "generation-" + key,
  );
  db.close();
}

export {
  test,
  fixture,
  call,
  success,
  untouched,
  descriptor,
  digest,
  addSession,
  replace,
  journal,
  sealedReplace,
};
