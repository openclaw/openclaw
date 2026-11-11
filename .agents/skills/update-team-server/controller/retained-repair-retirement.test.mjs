import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { descriptor, ready, test } from "./retained-repair-lifecycle-test-support.mjs";
import { completed, interruptedRetirement, retire } from "./retained-repair-retirement-test-support.mjs";

function success(result) {
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout.trim().split("\n").at(-1));
}
function replaceLink(path, target) {
  const saved = path + ".retirement-test";
  renameSync(path, saved); symlinkSync(target, path);
  return () => { unlinkSync(path); renameSync(saved, path); };
}
function replaceBytes(path, change) {
  const bytes = readFileSync(path);
  writeFileSync(path, change(bytes));
  return () => writeFileSync(path, bytes);
}

test("completed retained repair retires its exact journal without discarding acceptance or history", t => {
  const f = ready(t), state = completed(f), before = readFileSync(f.journal);
  // Stop at the next deployment's external Git boundary: no build/network or
  // second deployment is needed to prove the retained slot no longer blocks it.
  const dispatch = join(f.root, "ordinary-dispatch");
  writeFileSync(join(f.commands, "git"), '#!/bin/bash\n: > ' + JSON.stringify(dispatch) + '\nexit 64\n', { mode: 0o755 });
  const ordinary = () => spawnSync("bash", [f.env.OPENCLAW_TEAM_DEPLOY_EXECUTABLE], {
    env: { ...f.env, OPENCLAW_TEAM_BUSCTL: f.commandPaths.busctl, OPENCLAW_TEAM_SYSTEMCTL: f.commandPaths.systemctl },
    encoding: "utf8", timeout: 30000,
  });
  const blocked = ordinary();
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /activation journal/);
  assert.equal(existsSync(dispatch), false);
  const receipt = success(retire(f, state, { shell: true }));
  assert.equal(receipt.kind, "retained-repair-retirement");
  assert.equal(receipt.operation, f.request.operation);
  assert.equal(existsSync(f.journal), false);
  const archive = join(f.serving, "journal", "retired-repair-" + f.request.operation);
  assert.deepEqual(readFileSync(join(archive, "activation.json")), before);
  assert.deepEqual(readFileSync(state.record.lifecycle.verified.acceptance.path), readFileSync(join(archive, state.record.lifecycle.verified.acceptance.path.split("/").at(-1))));
  assert.deepEqual(success(retire(f, state)), receipt);
  const admitted = ordinary();
  assert.ifError(admitted.error);
  assert.equal(existsSync(dispatch), true, admitted.stderr);
  assert.doesNotMatch(admitted.stderr, /activation journal/);
});

test("retirement refuses changed operation, journal, live generation, pointers, acceptance and lock", async t => {
  const f = ready(t), state = completed(f), before = readFileSync(f.journal);
  const acceptance = state.record.lifecycle.verified.acceptance.path;
  const cases = [
    ["different operation", () => ({ operation: randomUUID() }), /operation|journal/],
    ["different completed digest", () => ({ hash: "0".repeat(64) }), /hash|bytes|digest|journal/],
    ["noncompleted phase", () => {
      const previous = JSON.parse(readFileSync(f.prefix + ".transition-10.json")).next;
      const restore = replaceBytes(f.journal, () => JSON.stringify(previous) + "\n");
      return { hash: descriptor(f.journal).sha256, restore };
    }, /COMPLETED|completed|terminal/],
    ["changed serving SHA", () => ({ restore: replaceLink(join(f.root, "proc", String(f.newPid), "cwd"), f.b) }), /release|generation|process|owner/],
    ["changed pid generation", () => ({ restore: replaceBytes(join(f.root, "proc", String(f.newPid), "stat"), bytes => bytes.toString().replace("5550", "5551")) }), /generation|owner|process/],
    ...["current", "previous"].map(name => [name + " pointer drift", () => ({ restore: replaceLink(join(f.serving, name), f.initial) }), /pointer|selected|target/]),
    ["missing acceptance", () => {
      renameSync(acceptance, acceptance + ".saved");
      return { restore: () => renameSync(acceptance + ".saved", acceptance) };
    }, /ENOENT|acceptance|artifact/],
    ["mismatched acceptance", () => ({ restore: replaceBytes(acceptance, bytes => bytes.toString().replace('"kind":"retained-repair-acceptance-receipt"', '"kind":"wrong-acceptance-receipt"')) }), /acceptance|artifact|changed/],
    ["replacement lock inode", () => {
      renameSync(f.lockFile, f.lockFile + ".saved"); writeFileSync(f.lockFile, "", { mode: 0o600 });
      return { restore: () => { unlinkSync(f.lockFile); renameSync(f.lockFile + ".saved", f.lockFile); } };
    }, /lock/],
  ];
  for (const [name, mutate, pattern] of cases) await t.test(name, () => {
    const { restore = () => {}, ...options } = mutate();
    try {
      const expected = readFileSync(f.journal), result = retire(f, state, options);
      assert.notEqual(result.status, 0, result.stdout);
      assert.match(result.stderr, pattern);
      assert.deepEqual(readFileSync(f.journal), expected);
    } finally { restore(); }
    assert.deepEqual(readFileSync(f.journal), before);
  });
  success(retire(f, state));
});

test("interrupted retirement replays before and after the atomic slot release", t => {
  const f = ready(t), state = completed(f), before = readFileSync(f.journal);
  const first = interruptedRetirement(f, state, "before");
  assert.equal(first.status, 86, first.stderr);
  assert.deepEqual(readFileSync(f.journal), before);
  const second = interruptedRetirement(f, state, "after");
  assert.equal(second.status, 86, second.stderr);
  assert.equal(existsSync(f.journal), false);
  const receipt = success(retire(f, state));
  assert.deepEqual(readFileSync(join(receipt.archive.path, "activation.json")), before);
  assert.deepEqual(JSON.parse(readFileSync(join(receipt.archive.path, "retirement.json"))), receipt);
  assert.deepEqual(success(retire(f, state)), receipt);
});
