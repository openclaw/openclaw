import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { makeReleaseFixture, runLibrary } from "./worker-config-owner-fixture.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");

function fixture(t) {
  const f = makeReleaseFixture(t), candidate = f.addRelease("b".repeat(40));
  const config = JSON.parse(readFileSync(f.config));
  config.plugins.entries.codex.config.appServer.loopDetectionPreToolUseRelay = false;
  writeFileSync(f.config, JSON.stringify(config, null, 2) + "\n");
  const original = readFileSync(f.config);
  delete config.plugins.entries.codex.config.appServer.loopDetectionPreToolUseRelay;
  const run = (args, options) => runLibrary(f, args, options);
  const ok = result => { assert.ifError(result.error); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
  const proof = args => ok(run(args));
  const descriptor = JSON.parse(ok(run(["config-contract", "prepare", f.serving, candidate, f.config, f.databasePath, "@stdin"], {
    input: JSON.stringify({ configPath: f.config, originalSha256: hash(original), config,
      changedPaths: ["plugins.entries.codex.config.appServer.loopDetectionPreToolUseRelay"] }),
  })));
  const infos = [f.initial, candidate].map(path => proof(["validate-release", path, path.split("/").at(-1), process.getuid(), "sealed"]));
  const paths = proof(["fingerprint", f.config, f.databasePath]);
  ok(run(["journal-create", f.journal, ...infos, "system", f.pid, f.start, "fixture-instance", paths,
    f.sha, "absent", "enabled", "active", "disabled", "inactive", randomUUID(), Date.now() + 30000, "READY",
    "@stdin", "", "", JSON.stringify(descriptor)], { input: "[]" }));
  proof(["journal-phase", f.journal, "B_PREVIOUS_PUBLISHED"]);
  const planPath = join(dirname(f.journal), descriptor.name), plan = JSON.parse(readFileSync(planPath));
  const transition = action => JSON.parse(proof(["config-contract", action, f.serving]));
  return { ...f, original, descriptor, planPath, plan, run, ok, proof, transition };
}

test("config contract publishes the prepared replacement once and preserves rollback bytes and changed keys", t => {
  const f = fixture(t), database = readFileSync(f.databasePath);
  assert.deepEqual(readFileSync(f.config), f.original);
  const result = f.transition("apply"), configInode = statSync(f.config).ino, journalInode = statSync(f.journal).ino;
  assert.equal(Object.hasOwn(JSON.parse(readFileSync(f.config)).plugins.entries.codex.config.appServer,
    "loopDetectionPreToolUseRelay"), false);
  assert.equal(result.protectedPaths[0].inode, configInode);
  assert.deepEqual(Buffer.from(f.plan.originalBytes), f.original);
  const receipt = JSON.parse(readFileSync(f.planPath.replace(/\.json$/, ".applied.json")));
  assert.deepEqual(receipt.changedPaths, ["plugins.entries.codex.config.appServer.loopDetectionPreToolUseRelay"]);
  assert.equal(receipt.config.sha256, hash(readFileSync(f.config)));
  assert.deepEqual(f.transition("apply"), result);
  assert.deepEqual(f.transition("reconcile"), result);
  assert.equal(statSync(f.config).ino, configInode);
  assert.equal(statSync(f.journal).ino, journalInode);
  f.transition("restore");
  assert.deepEqual(readFileSync(f.config), f.original);
  const restored = [statSync(f.config).ino, statSync(f.journal).ino];
  f.transition("restore");
  assert.deepEqual([statSync(f.config).ino, statSync(f.journal).ino], restored);
  assert.deepEqual(readFileSync(f.databasePath), database);
});

test("config contract reconciles interrupted apply and restore renames from their journal intent", t => {
  const f = fixture(t);
  // Model process death after the fsynced config rename but before journal rebinding.
  writeFileSync(f.config + ".next", f.plan.nextBytes, { mode: 0o600 });
  renameSync(f.config + ".next", f.config);
  f.transition("reconcile");
  let journal = JSON.parse(readFileSync(f.journal));
  assert.equal(journal.configContract.status, "applied");
  assert.equal(journal.protectedPaths[0].inode, statSync(f.config).ino);
  journal.configContract.status = "restoring";
  writeFileSync(f.journal, JSON.stringify(journal));
  writeFileSync(f.config + ".next", f.original, { mode: 0o600 });
  renameSync(f.config + ".next", f.config);
  f.transition("reconcile");
  journal = JSON.parse(readFileSync(f.journal));
  assert.equal(journal.configContract.status, "restored");
  assert.equal(journal.protectedPaths[0].inode, statSync(f.config).ino);
  assert.deepEqual(readFileSync(f.config), f.original);
});

test("config contract refuses an unrelated edit without overwriting config or journal", t => {
  const f = fixture(t);
  const config = JSON.parse(readFileSync(f.config));
  config.unrelatedEdit = true;
  writeFileSync(f.config, JSON.stringify(config));
  const before = [readFileSync(f.config), readFileSync(f.journal)];
  const result = f.run(["config-contract", "apply", f.serving]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /prepared config changed before migration/);
  assert.deepEqual([readFileSync(f.config), readFileSync(f.journal)], before);
});
