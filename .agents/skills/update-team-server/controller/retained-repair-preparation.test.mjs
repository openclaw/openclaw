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
    { env: f.env, encoding: "utf8", input: JSON.stringify(input), timeout: 30000, maxBuffer: 16 * 1024 * 1024 },
  );
}
function success(f, action, input, options) {
  const r = call(f, action, input, options);
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}
function fixture(t) {
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

test("retained preparation seals exact raw legacy and dual continuity evidence without activation", (t) => {
  const f = fixture(t);
  addSession(f);
  const agentBefore = readFileSync(f.agentDatabasePath);
  const snapshot = success(f, "snapshot", f.request);
  assert.equal(snapshot.version, 2);
  assert.equal(snapshot.currentWitness.length, 2);
  const sealed = success(f, "seal", snapshot);
  assert.deepEqual(readFileSync(sealed.archives.original.path), f.original);
  assert.deepEqual(
    JSON.parse(readFileSync(sealed.archives.currentWitness.path)),
    snapshot.currentWitness,
  );
  const identity = descriptor(sealed.capsule.path);
  assert.deepEqual(success(f, "seal", snapshot), sealed);
  assert.deepEqual(success(f, "check", snapshot), sealed);
  assert.deepEqual(descriptor(sealed.capsule.path), identity);
  untouched(f);
  assert.deepEqual(descriptor(f.config), f.beforeConfig);
  assert.deepEqual(readFileSync(f.databasePath), f.beforeDatabase);
  assert.deepEqual(readFileSync(f.agentDatabasePath), agentBefore);
});

test("retained preparation requires actual flock and refuses unsupported lifecycle actions", (t) => {
  const f = fixture(t);
  for (const lock of [false, "unlocked", "shared"])
    assert.notEqual(call(f, "snapshot", f.request, { lock }).status, 0);
  assert.match(call(f, "activate", f.request).stderr, /does not implement activation/);
  untouched(f);
});

for (const [label, change] of [
  ["other phase", (r) => (r.phase = "C_CURRENT_SELECTED")],
  ["native owner even null", (r) => (r.nativeUpdate = null)],
  ["runtime change even null", (r) => (r.runtimeChange = null)],
  ["unknown owner field", (r) => (r.futureRecoveryOwner = "different")],
  ["missing original", (r) => delete r.originalWitness],
  ["same A B", (r) => (r.candidate = r.predecessor)],
  ["user topology", (r) => (r.topology = "migration-user")],
])
  test("retained preparation rejects " + label, (t) => {
    const f = fixture(t);
    journal(f, change);
    const before = readFileSync(f.journal);
    const r = call(f, "snapshot", f.request);
    assert.notEqual(r.status, 0, r.stdout);
    assert.deepEqual(readFileSync(f.journal), before);
    assert.equal(
      readdirSync(join(f.serving, "journal")).filter((n) => n.startsWith("repair-")).length,
      0,
    );
  });

for (const [label, mutate] of [
  ["journal bytes", (f) => writeFileSync(f.journal, Buffer.concat([f.original, Buffer.from(" ")]))],
  ["journal inode", (f) => replace(f.journal, f.original)],
  ["original witness", (f) => writeFileSync(f.originalPath, "[]")],
  [
    "current pointer inode",
    (f) => {
      unlinkSync(join(f.serving, "current"));
      symlinkSync(f.b, join(f.serving, "current"));
    },
  ],
  ["config bytes", (f) => writeFileSync(f.config, readFileSync(f.config, "utf8") + " ")],
  ["state identity", (f) => replace(f.databasePath, readFileSync(f.databasePath))],
  [
    "process birth",
    (f) => {
      const path = join(f.root, "proc", String(f.pid), "stat");
      writeFileSync(path, readFileSync(path, "utf8").replace("1110", "9999"));
    },
  ],
  [
    "boot",
    (f) =>
      writeFileSync(
        join(f.root, "proc/sys/kernel/random/boot_id"),
        "22222222-2222-4222-8222-222222222222",
      ),
  ],
  [
    "closure bytes",
    (f) => {
      const path = f.env.OPENCLAW_TEAM_DEPLOY_EXECUTABLE;
      writeFileSync(path, readFileSync(path, "utf8") + "\n# drift\n");
    },
  ],
  [
    "profile",
    (f) => {
      const p = JSON.parse(f.env.OPENCLAW_TEAM_OPERATOR_PROFILE);
      p.channels.push(["unexpected", "default"]);
      f.env.OPENCLAW_TEAM_OPERATOR_PROFILE = JSON.stringify(p);
    },
  ],
  [
    "target manifest inode",
    (f) => {
      const p = join(f.c, "deployment.json");
      chmodSync(f.c, 0o755);
      replace(p, readFileSync(p), 0o444);
      chmodSync(f.c, 0o555);
    },
  ],
])
  test("retained preparation refuses stale " + label + " before archive writes", (t) => {
    const f = fixture(t);
    const snapshot = success(f, "snapshot", f.request);
    mutate(f);
    const r = call(f, "seal", snapshot);
    assert.notEqual(r.status, 0, r.stdout);
    assert.equal(
      readdirSync(join(f.serving, "journal")).filter((n) => n.startsWith("repair-")).length,
      0,
    );
    assert.doesNotMatch(events(f), /service\..*\.(stop|start|restart)/);
  });

test("retained preparation rejects schema changes despite an internally matching manifest", (t) => {
  const f = fixture(t);
  for (const name of ["package.json", "deployment.json"])
    sealedReplace(join(f.c, name), (value) => {
      if (name === "package.json") value.openclaw.schemaVersions.state++;
      else value.schemaVersions.state++;
    });
  f.request.target.manifestSha256 = descriptor(join(f.c, "deployment.json")).sha256;
  const r = call(f, "snapshot", f.request);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /schema change/);
  untouched(f);
});

