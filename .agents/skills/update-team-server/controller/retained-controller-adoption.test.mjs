import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, readlinkSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import nodeTest from "node:test";
import {
  base, names, linuxSkip, bootstrapSkip, fixture, descriptor, call, ok, denied,
  invoke, dispatchReached, executable, untouched, checkClosure, checkArchives,
  bridges, replace, fault, crashed, closeBootstrap, completeBootstrap,
  managedChild, waitLoaded, releaseChild,
} from "./retained-controller-adoption-test-support.mjs";

// Standalone: node --test --import ./test-environment.mjs retained-controller-adoption.test.mjs
// All fixture/source inputs are adjacent to this test; no frozen tree or scratch input.
// Root-only cases never manufacture a /proc proof. Pre-census fault cases and
// ordinary adoption still execute unprivileged against genuine Linux /proc.
const test = (name, fn) => nodeTest(name, { skip: linuxSkip, timeout: 30000 }, fn);
const rootTest = (name, fn) => nodeTest(name, { skip: bootstrapSkip, timeout: 30000 }, fn);
const oldRead = f => spawnSync(process.execPath, [f.env.OPENCLAW_TEAM_RELEASE_LIB, "journal-field", f.request.source.path, "phase"],
  { env: f.env, encoding: "utf8", timeout: 15000 });
function fenced(f) {
  for (const result of [invoke(f), executable(f)]) {
    denied(result);
    assert.doesNotMatch(result.stderr, /unknown release proof command:|health-check work has not settled/);
  }
}
function bootstrapArchives(f) {
  assert.deepEqual(readFileSync(f.bootstrapPrefix + ".original.json"), readFileSync(f.request.source.path));
  for (let i = 0; i < names.length; i++)
    assert.deepEqual(readFileSync(f.bootstrapPrefix + ".backup-" + i), f.oldBytes[i]);
}

test("adoption uses exact source bytes, preserves originals, and grants only completed closure admission", t => {
  const f = fixture(t);
  for (let i = 0; i < names.length; i++) assert.deepEqual(f.newBytes[i], readFileSync(join(base, names[i])));
  dispatchReached(f);
  const binding = ok(call(f, "prepare", f.request));
  assert.deepEqual(ok(call(f, "prepare", f.request)), binding);
  fenced(f); untouched(f); checkArchives(f);
  const context = ok(call(f, "apply", binding));
  assert.equal(context.kind, "retained-controller-adoption-context");
  assert.deepEqual(context.source, f.request.source);
  assert.deepEqual(ok(call(f, "context", binding)), context);
  assert.deepEqual(ok(call(f, "apply", binding)), context);
  checkClosure(f); checkArchives(f); dispatchReached(f);
  const shell = executable(f);
  denied(shell, /health-check work has not settled/);
  assert.match(shell.stdout, /CONTROLLER_CLOSURE_READY/); untouched(f);
});

for (const lock of ["none", "unlocked", "shared"]) test("real FD9 proof refuses " + lock + " ownership", t => {
  const f = fixture(t); denied(call(f, "prepare", f.request, { lock }));
  assert.equal(existsSync(f.gate), false); untouched(f);
});

test("synthetic gate-free canonical readers reproduce the old-reader gap and cannot skip bootstrap", async t => {
  const f = fixture(t, { legacy: true }), result = oldRead(f);
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), "ROLLBACK_FAILED");
  for (const shell of [false, true]) {
    const child = managedChild(t, f, { shell }); await waitLoaded(child);
    assert(readFileSync("/proc/" + child.pid + "/cmdline", "utf8").split("\0").includes(
      shell ? f.env.OPENCLAW_TEAM_DEPLOY_EXECUTABLE : f.env.OPENCLAW_TEAM_RELEASE_LIB));
    let waiting = false;
    for (let i = 0; i < 100; i++) {
      if (/pipe_read|unix_stream_data_wait|unix_stream_read_generic/.test(readFileSync("/proc/" + child.pid + "/wchan", "utf8"))) { waiting = true; break; }
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert(waiting, "the managed canonical reader must really be loaded and waiting on stdin");
    const [code] = await releaseChild(child); assert.equal(code, 0);
  }
  denied(call(f, "prepare", f.request), /lacks the audited FD9/);
  assert.equal(existsSync(f.gate), false); untouched(f);
});

for (const change of ["bytes", "inode"]) test("original journal " + change + " drift is not silently adopted", t => {
  const f = fixture(t), binding = ok(call(f, "prepare", f.request));
  if (change === "bytes") writeFileSync(f.request.source.path, JSON.stringify(f.record, null, 2));
  else replace(f.request.source.path, readFileSync(f.request.source.path), 0o600);
  denied(call(f, "apply", binding), /source journal changed/);
  assert.equal(existsSync(f.prefix + ".step-0.json"), false); fenced(f);
});

