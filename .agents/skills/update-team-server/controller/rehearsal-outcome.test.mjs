import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const source = fs.readFileSync(new URL("./release-lib.mjs", import.meta.url), "utf8");
function declaration(name, next) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf(`\nfunction ${next}(`, start);
  assert.ok(start >= 0 && end > start, "existing owner declaration must be present");
  return source.slice(start, end);
}
const start = source.indexOf("  function run(label, command) {");
const end = source.indexOf("\n  if (profile.config) {", start);
assert.ok(start >= 0 && end > start, "existing rehearsal runner must be present");
// Execute unchanged owner bodies without a production export or a fake migration.
// Only the spawn boundary scales the fixed deadline; filesystem publication stays real.
const runner = new Function("spawnSync", "directory", "argv", "fs", "randomUUID", "join", "dirname", `
  const { openSync, closeSync, fsyncSync, constants, fchmodSync, writeFileSync, linkSync, unlinkSync } = fs;
  const doctorTimeoutMs = 2_400_000;
  ${declaration("reject", "integer")}
  ${declaration("syncPath", "releaseFootprint")}
  ${declaration("migrationWriteExclusive", "migrationRecoverPublications")}
  ${source.slice(start, end)}
  return run;
`);

for (const [label, kind, script, expected] of [
  ["doctor", "success", "process.stdout.write('private stdout');process.stderr.write('private stderr')", { status: 0, signal: null, errorCode: null }],
  ["verify", "nonzero", "process.stderr.write('private failure detail');process.exit(17)", { status: 17, signal: null, errorCode: null }],
  ["plan", "signal", "process.kill(process.pid,'SIGTERM')", { status: null, signal: "SIGTERM", errorCode: null }],
  ["plan-check", "timeout", "setInterval(()=>{},1000)", { status: null, signal: "SIGKILL", errorCode: "ETIMEDOUT" }],
  ["config", "spawn-error", "", { status: null, signal: null, errorCode: "ENOENT" }],
]) test(`rehearsal ${label} retains genuine ${kind} without private child data`, t => {
  const directory = fs.mkdtempSync(join(tmpdir(), "rehearsal-outcome-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const argv = ["--synthetic-namespace-boundary"];
  let observed;
  const run = runner((executable, args, options) => {
    assert.equal(executable, "/usr/bin/bwrap");
    assert.deepEqual(args, [...argv, "-e", script]);
    assert.equal(options.timeout, label === "doctor" ? 2_400_000 : 600_000, "phase must retain its owner deadline");
    assert.equal(options.killSignal, "SIGKILL");
    const childExecutable = kind === "spawn-error" ? join(directory, "missing-private-executable") : process.execPath;
    observed = spawnSync(childExecutable, args.slice(argv.length), {
      ...options, timeout: kind === "timeout" ? 100 : 5_000,
    });
    return observed;
  }, directory, argv, fs, randomUUID, join, dirname);
  if (kind === "success") run(label, ["-e", script]);
  else assert.throws(() => run(label, ["-e", script]), /isolated copied-state .* failed; private logs retained/);
  const pathname = join(directory, `${label}.outcome.json`);
  const bytes = fs.readFileSync(pathname, "utf8"), outcome = JSON.parse(bytes);
  assert.deepEqual(Object.keys(outcome).sort(), ["elapsedMs", "errorCode", "phase", "signal", "status", "timeoutMs", "version"]);
  assert.deepEqual({ status: observed.status, signal: observed.signal, errorCode: observed.error?.code ?? null }, expected);
  assert.deepEqual({ status: outcome.status, signal: outcome.signal, errorCode: outcome.errorCode }, expected);
  assert.equal(outcome.phase, label);
  assert.equal(outcome.version, 1);
  assert.equal(outcome.timeoutMs, label === "doctor" ? 2_400_000 : 600_000);
  assert.ok(Number.isFinite(outcome.elapsedMs) && outcome.elapsedMs >= 0);
  assert.equal(fs.statSync(pathname).mode & 0o777, 0o600);
  assert.equal(fs.statSync(pathname).nlink, 1);
  assert.doesNotMatch(bytes, /private|argv|stdout|stderr|environment|synthetic-namespace/);
  if (kind === "success") {
    assert.equal(fs.readFileSync(join(directory, `${label}.stdout`), "utf8"), "private stdout");
    assert.equal(fs.readFileSync(join(directory, `${label}.stderr`), "utf8"), "private stderr");
  }
});
