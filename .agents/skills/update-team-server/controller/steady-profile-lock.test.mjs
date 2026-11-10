import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { makeReleaseFixture } from "./worker-config-owner-fixture.mjs";

test("steady-profile release preflight keeps its deployment lock and namespace", {
  skip: process.platform !== "linux" || process.getuid() !== 0 ? "requires disposable Linux root and real flock" : false,
}, t => {
  const f = makeReleaseFixture(t);
  if (process.env.STEADY_PROFILE_TEST_LIBRARY) copyFileSync(process.env.STEADY_PROFILE_TEST_LIBRARY, f.library);
  const operation = "11111111-1111-4111-8111-111111111111";
  const namespace = "/var/lib/openclaw-team-diagnostics", diagnostics = join(f.root, "diagnostics");
  const directory = join(diagnostics, operation), observed = join(f.root, "validation-observed.json");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const locked = (args, options = {}) => spawnSync("bash", ["-c",
    'exec 9<>"$OPENCLAW_TEAM_LOCK_FILE"; flock -n 9 || exit 75; exec "$@"',
    "profile-lock-test", process.execPath, ...args], { env: f.env, encoding: "utf8", timeout: 10000, ...options });
  const validation = locked([f.library, "validate-release", f.initial, f.sha, "0", "sealed"]);
  assert.equal(validation.status, 0, validation.stderr);
  // Synthetic eligible-arm input reaches the capture preflight only. A deliberately
  // wrong library digest then refuses capture before native service or model work.
  const record = {
    operation, journal: join(f.serving, "journal"), releaseIdentity: JSON.parse(validation.stdout),
    intent: { mode: "steady", release: f.initial, bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() },
    arm: { state: "terminal-eligible", readinessSha256: "1".repeat(64), channelsSha256: "2".repeat(64) },
    librarySha256: "0".repeat(64),
  };
  writeFileSync(join(directory, "record.json"), JSON.stringify(record), { mode: 0o600 });
  const preload = join(f.root, "profile-observer.mjs");
  // Relocate only the fixed diagnostics directory. Lock fdinfo, release validation,
  // subprocess options and replies remain real; the spawn observer never changes them.
  writeFileSync(preload, `
import fs from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
const virtual = ${JSON.stringify(namespace)}, root = ${JSON.stringify(diagnostics)};
const map = path => typeof path === "string" && (path === virtual || path.startsWith(virtual + "/")) ? root + path.slice(virtual.length) : path;
for (const key of ["lstatSync", "openSync", "existsSync"]) {
  const original = fs[key]; fs[key] = (path, ...args) => original(map(path), ...args);
}
const realpath = fs.realpathSync;
fs.realpathSync = (path, ...args) => {
  const result = realpath(map(path), ...args);
  return result === root || result.startsWith(root + "/") ? virtual + result.slice(root.length) : result;
};
const spawn = childProcess.spawnSync;
childProcess.spawnSync = (file, args, options) => {
  const result = spawn(file, args, options);
  if (args.includes("validate-release")) fs.writeFileSync(${JSON.stringify(observed)}, JSON.stringify({ status: result.status, stdout: result.stdout, stderr: result.stderr }));
  return result;
};
syncBuiltinESMExports();
`);
  const result = locked(["--import", preload, f.library, "startup-profile", "capture-steady"], {
    input: JSON.stringify({ operation, root: f.serving, sha: f.sha, pid: process.pid, start: "1" }),
  });
  assert.ifError(result.error);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /startup profiling owner refused during capture-steady/);
  assert(existsSync(observed), result.stderr);
  const child = JSON.parse(readFileSync(observed));
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), record.releaseIdentity);
  assert.equal(existsSync(join(directory, "steady-request.json")), false);
});