for (let index = 1; index <= 4; index++) for (const when of ["before", "after"])
  test("crash " + when + " successor rename " + index + " stays fenced and replays exact staged inodes", t => {
    const f = fixture(t), binding = ok(call(f, "prepare", f.request));
    crashed(call(f, "apply", binding, { preload: fault(f, { type: "rename", index, when }) }));
    const installed = names.map(n => descriptor(join(f.root, "installed", n)));
    const replaced = when === "after" ? index : index - 1;
    for (let i = 0; i < names.length; i++)
      assert.deepEqual(readFileSync(installed[i].path), i < replaced ? f.newBytes[i] : f.oldBytes[i]);
    const stagedStep = JSON.parse(readFileSync(f.prefix + ".step-" + (index - 1) + ".json"));
    fenced(f); untouched(f); checkArchives(f);
    ok(call(f, "apply", binding)); checkClosure(f); checkArchives(f); untouched(f);
    for (let i = 0; i < replaced; i++) assert.deepEqual(descriptor(installed[i].path), installed[i]);
    assert.deepEqual(descriptor(stagedStep.to.path), stagedStep.to);
  });

for (const suffix of [".request.json", ".intent.json", "controller-adoption.json"])
  test("prepare replays interrupted fixed publication " + suffix, t => {
    const f = fixture(t); crashed(call(f, "prepare", f.request, { preload: fault(f, { type: "link", suffix }) }));
    const binding = ok(call(f, "prepare", f.request));
    ok(call(f, "apply", binding)); checkClosure(f); checkArchives(f); untouched(f);
  });

test("completed publication is replayable without replacing the installed closure", t => {
  const f = fixture(t), binding = ok(call(f, "prepare", f.request));
  crashed(call(f, "apply", binding, { preload: fault(f, { type: "link", suffix: ".complete.json" }) }));
  const before = names.map(n => descriptor(join(f.root, "installed", n)));
  dispatchReached(f); ok(call(f, "apply", binding));
  assert.deepEqual(names.map(n => descriptor(join(f.root, "installed", n))), before); untouched(f);
});

test("successor adoption retains and validates its completed predecessor", t => {
  const f = fixture(t), first = ok(call(f, "prepare", f.request));
  ok(call(f, "apply", first));
  const previousGate = readFileSync(f.gate);
  const request = { ...f.request, operation: randomUUID(),
    oldClosure: names.map(name => descriptor(join(f.root, "installed", name))) };
  const second = ok(call(f, "prepare", request));
  fenced(f);
  const current = ok(call(f, "apply", second));
  assert.deepEqual(current.closure, names.map(name => descriptor(join(f.root, "installed", name))));
  dispatchReached(f); untouched(f);
  const archive = join(f.root, "serving/journal/repair-" + request.operation + ".adoption.predecessor-gate.json");
  assert.deepEqual(readFileSync(archive), previousGate);
  writeFileSync(archive, Buffer.concat([previousGate, Buffer.from("\n")]));
  denied(invoke(f), /durable artifact changed/);
});

test("missing fixed gate cannot reopen a partially installed closure", t => {
  const f = fixture(t), binding = ok(call(f, "prepare", f.request));
  crashed(call(f, "apply", binding, { preload: fault(f, { type: "rename", index: 2, when: "after" }) }));
  unlinkSync(f.gate); denied(invoke(f), /artifacts exist without their fixed gate/); fenced(f); untouched(f);
});

test("completed closure excludes an old library", t => {
  const f = fixture(t), stale = join(f.root, "retained-controller-adoption-test-stale.mjs");
  copyFileSync(f.env.OPENCLAW_TEAM_RELEASE_LIB, stale);
  const binding = ok(call(f, "prepare", f.request)); ok(call(f, "apply", binding));
  denied(invoke(f, stale), /old controller library is excluded/); checkArchives(f); untouched(f);
});

// These four deliberately stop BEFORE the root-only census. They prove the
// library-first bridge order on nonroot CI without claiming reader retirement.
for (let index = 1; index <= 2; index++) for (const when of ["before", "after"])
  test("pre-census bootstrap crash " + when + " bridge " + index + " enforces library-before-shell", t => {
    const f = fixture(t, { legacy: true });
    crashed(call(f, "bootstrap", f.request, { preload: fault(f, { type: "rename", index, when }) }));
    const installedLibrary = readFileSync(f.env.OPENCLAW_TEAM_RELEASE_LIB);
    const installedShell = readFileSync(f.env.OPENCLAW_TEAM_DEPLOY_EXECUTABLE);
    const libraryReplaced = index === 2 || when === "after";
    const shellReplaced = index === 2 && when === "after";
    assert.equal(installedLibrary.includes(Buffer.from("CONTROLLER_BOOTSTRAP_FENCED")), libraryReplaced);
    assert.equal(installedShell.includes(Buffer.from("CONTROLLER_BOOTSTRAP_FENCED")), shellReplaced);
    if (libraryReplaced) denied(oldRead(f), /CONTROLLER_BOOTSTRAP_FENCED/);
    else assert.equal(oldRead(f).stdout.trim(), "ROLLBACK_FAILED");
    if (!shellReplaced) assert.deepEqual(installedShell, f.oldBytes[0]);
    assert.equal(existsSync(f.bootstrapPrefix + ".closed.json"), false);
    denied(call(f, "prepare", f.request)); bootstrapArchives(f); untouched(f);
  });