test("retained preparation never replaces captured original or B-era continuity with an empty baseline", (t) => {
  const f = fixture(t);
  addSession(f);
  const snapshot = success(f, "snapshot", f.request);
  const db = new DatabaseSync(f.agentDatabasePath);
  db.exec("DELETE FROM session_nodes WHERE current_session_id='session-post-failure'");
  db.close();
  const r = call(f, "seal", snapshot);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /strict original and current transcript continuity/);
  untouched(f);
});

test("retained preparation allows later live sessions without changing its captured floor", (t) => {
  const f = fixture(t);
  const snapshot = success(f, "snapshot", f.request);
  const result = success(f, "seal", snapshot);
  addSession(f, "later");
  assert.deepEqual(success(f, "check", snapshot), result);
  assert.equal(JSON.parse(readFileSync(result.archives.currentWitness.path)).length, 1);
  untouched(f);
});

for (const boundary of ["intent", "original", "witness", "capsule"])
  test("retained preparation resumes durable crash after " + boundary + " publication", (t) => {
    const f = fixture(t);
    const snapshot = success(f, "snapshot", f.request);
    const suffix = {
      intent: ".intent.json",
      original: ".original.json",
      witness: ".current-witness.json",
      capsule: ".prepared.json",
    }[boundary];
    const preload = join(f.root, "crash-preload.mjs");
    writeFileSync(
      preload,
      `import fs from "node:fs"; import { syncBuiltinESMExports } from "node:module";
const link=fs.linkSync; fs.linkSync=(from,to)=>{ link(from,to); if(String(to).endsWith(${JSON.stringify(suffix)})) process.kill(process.pid,"SIGKILL"); }; syncBuiltinESMExports();`,
    );
    const crashed = call(f, "seal", snapshot, { preload });
    assert.notEqual(crashed.status, 0);
    const published = join(f.serving, "journal", "repair-" + f.request.operation + suffix);
    assert.ok(existsSync(published), "crash must follow the actual hard-link publication");
    const before = descriptor(published);
    const result = success(f, "seal", snapshot);
    assert.deepEqual(descriptor(published), before);
    assert.deepEqual(success(f, "check", snapshot), result);
    untouched(f);
  });

test("retained preparation refuses conflicting interrupted artifacts without overwriting them", (t) => {
  const f = fixture(t);
  const snapshot = success(f, "snapshot", f.request);
  const path = join(f.serving, "journal", "repair-" + f.request.operation + ".original.json");
  writeFileSync(path, "unrelated", { mode: 0o600 });
  const before = descriptor(path);
  assert.notEqual(call(f, "seal", snapshot).status, 0);
  assert.deepEqual(descriptor(path), before);
  untouched(f);
});

test("retained preparation rejects a caller-forged empty or incomplete first floor", (t) => {
  const f = fixture(t);
  addSession(f);
  const snapshot = success(f, "snapshot", f.request);
  for (const currentWitness of [[], snapshot.currentWitness.slice(0, 1)]) {
    const r = call(f, "seal", { ...snapshot, currentWitness });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /fresh complete witness/);
  }
  assert.equal(
    readdirSync(join(f.serving, "journal")).filter((n) => n.startsWith("repair-")).length,
    0,
  );
  untouched(f);
});

