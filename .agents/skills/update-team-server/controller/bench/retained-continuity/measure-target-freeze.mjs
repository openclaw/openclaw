// Synthetic owner-boundary proof; native service/process observations are fixture IO.
import assert from "node:assert/strict";
import cp from "node:child_process";
import { createHash } from "node:crypto";
import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { scaleFixture } from "./scale-fixture.mjs";

const spawn = cp.spawnSync;
cp.spawnSync = (command, args, options = {}) =>
  spawn(command, args, { maxBuffer: 64 * 1024 * 1024, ...options });
syncBuiltinESMExports();
const { ready, descriptor, git, invoke } =
  await import("../../retained-repair-lifecycle-test-support.mjs");
const { retirementFixture } =
  await import("../../retained-repair-build-retirement-test-support.mjs");
const [arm, sample, mode, scenario = "target-advance"] = process.argv.slice(2);
assert(["base", "candidate"].includes(arm));
assert(/^\d+$/.test(sample));
assert(["time", "alloc"].includes(mode));
assert(["target-advance", "target-unchanged", "build-retirement"].includes(scenario));
const cleanup = [];
const f = ready({ after: (fn) => cleanup.push(fn), diagnostic: console.log });
try {
  const shape = scaleFixture(f);
  if (!existsSync("/scale/template-agent.sqlite"))
    copyFileSync(f.agentDatabasePath, "/scale/template-agent.sqlite", constants.COPYFILE_FICLONE);
  if (arm === "base") copyFileSync("/base/release-lib.mjs", f.library);
  const captured = cp.spawnSync(
    "bash",
    [
      "-c",
      'exec 9<>"$OPENCLAW_TEAM_LOCK_FILE"; flock -n 9 || exit 75; exec "$@"',
      "target-witness",
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
  const retirement = scenario === "build-retirement";
  if (retirement)
    retirementFixture({ after: (fn) => cleanup.push(fn), diagnostic: console.log }, f);
  const selected = f.request.target.sha;
  let frozenMain = selected;
  if (scenario === "target-advance" || retirement) {
    const tree = git(f.mirror, "rev-parse", selected + "^{tree}");
    frozenMain = git(f.mirror, "commit-tree", tree, "-p", selected, "-m", "synthetic main advance");
    git(f.mirror, "update-ref", "refs/remotes/origin/main", frozenMain);
    if (retirement) {
      const refused = invoke(f, "retained-repair-build", "origin", f.operation);
      assert.equal(refused.status, 2);
      assert.match(refused.stderr, /not the exact freshly frozen official main/);
    }
  }
  const useSelector = arm === "candidate" && scenario === "target-advance";
  const input = {
    operation: f.request.operation,
    target: useSelector ? "main" : selected,
    ...(useSelector ? { frozenMain } : {}),
    current: f.record.candidate.sha,
    pid: f.pid,
    generation: f.start,
    journalSha256: descriptor(f.journal).sha256,
  };
  const prefix = `/lane/scale-results/${scenario}-${arm}-${sample}${mode === "alloc" ? "-alloc" : ""}`;
  const requestPath = join(f.root, "build-request.json"),
    operationPath = join(f.root, "operation.json");
  writeFileSync(requestPath, JSON.stringify(retirement ? f.retirementRequest : input));
  writeFileSync(operationPath, JSON.stringify(f.operation));
  const original = readFileSync(f.journal),
    originalWitness = readFileSync(f.originalPath);
  const env = { ...f.env };
  if (mode === "alloc") {
    mkdirSync(prefix + ".alloc");
    env.NODE_OPTIONS = "--import /proof/bench/retained-continuity/alloc-profile.mjs";
    env.OPENCLAW_CONTINUITY_ALLOCATION_DIR = prefix + ".alloc";
  }
  const ownerCommand = retirement
    ? [
        "bash",
        "-Eeuo",
        "pipefail",
        "-c",
        'exec "$1" --no-warnings --import "$2" "$3" retained-controller-adoption retire-build "$4" @stdin < "$5"',
        "retirement-owner",
        process.execPath,
        f.preload,
        f.retirementRunner,
        f.serving,
        requestPath,
      ]
    : [
        "bash",
        "-Eeuo",
        "pipefail",
        "-c",
        'proof(){ "$1" --no-warnings --import "$2" "$3" retained-repair-build "$4" "$5" @stdin; }; ' +
          'request=$(proof "$1" "$2" "$3" request "$4" < "$5"); ' +
          'printf %s "$request" | proof "$1" "$2" "$3" begin "$4" > "$7"; ' +
          'proof "$1" "$2" "$3" origin "$4" < "$6"',
        "target-owners",
        process.execPath,
        f.preload,
        f.library,
        f.serving,
        requestPath,
        operationPath,
        prefix + ".begin.json",
      ];
  const start = performance.now();
  const result = cp.spawnSync(
    "bash",
    [
      "-c",
      'exec 9<>"$OPENCLAW_TEAM_LOCK_FILE"; flock -n 9 || exit 75; exec "$@"',
      "target-scale",
      "/usr/bin/time",
      "-v",
      "-o",
      prefix + ".time",
      ...ownerCommand,
    ],
    { env, encoding: "utf8", timeout: 120000 },
  );
  const wallMs = performance.now() - start;
  writeFileSync(prefix + ".stdout", result.stdout ?? "");
  writeFileSync(prefix + ".stderr", result.stderr ?? "");
  const refusal = arm === "base" && scenario !== "target-unchanged";
  assert.equal(result.status, refusal ? 2 : 0, result.stderr);
  if (retirement) {
    if (refusal) assert.match(result.stderr, /controller adoption only implements/);
    else {
      assert.equal(JSON.parse(result.stdout).phase, "BUILD_RETIRED");
      for (const original of f.retirementOriginals) {
        const archived = join(f.archive, original.path.split("/").at(-1));
        assert.equal(existsSync(original.path), false);
        assert.deepEqual(readFileSync(archived), original.bytes);
      }
    }
  } else {
    const prepared = JSON.parse(readFileSync(prefix + ".begin.json"));
    assert.equal(prepared.phase, "BUILD_PREPARED");
    const intent = JSON.parse(readFileSync(prepared.intent.path));
    assert.equal(intent.currentWitness.length, 6000);
    assert.equal(intent.request.target.sha, useSelector ? frozenMain : selected);
    if (refusal) assert.match(result.stderr, /not the exact freshly frozen official main/);
    else {
      const frozen = JSON.parse(result.stdout);
      assert.equal(frozen.phase, "ORIGIN_FROZEN");
      assert.equal(frozen.origin.target, frozenMain);
    }
  }
  assert.deepEqual(readFileSync(f.journal), original);
  assert.deepEqual(readFileSync(f.originalPath), originalWitness);
  const allocations =
    mode === "alloc"
      ? readdirSync(prefix + ".alloc")
          .map((p) => JSON.parse(readFileSync(join(prefix + ".alloc", p))))
          .filter((profile) => profile.argv[1].endsWith("/release-lib.mjs"))
      : [];
  assert.equal(
    allocations.length,
    mode === "alloc" ? (retirement ? (arm === "base" ? 1 : 2) : 3) : 0,
  );
  const metrics = {
    arm,
    sample,
    scenario,
    allocationInstrumented: mode === "alloc",
    wallMs,
    status: result.status,
    shape,
    selected,
    frozenMain,
    librarySha256: createHash("sha256")
      .update(readFileSync(retirement ? f.retirementRunner : f.library))
      .digest("hex"),
    allocations,
  };
  writeFileSync(prefix + ".json", JSON.stringify(metrics, null, 2) + "\n");
  console.log("MEASUREMENT", JSON.stringify(metrics));
} finally {
  for (const fn of cleanup.reverse()) fn();
}
