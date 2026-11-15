import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync, closeSync, copyFileSync, existsSync, openSync, readFileSync, readdirSync,
  unlinkSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import nodeTest from "node:test";
import {
  names, linuxSkip, fixture, descriptor, call, ok, denied, invoke,
  dispatchReached, untouched, checkClosure, replace, fault, crashed,
} from "./retained-controller-adoption-test-support.mjs";

const test = (name, fn) => nodeTest(name, { skip: linuxSkip, timeout: 30000 }, fn);
const closure = f => names.map(name => descriptor(join(f.root, "installed", name)));

function historicalFixture(t, laterClosure = false) {
  const f = fixture(t);
  const first = ok(call(f, "prepare", f.request));
  ok(call(f, "apply", first));
  const previousPrefix = f.prefix;
  const historical = { gate: descriptor(f.gate), complete: descriptor(f.prefix + ".complete.json") };
  const oldGate = readFileSync(f.gate);
  const history = readdirSync(join(f.root, "serving/journal"))
    .filter(name => name.startsWith("repair-"))
    .map(name => descriptor(join(f.root, "serving/journal", name)));
  // A genuinely different retained V1 incident; history remains byte-for-byte intact.
  replace(f.request.source.path, Buffer.from(JSON.stringify({ ...f.record,
    process: { ...f.record.process, instance: "new-retained-incident", generation: "789" } }) + "\n"), 0o600);
  if (laterClosure) for (let i = 0; i < names.length; i++) {
    const path = join(f.root, "installed", names[i]);
    replace(path, Buffer.concat([readFileSync(path), Buffer.from(i ? "\n// reviewed later incumbent\n" : "\n# reviewed later incumbent\n")]), i ? 0o644 : 0o755);
  }
  f.oldBytes = names.map(name => readFileSync(join(f.root, "installed", name)));
  f.request = { ...f.request, operation: randomUUID(), source: descriptor(f.request.source.path), oldClosure: closure(f), historical };
  f.prefix = join(f.root, "serving/journal/repair-" + f.request.operation + ".adoption");
  f.protectedBefore = f.protectedNames.map(name => descriptor(join(f.root, name)));
  return Object.assign(f, { previousPrefix, oldGate, history });
}
function historyIntact(f) {
  for (const expected of f.history) assert.deepEqual(descriptor(expected.path), expected);
  untouched(f);
}
function fenced(f) { denied(invoke(f), /ENOENT|completion|durable artifact|installed closure/); }

for (const laterClosure of [false, true]) test("historical successor binds the new incident with " + (laterClosure ? "later reviewed" : "unchanged completed") + " incumbent", t => {
  const f = historicalFixture(t, laterClosure);
  const { historical, ...ordinary } = f.request;
  denied(call(f, "prepare", ordinary), /ENOENT|source|completion/);
  denied(call(f, "prepare", f.request), /historical|request/);
  const binding = ok(call(f, "historical-successor", f.request));
  assert.deepEqual(ok(call(f, "historical-successor", f.request)), binding);
  fenced(f); historyIntact(f);
  assert.deepEqual(readFileSync(f.prefix + ".predecessor-gate.json"), f.oldGate);
  for (let i = 0; i < names.length; i++) assert.deepEqual(readFileSync(f.prefix + ".backup-" + i), f.oldBytes[i]);
  const completed = ok(call(f, "apply", binding));
  assert.deepEqual(completed.source, f.request.source);
  assert.deepEqual(completed.closure, closure(f));
  assert.deepEqual(ok(call(f, "context", binding)), completed);
  assert.deepEqual(ok(call(f, "apply", binding)), completed);
  assert.deepEqual(ok(call(f, "historical-successor", f.request)), binding);
  checkClosure(f); dispatchReached(f); historyIntact(f);
});

