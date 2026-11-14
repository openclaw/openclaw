import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { test, build, descriptor, invoke, git } from "./retained-repair-lifecycle-test-support.mjs";
import { untouched } from "./retained-repair-test-support.mjs";
import { retirementFixture, retire } from "./retained-repair-build-retirement-test-support.mjs";

for (const interrupted of [false, true]) test("prebuild retirement archives stale intent and admits a fresh operation" + (interrupted ? " after interrupted archival" : ""), t => {
  const f = retirementFixture(t), before = readdirSync(join(f.serving, "journal")).sort();
  const target = git(f.mirror, "commit-tree", git(f.mirror, "rev-parse", f.request.target.sha + "^{tree}"), "-p", f.request.target.sha, "-m", "advanced official main");
  git(f.mirror, "update-ref", "refs/remotes/origin/main", target);
  const stale = invoke(f, "retained-repair-build", "origin", f.operation);
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /exact freshly frozen official main/);
  const inspection = retire(f, "inspect-build");
  assert.equal(inspection.status, 0, inspection.stderr);
  assert.equal(JSON.parse(inspection.stdout).phase, "BUILD_PREPARED");
  assert.deepEqual(readdirSync(join(f.serving, "journal")).sort(), before);
  if (interrupted) {
    const preload = join(f.root, "retirement-crash.mjs");
    writeFileSync(preload, `import fs from "node:fs"; import { syncBuiltinESMExports } from "node:module";
const rename = fs.renameSync; fs.renameSync = (from, to) => { const result = rename(from, to); if (String(to).endsWith(".build-intent.json")) process.exit(86); return result; }; syncBuiltinESMExports();`);
    assert.equal(retire(f, "retire-build", f.retirementRequest, preload).status, 86);
  }
  const result = retire(f);
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.phase, "BUILD_RETIRED");
  for (const original of f.retirementOriginals) {
    const path = join(f.archive, basename(original.path));
    assert.equal(existsSync(original.path), false);
    assert.deepEqual(descriptor(path), { ...original.descriptor, path });
    assert.deepEqual(readFileSync(path), original.bytes);
  }
  assert.deepEqual(JSON.parse(retire(f).stdout), receipt);
  assert.notEqual(invoke(f, "retained-repair-build", "begin", f.request).status, 0, "retired UUID must stay terminal");
  const fresh = build(f, "request", { operation: randomUUID(), target: "main", frozenMain: target,
    current: f.record.candidate.sha, pid: f.pid, generation: f.start, journalSha256: descriptor(f.journal).sha256 });
  assert.equal(build(f, "begin", fresh).phase, "BUILD_PREPARED");
  assert.equal(build(f, "origin", { operation: fresh.operation }).origin.target, target);
  untouched(f);
});

test("prebuild captured before the first adoption retires through that adoption's incumbent", t => {
  const f = retirementFixture(t, undefined, { beforeAdoption: true });
  assert.equal(JSON.parse(readFileSync(f.retirementRequest.buildIntent.path)).adoption, undefined);
  const inspected = retire(f, "inspect-build");
  assert.equal(inspected.status, 0, inspected.stderr);
  const retired = retire(f);
  assert.equal(retired.status, 0, retired.stderr);
  assert.equal(JSON.parse(retired.stdout).phase, "BUILD_RETIRED");
  for (const file of f.retirementOriginals) {
    const path = join(f.archive, basename(file.path));
    assert.equal(existsSync(file.path), false);
    assert.deepEqual(descriptor(path), { ...file.descriptor, path });
    assert.deepEqual(readFileSync(path), file.bytes);
  }
  untouched(f);
});

for (const effect of ["origin", "lifecycle", "live", "digest", "witness", "original", "adoption", "missing adoption"]) test("prebuild retirement refuses changed " + effect + " evidence", t => {
  const f = retirementFixture(t);
  let request = f.retirementRequest;
  if (effect === "origin") build(f, "origin");
  if (effect === "lifecycle") writeFileSync(f.prefix + ".lifecycle-bound.json", "{}\n", { mode: 0o600 });
  if (effect === "live") { f.native.unit.MainPID = "99999"; f.saveNative(); }
  if (effect === "digest") request = { ...request, buildIntent: { ...request.buildIntent, sha256: "0".repeat(64) } };
  if (effect === "witness") writeFileSync(f.prefix + ".build-witness.json", "[]\n");
  if (effect === "original") writeFileSync(f.prefix + ".build-original.json", "{}\n");
  if (effect === "adoption" || effect === "missing adoption") {
    const captured = JSON.parse(readFileSync(request.buildIntent.path));
    if (effect === "missing adoption") delete captured.adoption;
    else captured.adoption.operation = randomUUID();
    writeFileSync(request.buildIntent.path, JSON.stringify(captured) + "\n");
    request = { ...request, buildIntent: descriptor(request.buildIntent.path) };
  }
  const before = f.retirementOriginals.map(file => descriptor(file.path));
  const result = retire(f, "retire-build", request);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, effect === "live" ? /native|owner|incumbent/ : effect === "digest" ? /intent changed/ : effect === "witness" ? /RETAINED_BUILD_WITNESS/ : effect === "original" ? /RETAINED_BUILD_ORIGINAL/ : effect.endsWith("adoption") ? /RETAINED_BUILD_ADOPTION|RETAINED_BUILD_CLOSURE/ : /origin, build or lifecycle effects/);
  assert.equal(existsSync(f.archive), false);
  for (const file of before) assert.deepEqual(descriptor(file.path), file);
  untouched(f);
});
