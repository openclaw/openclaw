import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { test, build, descriptor, invoke } from "./retained-repair-lifecycle-test-support.mjs";
import { untouched } from "./retained-repair-test-support.mjs";
import { retire } from "./retained-repair-build-retirement-test-support.mjs";
import { twoIntentFixture } from "./retained-repair-prebuild-recovery-test-support.mjs";

test("retire both captured prebuild intents across adoption and prepare a fresh 37-rewrite floor", t => {
  const { f, target, slots } = twoIntentFixture(t);
  for (const slot of slots) {
    assert.equal(existsSync(join(f.serving, "journal", "repair-" + slot.operation.operation + ".origin.json")), false);
    const inspected = retire(f, "inspect-build", slot.request);
    assert.equal(inspected.status, 0, inspected.stderr);
    const retired = retire(f, "retire-build", slot.request);
    assert.equal(retired.status, 0, retired.stderr);
    assert.equal(JSON.parse(retired.stdout).phase, "BUILD_RETIRED");
    for (const file of slot.files) {
      const path = join(f.serving, "journal", "retired-build-" + slot.operation.operation, basename(file.path));
      assert.equal(existsSync(file.path), false);
      assert.deepEqual(descriptor(path), { ...file.descriptor, path });
      assert.deepEqual(readFileSync(path), file.bytes);
    }
    assert.deepEqual(JSON.parse(retire(f, "retire-build", slot.request).stdout), JSON.parse(retired.stdout));
  }
  const request = build(f, "request", { operation: randomUUID(), target: "main", frozenMain: target,
    current: f.record.candidate.sha, pid: f.pid, generation: f.start, journalSha256: descriptor(f.journal).sha256 });
  assert.equal(build(f, "begin", request).phase, "BUILD_PREPARED");
  assert.equal(build(f, "origin", { operation: request.operation }).phase, "ORIGIN_FROZEN");
  assert.equal(build(f, "finish", { operation: request.operation }).phase, "BUILD_COMPLETED");
  untouched(f);
});

test("a post-capture rewrite reports its own build floor without transcript identifiers", t => {
  const { f, slots, changed } = twoIntentFixture(t);
  assert.match(changed.stderr, /RETAINED_CONTINUITY_SAVED_TUPLE.*scope=build-floor.*reason=no-rewrite-authority/);
  assert.doesNotMatch(changed.stderr, /session-later-rewrite|rewrite-37|synthetic-generation|openclaw-agent\.sqlite/);
  const stale = invoke(f, "retained-repair-build", "check", slots[1].operation);
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /RETAINED_CONTINUITY_SAVED_TUPLE.*scope=build-floor/);
  untouched(f);
});