const refusals = [
  ["missing historical approval", f => { delete f.request.historical; }, /historical|request/],
  ["extra historical field", f => { f.request.historical.extra = true; }, /historical|unexpected|keys/],
  ["retirement co-approval", f => { f.request.retirement = f.request.historical.complete; }, /historical|retirement|request/],
  ["unsafe incumbent mode", f => chmodSync(f.request.oldClosure[2].path, 0o666), /exact owner-safe regular file/],
  ["unsafe replacement mode", f => chmodSync(f.request.replacement[2].path, 0o666), /exact owner-safe regular file/],
  ["stale gate descriptor", f => { f.request.historical.gate.inode++; }, /historical|gate|descriptor/],
  ["stale completion descriptor", f => { f.request.historical.complete.inode++; }, /historical|completion|descriptor/],
  ["incomplete history", f => unlinkSync(f.previousPrefix + ".complete.json"), /ENOENT|completion/],
  ["tampered original history", f => writeFileSync(f.previousPrefix + ".original.json", "{}\n"), /artifact changed|archive/],
  ["tampered replacement history", f => writeFileSync(f.previousPrefix + ".replacement-2", "changed"), /artifact changed|closure/],
  ["stale current source", f => replace(f.request.source.path, readFileSync(f.request.source.path), 0o600), /source journal changed/],
  ["stale actual incumbent", f => replace(f.request.oldClosure[3].path, readFileSync(f.request.oldClosure[3].path), 0o644), /old closure changed/],
  ["ungated reviewed incumbent", f => {
    writeFileSync(f.request.oldClosure[0].path, "#!/usr/bin/env bash\nexit 0\n"); f.request.oldClosure = closure(f);
  }, /lacks the audited FD9/],
  ["replaced canonical lock", f => replace(f.env.OPENCLAW_TEAM_LOCK_FILE, "new lock\n", 0o600), /lock inode changed/],
  ["replacement drift", f => replace(f.request.replacement[3].path, readFileSync(f.request.replacement[3].path), 0o644), /approved replacement changed/],
];
for (const [name, mutate, pattern] of refusals) test("historical successor refuses " + name + " before publication", t => {
  const f = historicalFixture(t, true);
  mutate(f);
  const gate = descriptor(f.gate), incumbent = closure(f), source = descriptor(f.request.source.path);
  denied(call(f, "historical-successor", f.request), pattern);
  assert.deepEqual(descriptor(f.gate), gate);
  assert.deepEqual(closure(f), incumbent);
  assert.deepEqual(descriptor(f.request.source.path), source);
  assert.equal(existsSync(f.prefix + ".intent.json"), false);
});

test("historical successor cannot relabel same-incident authority", t => {
  const f = fixture(t), binding = ok(call(f, "prepare", f.request));
  ok(call(f, "apply", binding));
  const request = { ...f.request, operation: randomUUID(), oldClosure: closure(f),
    historical: { gate: descriptor(f.gate), complete: descriptor(f.prefix + ".complete.json") } };
  denied(call(f, "historical-successor", request), /historical|different|source|incident/);
  untouched(f);
});

for (const when of ["before", "after"]) test("historical gate handoff crash " + when + " rename replays the exact request", t => {
  const f = historicalFixture(t, true), preload = join(f.root, "gate-fault.mjs");
  writeFileSync(preload, `import fs from "node:fs"; import { syncBuiltinESMExports } from "node:module";
const rename = fs.renameSync;
fs.renameSync = function(from, to) {
  if (to !== ${JSON.stringify(f.gate)}) return rename.apply(this, arguments);
  if (${JSON.stringify(when)} === "before") process.exit(86);
  const result = rename.apply(this, arguments); process.exit(86); return result;
}; syncBuiltinESMExports();\n`, { mode: 0o600 });
  crashed(call(f, "historical-successor", f.request, { preload }));
  const intent = descriptor(f.prefix + ".intent.json");
  const staged = when === "before" ? descriptor(f.prefix + ".gate.next") : descriptor(f.gate);
  const changed = { ...f.request, oldClosure: f.request.oldClosure.map((d, i) => i ? d : { ...d, inode: d.inode + 1 }) };
  denied(call(f, "historical-successor", changed), /request|closure|artifact|conflict/);
  const binding = ok(call(f, "historical-successor", f.request));
  assert.deepEqual(descriptor(f.prefix + ".intent.json"), intent);
  assert.deepEqual(descriptor(f.gate), { ...staged, path: f.gate });
  ok(call(f, "apply", binding)); checkClosure(f); historyIntact(f);
});

