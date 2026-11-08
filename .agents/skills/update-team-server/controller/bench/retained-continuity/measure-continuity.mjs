// Synthetic owner-boundary measurement. Native process/service observations are fixture IO.
import assert from "node:assert/strict";
import cp from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  constants,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
const spawn = cp.spawnSync;
cp.spawnSync = (command, args, options = {}) =>
  spawn(command, args, { maxBuffer: 64 * 1024 * 1024, ...options });
syncBuiltinESMExports();
const { ready, build, descriptor } =
  await import("../../retained-repair-lifecycle-test-support.mjs");
const { scaleFixture } = await import("./scale-fixture.mjs");
const [arm, sample, mode, scenario = "rotation"] = process.argv.slice(2),
  alloc = mode === "alloc";
assert(["base", "candidate"].includes(arm));
assert(/^\d+$/.test(sample));
assert(["time", "alloc"].includes(mode));
assert(["rotation", "unchanged"].includes(scenario));
const cleanup = [];
const f = ready({ after: (fn) => cleanup.push(fn), diagnostic: console.log });
try {
  const shape = scaleFixture(f);
  if (!existsSync("/scale/template-agent.sqlite"))
    copyFileSync(f.agentDatabasePath, "/scale/template-agent.sqlite", constants.COPYFILE_FICLONE);
  if (arm === "base") copyFileSync("/base/release-lib.mjs", f.library);
  // Capture the entire original population through the native owner before
  // evolution, rather than timing only the fixture's initial one-tuple floor.
  const captured = cp.spawnSync(
    "bash",
    [
      "-c",
      'exec 9<>"$OPENCLAW_TEAM_LOCK_FILE"; flock -n 9 || exit 75; exec "$@"',
      "continuity-witness",
      process.execPath,
      f.library,
      "session-preservation-witness",
      f.initial,
      f.b,
      f.databasePath,
    ],
    { env: f.env, encoding: "utf8", timeout: 120000 },
  );
  assert.equal(captured.status, 0, captured.stderr);
  const witness = JSON.parse(captured.stdout);
  assert.equal(witness.length, 6000);
  writeFileSync(f.originalPath, JSON.stringify(witness));
  const { path, ...originalDescriptor } = descriptor(f.originalPath);
  f.record.originalWitness = { name: path.split("/").at(-1), ...originalDescriptor };
  writeFileSync(f.journal, JSON.stringify(f.record) + "\n");
  f.request.source = descriptor(f.journal);
  if (scenario === "rotation") {
    const db = new DatabaseSync(f.agentDatabasePath);
    const key = "agent:controller-test-agent:existing";
    db.exec("ALTER TABLE session_windows ADD COLUMN previous_session_id TEXT; BEGIN");
    for (const [sid, previous] of [
      ["rotation-one", "synthetic-generation"],
      ["rotation-two", "rotation-one"],
    ]) {
      db.prepare("INSERT INTO session_windows VALUES (?,?,?)").run(sid, key, previous);
      db.prepare("INSERT INTO transcript_rewrite_watermarks VALUES (?,?)").run(
        sid,
        "generation-" + sid,
      );
      db.prepare(
        "UPDATE session_nodes SET current_session_id=?,entry_json=?,updated_at=3 WHERE session_key=?",
      ).run(
        sid,
        JSON.stringify({ sessionId: sid, previousSessionId: previous, updatedAt: 3 }),
        key,
      );
    }
    db.exec("COMMIT");
    assert.equal(
      db
        .prepare("SELECT generation FROM transcript_rewrite_watermarks WHERE session_id=?")
        .get("synthetic-generation").generation,
      "generation-one",
    );
    db.close();
  }
  const librarySha256 = createHash("sha256").update(readFileSync(f.library)).digest("hex");
  const input = {
    operation: f.request.operation,
    target: f.request.target.sha,
    current: f.record.candidate.sha,
    pid: f.pid,
    generation: f.start,
    journalSha256: f.request.source.sha256,
  };
  f.request = build(f, "request", input);
  const original = readFileSync(f.journal),
    originalWitness = readFileSync(f.originalPath);
  const prefix =
    "/lane/scale-results/" + scenario + "-" + arm + "-" + sample + (alloc ? "-alloc" : "");
  const env = { ...f.env };
  if (alloc) {
    mkdirSync(prefix + ".alloc");
    env.NODE_OPTIONS = "--import /proof/bench/retained-continuity/alloc-profile.mjs";
    env.OPENCLAW_CONTINUITY_ALLOCATION_DIR = prefix + ".alloc";
  }
  const args = [
    "-c",
    'exec 9<>"$OPENCLAW_TEAM_LOCK_FILE"; flock -n 9 || exit 75; exec "$@"',
    "continuity-scale",
    "/usr/bin/time",
    "-v",
    "-o",
    prefix + ".time",
    process.execPath,
    "--no-warnings",
    "--import",
    f.preload,
    f.library,
    "retained-repair-build",
    "begin",
    f.serving,
    "@stdin",
  ];
  const start = performance.now();
  const result = cp.spawnSync("bash", args, {
    env,
    encoding: "utf8",
    input: JSON.stringify(f.request),
    timeout: 120000,
  });
  const wallMs = performance.now() - start;
  writeFileSync(prefix + ".stdout", result.stdout ?? "");
  writeFileSync(prefix + ".stderr", result.stderr ?? "");
  const refusal = arm === "base" && scenario === "rotation";
  assert.equal(result.status, refusal ? 2 : 0, result.stderr);
  if (refusal)
    assert.match(
      result.stderr,
      /retained preparation requires strict original and current transcript continuity/,
    );
  else {
    const prepared = JSON.parse(result.stdout);
    assert.equal(prepared.phase, "BUILD_PREPARED");
    const snapshot = JSON.parse(readFileSync(prepared.intent.path));
    assert.equal(snapshot.currentWitness.length, 6000);
    assert(
      snapshot.currentWitness.some(
        (encoded) =>
          JSON.parse(encoded)[5] ===
          (scenario === "rotation" ? "rotation-two" : "synthetic-generation"),
      ),
    );
  }
  assert.deepEqual(readFileSync(f.journal), original);
  assert.deepEqual(readFileSync(f.originalPath), originalWitness);
  const allocations = alloc
    ? readdirSync(prefix + ".alloc").map((p) =>
        JSON.parse(readFileSync(join(prefix + ".alloc", p))),
      )
    : [];
  const metrics = {
    arm,
    sample,
    scenario,
    allocationInstrumented: alloc,
    wallMs,
    status: result.status,
    shape,
    librarySha256,
    originalWitnessTuples: witness.length,
    rotations: scenario === "rotation" ? 2 : 0,
    originalGenerationRetained: true,
    allocations,
  };
  writeFileSync(prefix + ".json", JSON.stringify(metrics, null, 2) + "\n");
  console.log("MEASUREMENT", JSON.stringify(metrics));
} finally {
  for (const fn of cleanup.reverse()) fn();
}