test("retained preparation rejects growth before first intent instead of accepting a stale floor", (t) => {
  const f = fixture(t);
  const snapshot = success(f, "snapshot", f.request);
  addSession(f);
  const r = call(f, "seal", snapshot);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /fresh complete witness/);
  untouched(f);
});

test("retained preparation refuses a changed source between archive publications", (t) => {
  const f = fixture(t);
  const snapshot = success(f, "snapshot", f.request);
  const preload = join(f.root, "source-race.mjs");
  writeFileSync(
    preload,
    `import fs from "node:fs"; import { syncBuiltinESMExports } from "node:module";
const link=fs.linkSync; fs.linkSync=(a,b)=>{link(a,b);if(String(b).endsWith(".original.json"))fs.appendFileSync(${JSON.stringify(f.journal)}, " ");}; syncBuiltinESMExports();`,
  );
  const r = call(f, "seal", snapshot, { preload });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /source journal changed/);
  assert.equal(
    existsSync(join(f.serving, "journal", "repair-" + f.request.operation + ".prepared.json")),
    false,
  );
  assert.equal(readlinkSync(join(f.serving, "current")), f.b);
  assert.doesNotMatch(events(f), /service\..*\.(stop|start|restart)/);
});

for (const boundary of ["file", "directory"])
  test(
    "retained preparation fails closed and resumes after " + boundary + " fsync failure",
    (t) => {
      const f = fixture(t);
      const snapshot = success(f, "snapshot", f.request);
      const preload = join(f.root, "fsync-fault.mjs");
      writeFileSync(
        preload,
        `import fs from "node:fs"; import { syncBuiltinESMExports } from "node:module";
const sync=fs.fsyncSync; fs.fsyncSync=(fd)=>{const path=fs.readlinkSync("/proc/self/fd/"+fd); if(${JSON.stringify(boundary)}==="directory" ? path===${JSON.stringify(join(f.serving, "journal"))} : path.includes("repair-")&&path.includes(".next.")) throw new Error("fixture durability failure"); return sync(fd);};syncBuiltinESMExports();`,
      );
      const failed = call(f, "seal", snapshot, { preload });
      assert.notEqual(failed.status, 0);
      assert.match(failed.stderr, /fixture durability failure/);
      assert.equal(
        existsSync(join(f.serving, "journal", "repair-" + f.request.operation + ".prepared.json")),
        false,
      );
      success(f, "seal", snapshot);
      untouched(f);
    },
  );

test("retained preparation preserves rotated generations only through exact immutable archives", (t) => {
  const f = fixture(t);
  const snapshot = success(f, "snapshot", f.request);
  const result = success(f, "seal", snapshot);
  const db = new DatabaseSync(f.agentDatabasePath);
  const blob = Buffer.from("synthetic immutable transcript generation");
  db.prepare("INSERT INTO session_transcript_archives VALUES (?,?,?,?,?,?)").run(
    "synthetic-generation",
    "generation-one",
    "agent:controller-test-agent:existing",
    blob,
    digest(blob),
    "identity",
  );
  db.prepare("UPDATE session_nodes SET current_session_id=?, entry_json=? WHERE session_key=?").run(
    "rotated-session",
    JSON.stringify({ sessionId: "rotated-session", updatedAt: 3 }),
    "agent:controller-test-agent:existing",
  );
  db.exec(
    "INSERT INTO session_windows VALUES ('rotated-session','agent:controller-test-agent:existing'); INSERT INTO transcript_rewrite_watermarks VALUES ('rotated-session','rotated-generation');",
  );
  db.close();
  assert.deepEqual(success(f, "check", snapshot), result);
  const corrupt = new DatabaseSync(f.agentDatabasePath);
  corrupt.exec("UPDATE session_transcript_archives SET archive_sha256='wrong'");
  corrupt.close();
  const rejected = call(f, "check", snapshot);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /strict original and current transcript continuity/);
  untouched(f);
});

