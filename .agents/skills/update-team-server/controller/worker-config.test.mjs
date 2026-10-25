import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { makeReleaseFixture } from "./worker-config-owner-fixture.mjs";

const oldSetup = "# OPENCLAW_TEAM_ARTIFACT_SETUP_V1\ncommand -v node\nprintf legacy-runtime\n";
const replacement = "#!/usr/bin/env bash\nset -eu\ncommand -v node\ncommand -v npm\n";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function fixture(t) {
  const f = makeReleaseFixture(t), config = f.configPath, database = f.databasePath, root = f.serving;
  // Library-only transactions start fenced; the full owner normally revokes this permit.
  rmSync(f.permit);
  function call(action, args = [], input = undefined) {
    const result = spawnSync(process.execPath,
      ["--no-warnings", f.library, "worker-config", action, root, ...args], {
        encoding: "utf8", input, env: f.env,
      });
    assert.ifError(result.error);
    return result;
  }
  function prepare(configHash = f.configSha256, setupHash = f.oldSetupSha256) {
    return call("prepare",
      [config, database, f.sha, configHash, setupHash, String(process.getuid()), String(process.getgid())],
      replacement);
  }
  function begin() {
    const token = JSON.parse(pass(prepare()));
    pass(call("begin", [JSON.stringify(token)], JSON.stringify({
      process: { pid: 111, generation: "1110", instance: "synthetic-instance" },
      suspension: { id: "synthetic-lease", expiresAtMs: Date.now() + 120000,
        status: "ready", terminalPolicy: "preserve" },
      witness: [JSON.stringify(["controller-test-agent", "synthetic-agent-db", 1, 2,
        "agent:controller-test-agent:existing", "synthetic-session", null, null])],
    })));
    return token;
  }
  function publish(value = structuredClone(f.original), setup = replacement) {
    value.cloudWorkers.profiles.aws.settings.setup = setup;
    writeFileSync(`${config}.fixture-next`, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    renameSync(`${config}.fixture-next`, config);
    return readFileSync(config);
  }
  return { ...f, root, config, database, originalBytes: f.originalConfigBytes, call, prepare, begin, publish };
}

test("prepares only a bound AWS setup operation and retains exact original bytes", (t) => {
  const f = fixture(t);
  const result = f.prepare();
  assert.equal(result.status, 0, result.stderr);
  const token = JSON.parse(result.stdout);
  assert.match(token.stage, /^config-worker-[a-f0-9-]+$/u);
  const stage = join(f.root, "staging", token.stage);
  assert.deepEqual(readFileSync(join(stage, "private", "original-config")), f.originalBytes);
  assert.equal(
    JSON.parse(readFileSync(join(stage, "private/replacement.json"), "utf8")),
    replacement,
  );
  assert.equal(JSON.parse(pass(f.call("replacement-value", [JSON.stringify(token)]))), replacement);
  assert.equal(JSON.parse(pass(f.call("expected-value", [JSON.stringify(token)]))), oldSetup);
  assert.deepEqual(readFileSync(f.config), f.originalBytes);
  assert.doesNotMatch(result.stdout + result.stderr, /nonsecret-synthetic-sibling|legacy-runtime/u);
});

test("refuses stale full-config or old-script bindings before preparing a write", (t) => {
  const f = fixture(t);
  for (const args of [
    ["0".repeat(64), hash(oldSetup)],
    [hash(f.originalBytes), "0".repeat(64)],
  ]) {
    const result = f.prepare(...args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /worker config.*(hash|changed|binding)/iu);
    assert.deepEqual(readFileSync(f.config), f.originalBytes);
  }
});

function pass(result) {
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test("accepts only the native leaf delta and forbids rollback after acceptance", (t) => {
  const f = fixture(t);
  f.begin();
  pass(f.call("writing"));
  const bytes = f.publish();
  assert.equal(pass(f.call("accept")), "CONFIG_VERIFIED");
  const refused = f.call("restore");
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /only before acceptance/u);
  assert.deepEqual(readFileSync(f.config), bytes);
  pass(f.call("permit"));
  assert.equal(pass(f.call("finish")), "APPLIED");
  assert.equal(existsSync(f.journal), false);
});

test("preserves a concurrent unrelated change rather than accepting or restoring over it", (t) => {
  const f = fixture(t);
  f.begin();
  pass(f.call("writing"));
  const concurrent = structuredClone(f.original);
  concurrent.syntheticUnrelated.concurrent = "preserve-this-write";
  const bytes = f.publish(concurrent);
  const acceptance = f.call("accept");
  assert.notEqual(acceptance.status, 0);
  const restore = f.call("restore");
  assert.notEqual(restore.status, 0);
  assert.match(restore.stderr, /unknown drift.*not overwrite/u);
  assert.deepEqual(readFileSync(f.config), bytes);
  assert.equal(JSON.parse(readFileSync(f.journal)).phase, "CONFIG_WRITING");
  assert.equal(existsSync(join(f.root, "journal/gateway-start-permit")), false);
});

test("restores only the original config before acceptance, retaining native backups and database bytes", (t) => {
  const f = fixture(t);
  const token = f.begin();
  pass(f.call("writing"));
  const current = f.publish();
  writeFileSync(`${f.config}.bak`, "native-writer-backup-evidence", { mode: 0o600 });
  const database = readFileSync(f.database);
  assert.equal(pass(f.call("restore")), "CONFIG_RESTORING");
  assert.deepEqual(readFileSync(f.config), current, "preparation must not bypass the native writer");
  assert.equal(JSON.parse(pass(f.call("expected-value", [JSON.stringify(token)]))), oldSetup);
  assert.equal(JSON.parse(pass(f.call("replacement-value", [JSON.stringify(token)]))), replacement);
  // Model the native inverse committing before its journal receipt.
  const restored = f.publish(structuredClone(f.original), oldSetup);
  assert.equal(JSON.parse(readFileSync(f.journal)).phase, "CONFIG_RESTORING");
  assert.equal(pass(f.call("restore")), "CONFIG_RESTORED");
  assert.deepEqual(readFileSync(f.config), restored, "recovery must not perform another config write");
  pass(f.call("check"));
  assert.deepEqual(JSON.parse(readFileSync(f.config, "utf8")), f.original);
  assert.equal(readFileSync(`${f.config}.bak`, "utf8"), "native-writer-backup-evidence");
  assert.deepEqual(readFileSync(f.database), database);
  assert.deepEqual(
    readFileSync(join(f.root, "staging", token.stage, "private/original-config")),
    f.originalBytes,
  );
  pass(f.call("permit"));
  assert.equal(pass(f.call("finish")), "RESTORED");
});

test("refuses changed original witnesses and accepted-file drift", (t) => {
  const f = fixture(t);
  const token = f.begin();
  const witness = join(f.root, "staging", token.stage, "private/witness.json");
  const originalWitness = readFileSync(witness);
  writeFileSync(witness, "[]\n");
  const rejected = f.call("witness");
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /original session witness changed/u);
  writeFileSync(witness, originalWitness);
  pass(f.call("writing"));
  f.publish();
  pass(f.call("accept"));
  const accepted = JSON.parse(readFileSync(f.config));
  accepted.syntheticUnrelated.concurrent = "do-not-clobber";
  const changedBytes = f.publish(accepted);
  assert.notEqual(f.call("permit").status, 0);
  assert.notEqual(f.call("restore").status, 0);
  assert.deepEqual(readFileSync(f.config), changedBytes);
  assert.equal(existsSync(f.journal), true);
});