for (let index = 1; index <= 4; index++) for (const when of ["before", "after"])
  test("historical successor crash " + when + " file rename " + index + " stays fenced and replays exact inodes", t => {
    const f = historicalFixture(t, true), binding = ok(call(f, "historical-successor", f.request));
    crashed(call(f, "apply", binding, { preload: fault(f, { type: "rename", index, when }) }));
    const before = closure(f), replaced = when === "after" ? index : index - 1;
    const step = JSON.parse(readFileSync(f.prefix + ".step-" + (index - 1) + ".json"));
    fenced(f); historyIntact(f);
    assert.deepEqual(ok(call(f, "historical-successor", f.request)), binding);
    ok(call(f, "apply", binding));
    for (let i = 0; i < replaced; i++) assert.deepEqual(descriptor(before[i].path), before[i]);
    assert.deepEqual(descriptor(step.to.path), step.to);
    checkClosure(f); historyIntact(f);
  });

test("historical completion cannot authorize mixed installed files or a stale library", t => {
  const f = historicalFixture(t, true), stale = join(f.root, "stale-library.mjs");
  copyFileSync(f.env.OPENCLAW_TEAM_RELEASE_LIB, stale);
  const binding = ok(call(f, "historical-successor", f.request)); ok(call(f, "apply", binding));
  denied(invoke(f, stale), /old controller library is excluded/);
  replace(f.env.OPENCLAW_TEAM_RELEASE_LIB, readFileSync(stale), 0o644);
  denied(invoke(f), /completion does not match/);
  historyIntact(f);
});

test("a shell already waiting across historical adoption cannot enter its replacement closure", async t => {
  const f = historicalFixture(t);
  let fd = openSync(f.env.OPENCLAW_TEAM_LOCK_FILE, "r+");
  const stdio = () => ["pipe", "pipe", "pipe", "ignore", "ignore", "ignore", "ignore", "ignore", "ignore", fd];
  assert.equal(spawnSync("flock", ["-n", "9"], { stdio: stdio() }).status, 0);
  const close = () => { if (fd !== undefined) { closeSync(fd); fd = undefined; } };
  t.after(close);
  const child = spawn("bash", [f.env.OPENCLAW_TEAM_DEPLOY_EXECUTABLE], { env: f.env });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  let stdout = "", stderr = "";
  const waiting = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", code => reject(new Error(`shell exited before lock wait (${code}): ${stderr}`)));
    child.stdout.on("data", bytes => { stdout += bytes; if (stdout.includes("DEPLOY_LOCK_WAIT")) resolve(); });
    child.stderr.on("data", bytes => { stderr += bytes; });
  });
  const completed = new Promise(resolve => child.once("close", (code, signal) => resolve({ code, signal })));
  await waiting;
  const adopt = (action, input) => spawnSync(process.execPath,
    [f.runner, "retained-controller-adoption", action, f.env.OPENCLAW_TEAM_RELEASE_ROOT, "@stdin"],
    { env: f.env, stdio: stdio(), input: JSON.stringify(input), encoding: "utf8", timeout: 15000 });
  const binding = ok(adopt("historical-successor", f.request)); ok(adopt("apply", binding));
  close();
  const result = await completed;
  assert.equal(result.signal, null); assert.notEqual(result.code, 0);
  assert.match(stderr, /old controller executable is excluded/);
  assert.doesNotMatch(stdout, /CONTROLLER_CLOSURE_READY/);
  historyIntact(f);
});
