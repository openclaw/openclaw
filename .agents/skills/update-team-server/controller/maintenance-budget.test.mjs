import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const source = fs.readFileSync(process.env.BUDGET_LIBRARY ?? new URL("./release-lib.mjs", import.meta.url), "utf8");
const shell = fs.readFileSync(new URL("./openclaw-release-deploy", import.meta.url), "utf8");
function declaration(name, next) {
  const start = source.indexOf(`function ${name}(`), end = source.indexOf(`\nfunction ${next}(`, start);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
}
function converter() {
  const start = source.indexOf("function migrationDoctorTimeout("), end = source.indexOf("\nasync function migrationRehearse(", start);
  assert.ok(start >= 0 && end > start);
  return new Function(`${declaration("reject", "integer")}\n${source.slice(start, end)}\nreturn migrationDoctorTimeout;`)();
}
function fixture(t, doctorTimeoutMs, config, scripts, timeouts) {
  const directory = fs.mkdtempSync(join(tmpdir(), "maintenance-budget-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const start = source.indexOf("  function run(label, command"), phases = source.indexOf("\n  if (profile.config) {", start);
  const end = source.indexOf("\n  const proof =", phases);
  assert.ok(start >= 0 && phases > start && end > phases);
  const calls = [];
  const invoke = new Function("spawnSync", "directory", "doctorTimeoutMs", "profile", "fs", "randomUUID", "join", "dirname", `
    const { openSync, closeSync, fsyncSync, constants, fchmodSync, writeFileSync, linkSync, unlinkSync } = fs;
    const argv = [], release = '/fixture-release', inputs = {};
    const configRepairCopiedInputs = value => value;
    ${declaration("reject", "integer")}
    ${declaration("syncPath", "releaseFootprint")}
    ${declaration("migrationWriteExclusive", "migrationRecoverPublications")}
    ${source.slice(start, phases)}
    return () => { ${source.slice(phases, end)} };
  `)((executable, args, options) => {
    assert.equal(executable, "/usr/bin/bwrap");
    const index = calls.length;
    assert.equal(options.timeout, timeouts[index], "actual owning child must receive selected per-phase budget");
    assert.equal(options.killSignal, "SIGKILL");
    calls.push({ args, timeoutMs: options.timeout });
    return spawnSync(process.execPath, ["-e", scripts[index] ?? ""], options);
  }, directory, doctorTimeoutMs, { config }, fs, randomUUID, join, dirname);
  return { invoke, calls, outcome: label => JSON.parse(fs.readFileSync(join(directory, `${label}.outcome.json`))), directory };
}

test("schema Doctor receives explicit owner budget; verifier remains 600 seconds", t => {
  const f = fixture(t, 2000, false, ["setTimeout(()=>process.stdout.write('done'),180)", ""], [2000, 600000]);
  f.invoke();
  assert.ok(f.calls[0].args.includes("doctor"));
  assert.ok(f.calls[1].args.includes("migration-copy-check"));
  assert.equal(f.outcome("doctor").timeoutMs, 2000);
  assert.equal(f.outcome("doctor").status, 0);
  assert.equal(f.outcome("verify").timeoutMs, 600000);
  assert.equal(f.outcome("verify").status, 0);
});

test("Doctor expiry retains genuine timeout and never starts verifier", t => {
  const f = fixture(t, 150, false, ["setInterval(()=>{},1000)"], [150]);
  assert.throws(f.invoke, /isolated copied-state doctor failed/);
  const outcome = f.outcome("doctor");
  assert.equal(outcome.timeoutMs, 150);
  assert.equal(outcome.status, null);
  assert.equal(outcome.signal, "SIGKILL");
  assert.equal(outcome.errorCode, "ETIMEDOUT");
  assert.equal(f.calls.length, 1);
  assert.equal(fs.existsSync(join(f.directory, "verify.outcome.json")), false);
});

test("config plan, check, commit and verifier keep 600 seconds", t => {
  const f = fixture(t, undefined, true, [], [600000, 600000, 600000, 600000]);
  f.invoke();
  for (const label of ["plan", "plan-check", "config", "verify"]) {
    assert.equal(f.outcome(label).timeoutMs, 600000);
    assert.equal(f.outcome(label).status, 0);
  }
});

test("finite positive native seconds syntax converts to bounded integer milliseconds", () => {
  const convert = converter();
  for (const [input, expected] of [["2400",2400000],["2.4e3",2400000],["+2400",2400000],["001.25",1250],
    [" .5",500],["1.",1000],["0x10",16000],["0x1p2",4000],["0x1.8p1",3000],["+0x1p2",4000],
    ["0x.8",500],["0x1.8",1500],["0.0001",1],["0x1p-1074",1],["0x1.000000000000081p0",1001]]) {
    const native = spawnSync("/usr/bin/timeout", [`${input}s`, "/usr/bin/true"]);
    assert.ok([0,124].includes(native.status), `${input} is accepted native numeric duration`);
    assert.equal(convert(input), expected, input);
  }
  for (const input of [undefined,"","0","-1","NaN","inf","Infinity","1e309","1e20","0x1p99999","0x0", "0x",
    "0.5 ","1,5","1_000","1d","0b10","0o10"]) assert.throws(() => convert(input), /Doctor budget/, String(input));
});

test("schema budget validation precedes copy work; config-only does not consume it", async () => {
  const start = source.indexOf("async function migrationRehearse("), end = source.indexOf("  const boundRecord =", start);
  assert.ok(start >= 0 && end > start);
  // Exercise the unchanged owner prefix at its copy boundary; no real journal or host state.
  let config = false;
  const prefix = new Function("migrationLoad", "migrationRecordProfile", "migrationDoctorTimeout", "process", "join", `
    ${declaration("reject", "integer")}
    ${declaration("integer", "rootGroup")}
    ${source.slice(start,end)}return 'copy-boundary';}\nreturn migrationRehearse;
  `)(() => ({ record: { candidate: { sha: "fixture" }, agentMigration: { phase: "rehearsal", artifacts: {} } } }),
    () => ({ config }), converter(), { platform: "linux", getuid: () => 0 }, join);
  await assert.rejects(prefix("journal", "/fixture", {}, "config", "database", "home", "1000", "1000", "0"), /Doctor budget/);
  config = true;
  assert.equal(await prefix("journal", "/fixture", {}, "config", "database", "home", "1000", "1000", "0"), "copy-boundary");
});

test("actual recovery shell passes owner budget without changing acceptance budget", () => {
  const start = shell.indexOf("recover_agent_schema_migration() {"), end = shell.indexOf("\n}\n", start) + 3;
  const definitions = shell.split("\n").filter(line => /^(build_budget|verification_budget)=/.test(line)).join("\n");
  const script = `set -eu\n${definitions}\n${shell.slice(start,end)}
proof() {
 case "$1" in
 migration-status) echo rehearsal;;
 journal-field) echo fixture;;
 migration-record-kind) echo agent-22-23;;
 migration-rehearse) printf 'BUDGET:%s ACCEPT:%s\\n' "\${@: -1}" "$verification_budget" >&2; return 77;;
 *) echo '{}';;
 esac
}
assert_protected_identity(){ :; }; migration_assert_inputs(){ :; }; migration_check_guard(){ :; }
id(){ test "$1" = -g && test "$2" = openclaw || return 1; printf '1000\\n'; }
journal_file=fixture; serving_root=/fixture; releases_root=/fixture/releases; root_uid=0
mirror=fixture; build_home=fixture; runtime_home=fixture; config_file=fixture; state_database=fixture
runtime_uid=1000; skip_migration_rehearsal=0
recover_agent_schema_migration
`;
  for (const [input, expected] of [[undefined,"2400"],["2.5","2.5"],["0x1p2","0x1p2"]]) {
    const env = { ...process.env }; delete env.OPENCLAW_TEAM_BUILD_BUDGET; delete env.OPENCLAW_TEAM_VERIFICATION_BUDGET;
    if (input !== undefined) env.OPENCLAW_TEAM_BUILD_BUDGET=input;
    const result = spawnSync("bash", ["-c", script], { env, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`BUDGET:${expected.replaceAll(".", "\\.")} ACCEPT:600`));
  }
});
