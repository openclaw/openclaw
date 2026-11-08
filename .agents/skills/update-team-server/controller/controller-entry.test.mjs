import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { descriptor, fixture, linuxSkip, names, ok, untouched } from "./retained-controller-adoption-test-support.mjs";

// Real Bash, library, flock and procfs; only the service population is synthetic.
// Admission deliberately stops at the populated maintenance cgroup before effects.
function entryFixture(t) {
  const f = fixture(t);
  if (process.env.CONTROLLER_ENTRY_TEST_SOURCE) {
    for (const name of names.slice(0, 2)) {
      const bytes = readFileSync(join(process.env.CONTROLLER_ENTRY_TEST_SOURCE, name));
      for (const directory of ["installed", "approved"]) writeFileSync(join(f.root, directory, name), bytes);
    }
    f.request.oldClosure = names.map(name => descriptor(join(f.root, "installed", name)));
    f.request.replacement = names.map(name => descriptor(join(f.root, "approved", name)));
  }
  const cgroup = join(f.root, "sys/fs/cgroup/system.slice/openclaw-hourly-health-check.service");
  mkdirSync(cgroup, { recursive: true, mode: 0o755 });
  writeFileSync(join(cgroup, "cgroup.events"), "populated 1\nfrozen 0\n");
  return f;
}

function holdLock(t, f) {
  let fd = openSync(f.env.OPENCLAW_TEAM_LOCK_FILE, "r+");
  const stdio = () => ["pipe", "pipe", "pipe", "ignore", "ignore", "ignore", "ignore", "ignore", "ignore", fd];
  const locked = spawnSync("flock", ["-n", "9"], { stdio: stdio(), encoding: "utf8" });
  assert.equal(locked.status, 0, locked.stderr);
  const close = () => { if (fd !== undefined) { closeSync(fd); fd = undefined; } };
  t.after(close);
  return { stdio, close };
}

function launch(t, f, args = []) {
  const child = spawn("bash", [f.env.OPENCLAW_TEAM_DEPLOY_EXECUTABLE, ...args], { env: f.env });
  const output = { stdout: "", stderr: "" };
  let waited;
  const waiting = new Promise((resolve, reject) => {
    waited = resolve;
    child.once("error", reject);
    child.once("exit", code => reject(new Error(`controller exited before lock wait (${code}): ${output.stderr}`)));
  });
  child.stdout.on("data", bytes => {
    output.stdout += bytes;
    if (output.stdout.includes("DEPLOY_LOCK_WAIT")) waited();
  });
  child.stderr.on("data", bytes => { output.stderr += bytes; });
  const completed = new Promise(resolve => child.once("close", (code, signal) => resolve({ ...output, code, signal })));
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  return { waiting, completed, output };
}

test("ordinary deployment waits for the real lock, then validates closure before admission", { skip: linuxSkip, timeout: 10000 }, async t => {
  const f = entryFixture(t), lock = holdLock(t, f), child = launch(t, f);
  await child.waiting;
  assert.doesNotMatch(child.output.stdout, /CONTROLLER_CLOSURE_READY/);
  lock.close();
  const result = await child.completed;
  assert.equal(result.signal, null);
  assert.notEqual(result.code, 0);
  assert.match(result.stdout, /CONTROLLER_CLOSURE_READY/);
  assert.match(result.stderr, /health-check work has not settled/);
  untouched(f);
});

for (const args of [
  ["--prepare-release", "b".repeat(40)],
  ["--prepare-retained-repair", "11111111-1111-4111-8111-111111111111", "c".repeat(40), "b".repeat(40), "111", "1110", "a".repeat(64), "d".repeat(64)],
]) test(`${args[0]} refuses contention without waiting or entering proofs`, { skip: linuxSkip, timeout: 10000 }, t => {
  const f = entryFixture(t);
  holdLock(t, f);
  const result = spawnSync("bash", [f.env.OPENCLAW_TEAM_DEPLOY_EXECUTABLE, ...args],
    { env: f.env, encoding: "utf8", timeout: 2000 });
  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /canonical deployment lock is busy/);
  assert.doesNotMatch(result.stdout, /DEPLOY_LOCK_WAIT|CONTROLLER_CLOSURE_READY/);
  untouched(f);
});

test("an executable already waiting across adoption cannot enter the replacement closure", { skip: linuxSkip, timeout: 15000 }, async t => {
  const f = entryFixture(t), lock = holdLock(t, f), child = launch(t, f);
  await child.waiting;
  // Adoption inherits the held open-file description; the waiting executable
  // keeps its actual old Bash fd255 while the canonical paths are replaced.
  const adopt = (action, input) => spawnSync(process.execPath,
    [f.runner, "retained-controller-adoption", action, f.env.OPENCLAW_TEAM_RELEASE_ROOT, "@stdin"],
    { env: f.env, stdio: lock.stdio(), input: JSON.stringify(input), encoding: "utf8", timeout: 5000 });
  const binding = ok(adopt("prepare", f.request));
  ok(adopt("apply", binding));
  lock.close();
  const result = await child.completed;
  assert.equal(result.signal, null);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /old controller executable is excluded/);
  assert.doesNotMatch(result.stdout, /CONTROLLER_CLOSURE_READY/);
  assert.doesNotMatch(result.stderr, /health-check work has not settled/);
  untouched(f);
});