rootTest("genuine root census closes both canonical paths and keeps the original closure archives", t => {
  const f = fixture(t, { legacy: true }); closeBootstrap(f);
  denied(oldRead(f), /CONTROLLER_BOOTSTRAP_FENCED/); denied(executable(f), /CONTROLLER_BOOTSTRAP_FENCED/);
  denied(invoke(f, f.runner), /bootstrap is incomplete/);
  completeBootstrap(f); dispatchReached(f); untouched(f);
});

for (const reader of ["library", "stopped-library", "shell"])
  rootTest("in-flight FD9-less canonical " + reader + " blocks closure until it exits", async t => {
    const f = fixture(t, { legacy: true }), stopped = reader === "stopped-library";
    const child = managedChild(t, f, { shell: reader === "shell" }); await waitLoaded(child);
    let fd9; try { fd9 = readlinkSync("/proc/" + child.pid + "/fd/9"); } catch (error) { assert.equal(error.code, "ENOENT"); }
    assert.notEqual(fd9, f.env.OPENCLAW_TEAM_LOCK_FILE);
    if (stopped) {
      child.kill("SIGSTOP");
      let observed = false;
      for (let i = 0; i < 100; i++) {
        if (/\) T /.test(readFileSync("/proc/" + child.pid + "/stat", "utf8"))) { observed = true; break; }
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert(observed, "SIGSTOP must be observed in genuine /proc before the census");
    }
    denied(call(f, "bootstrap", f.request), /old managed readers remain/);
    const before = bridges(f); assert.equal(existsSync(f.bootstrapPrefix + ".closed.json"), false);
    denied(call(f, "prepare", f.request)); untouched(f);
    await releaseChild(child, { stopped }); closeBootstrap(f);
    assert.deepEqual(bridges(f), before); completeBootstrap(f);
  });

for (let index = 1; index <= 2; index++) for (const when of ["before", "after"])
  rootTest("genuine root replays crash " + when + " bootstrap bridge " + index, t => {
    const f = fixture(t, { legacy: true });
    crashed(call(f, "bootstrap", f.request, { preload: fault(f, { type: "rename", index, when }) }));
    const before = bridges(f), replaced = index === 1 ? (when === "after" ? [1] : []) : (when === "after" ? [0, 1] : [1]);
    closeBootstrap(f); const after = bridges(f);
    for (const i of replaced) assert.deepEqual(after[i], before[i]);
    completeBootstrap(f);
  });

for (const suffix of ["controller-bootstrap.json", ".bootstrap.step-1.json", ".bootstrap.closed.json"])
  rootTest("genuine root settles interrupted bootstrap publication " + suffix, t => {
    const f = fixture(t, { legacy: true });
    crashed(call(f, "bootstrap", f.request, { preload: fault(f, { type: "link", suffix }) }));
    completeBootstrap(f);
  });

for (const index of [1, 2]) rootTest("bootstrapped successor crash after entrypoint " + index + " remains fenced and replays", t => {
  const f = fixture(t, { legacy: true }); closeBootstrap(f);
  const binding = ok(call(f, "prepare", f.request));
  crashed(call(f, "apply", binding, { preload: fault(f, { type: "rename", index, when: "after" }) }));
  const before = bridges(f); fenced(f); bootstrapArchives(f); untouched(f);
  ok(call(f, "apply", binding));
  for (let i = 0; i < index; i++) assert.deepEqual(bridges(f)[i], before[i]);
  checkClosure(f); checkArchives(f, { bootstrap: true }); untouched(f);
});

rootTest("retained exact approved library resumes bootstrap after the staging directory is gone", t => {
  const f = fixture(t, { legacy: true }); closeBootstrap(f);
  const runner = f.bootstrapPrefix + ".replacement-1.mjs";
  assert.deepEqual(readFileSync(runner), readFileSync(join(base, "release-lib.mjs")));
  rmSync(join(f.root, "approved"), { recursive: true });
  completeBootstrap(f, { runner });
});

rootTest("old-reader journal drift remains visible and cannot be rewound by bootstrap replay", async t => {
  const f = fixture(t, { legacy: true }), child = managedChild(t, f); await waitLoaded(child);
  denied(call(f, "bootstrap", f.request), /old managed readers remain/);
  const original = readFileSync(f.request.source.path), changed = Buffer.concat([original, Buffer.from("\n")]);
  writeFileSync(f.request.source.path, changed); await releaseChild(child);
  denied(call(f, "bootstrap", f.request), /source journal changed/);
  denied(call(f, "prepare", f.request));
  assert.deepEqual(readFileSync(f.request.source.path), changed);
  assert.deepEqual(readFileSync(f.bootstrapPrefix + ".original.json"), original);
  fenced(f);
});