test("retained preparation refuses incomplete current transcripts and oversized evidence", (t) => {
  const f = fixture(t);
  const snapshot = success(f, "snapshot", f.request);
  const oversized = { ...snapshot, profile: { ...snapshot.profile, excess: "x".repeat(512 * 1024) } };
  const large = call(f, "seal", oversized);
  assert.notEqual(large.status, 0);
  assert.match(large.stderr, /bounded capsule budget/);
  const db = new DatabaseSync(f.agentDatabasePath);
  db.prepare("INSERT INTO session_nodes VALUES (?,?,?,?,NULL)").run(
    "agent:controller-test-agent:incomplete",
    "incomplete-session",
    JSON.stringify({ sessionId: "incomplete-session", updatedAt: 4 }),
    4,
  );
  db.close();
  const incomplete = call(f, "snapshot", f.request);
  assert.notEqual(incomplete.status, 0);
  assert.match(incomplete.stderr, /incomplete current transcript witness/);
  assert.equal(
    readdirSync(join(f.serving, "journal")).filter((n) => n.startsWith("repair-")).length,
    0,
  );
  untouched(f);
});

test("retained preparation seals thousands of sessions with a witness larger than one MiB", (t) => {
  const f = fixture(t);
  const db = new DatabaseSync(f.agentDatabasePath);
  const node = db.prepare("INSERT INTO session_nodes VALUES (?,?,?,?,NULL)");
  const window = db.prepare("INSERT INTO session_windows VALUES (?,?)");
  const watermark = db.prepare("INSERT INTO transcript_rewrite_watermarks VALUES (?,?)");
  db.exec("BEGIN");
  for (let index = 0; index < 4096; index++) {
    const session = `synthetic-${index}-${"x".repeat(128)}`;
    const key = `agent:controller-test-agent:${session}`;
    node.run(key, session, JSON.stringify({ sessionId: session, updatedAt: 2 }), 2);
    window.run(session, key);
    watermark.run(session, `generation-${index}`);
  }
  db.exec("COMMIT");
  db.close();
  const snapshot = success(f, "snapshot", f.request);
  assert.equal(snapshot.currentWitness.length, 4097);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot.currentWitness)) > 1024 * 1024);
  const sealed = success(f, "seal", snapshot);
  assert.deepEqual(JSON.parse(readFileSync(sealed.archives.currentWitness.path)), snapshot.currentWitness);
  assert.deepEqual(success(f, "check", snapshot), sealed);
  untouched(f);
});

test("retained preparation preserves an empty metadata session and refuses unwatermarked content", (t) => {
  const f = fixture(t);
  addSession(f, "empty");
  const db = new DatabaseSync(f.agentDatabasePath);
  const tiers = ["transcript_events", "session_transcript_cold_archives", "session_transcript_cold_archive_chunks"];
  for (const table of tiers) db.exec(`CREATE TABLE ${table} (session_id TEXT)`);
  db.exec("DELETE FROM transcript_rewrite_watermarks WHERE session_id='session-empty'");
  db.close();
  const snapshot = success(f, "snapshot", f.request);
  assert.deepEqual(JSON.parse(snapshot.currentWitness.find(value => JSON.parse(value)[5] === "session-empty")).slice(4),
    ["agent:controller-test-agent:empty", "session-empty", "agent:controller-test-agent:empty", null]);
  const sealed = success(f, "seal", snapshot);
  for (const table of [...tiers, "session_transcript_archives"]) {
    const writer = new DatabaseSync(f.agentDatabasePath);
    writer.prepare(`INSERT INTO ${table} (session_id) VALUES (?)`).run("session-empty");
    writer.close();
    const rejected = call(f, "check", snapshot);
    assert.notEqual(rejected.status, 0, table);
    assert.match(rejected.stderr, /incomplete current transcript witness/);
    const cleanup = new DatabaseSync(f.agentDatabasePath);
    cleanup.prepare(`DELETE FROM ${table} WHERE session_id=?`).run("session-empty");
    cleanup.close();
  }
  const appended = new DatabaseSync(f.agentDatabasePath);
  appended.exec("INSERT INTO transcript_events VALUES ('session-empty'); INSERT INTO transcript_rewrite_watermarks VALUES ('session-empty','first-generation')");
  appended.close();
  assert.deepEqual(success(f, "check", snapshot), sealed);
  untouched(f);
});

for (const kind of ["symlink", "hardlink", "mode"])
  test("retained preparation rejects unsafe original " + kind, (t) => {
    const f = fixture(t),
      original = f.originalPath;
    if (kind === "symlink") {
      renameSync(original, original + ".saved");
      symlinkSync(original + ".saved", original);
    } else if (kind === "hardlink") {
      linkSync(original, original + ".alias");
    } else chmodSync(original, 0o644);
    assert.notEqual(call(f, "snapshot", f.request).status, 0);
    assert.deepEqual(readFileSync(f.journal), f.original);
  });
