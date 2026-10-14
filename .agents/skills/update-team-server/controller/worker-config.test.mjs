import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const library = join(import.meta.dirname, "release-lib.mjs");
const sha = "a".repeat(40);
const oldSetup = "# OPENCLAW_TEAM_ARTIFACT_SETUP_V1\ncommand -v node\nprintf legacy-runtime\n";
const replacement = "#!/usr/bin/env bash\nset -eu\ncommand -v node\ncommand -v npm\n";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function fixture(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "team-worker-config-")));
  const root = join(directory, "serving");
  const config = join(directory, "runtime", "openclaw.json");
  const database = join(directory, "runtime", "openclaw.sqlite");
  for (const path of [
    root,
    join(root, "journal"),
    join(root, "staging"),
    join(root, "releases", sha),
    dirname(config),
  ]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  writeFileSync(
    join(root, "releases", sha, "package.json"),
    JSON.stringify({ version: "2026.9.3" }),
  );
  symlinkSync(join(root, "releases", sha), join(root, "current"));
  const original = {
    meta: { lastTouchedVersion: "2026.9.3", migrations: { modelPolicyAllowlist: true } },
    cloudWorkers: {
      profiles: {
        aws: {
          provider: "crabbox",
          settings: {
            binary: "/home/openclaw/.openclaw/bin/crabbox-artifact",
            desktop: true,
            setup: oldSetup,
          },
        },
      },
    },
    syntheticUnrelated: { retained: "private-fixture-value" },
  };
  writeFileSync(config, JSON.stringify(original) + "\n", { mode: 0o600 });
  writeFileSync(database, "synthetic-database-identity", { mode: 0o600 });
  const originalBytes = readFileSync(config);
  function call(action, args = [], input) {
    const result = spawnSync(
      process.execPath,
      ["--no-warnings", library, "worker-config", action, root, ...args],
      {
        encoding: "utf8",
        input,
        env: {
          ...process.env,
          OPENCLAW_TEAM_ROOT_UID: String(process.getuid()),
          OPENCLAW_TEAM_ROOT_GID: String(process.getgid()),
          OPENCLAW_TEAM_ANCESTOR_BOUNDARY: directory,
        },
      },
    );
    assert.ifError(result.error);
    return result;
  }
  function prepare(configHash = hash(originalBytes), setupHash = hash(oldSetup)) {
    return call(
      "prepare",
      [
        config,
        database,
        sha,
        configHash,
        setupHash,
        String(process.getuid()),
        String(process.getgid()),
      ],
      replacement,
    );
  }
  function begin() {
    const prepared = prepare();
    assert.equal(prepared.status, 0, prepared.stderr);
    const token = JSON.parse(prepared.stdout);
    const result = call(
      "begin",
      [JSON.stringify(token)],
      JSON.stringify({
        process: { pid: 111, generation: "1110", instance: "synthetic-instance" },
        suspension: {
          id: "synthetic-lease",
          expiresAtMs: Date.now() + 120000,
          status: "ready",
          terminalPolicy: "preserve",
        },
        witness: [
          JSON.stringify([
            "controller-test-agent",
            "synthetic-agent-db",
            1,
            2,
            "agent:controller-test-agent:existing",
            "synthetic-session",
            null,
            null,
          ]),
        ],
      }),
    );
    assert.equal(result.status, 0, result.stderr);
    return token;
  }
  function publish(value = structuredClone(original), setup = replacement) {
    value.cloudWorkers.profiles.aws.settings.setup = setup;
    writeFileSync(`${config}.fixture-next`, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    renameSync(`${config}.fixture-next`, config);
    return readFileSync(config);
  }
  const journal = join(root, "journal/activation.json");
  t.after(() => {
    chmodSync(root, 0o700);
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    root,
    config,
    database,
    original,
    originalBytes,
    journal,
    call,
    prepare,
    begin,
    publish,
  };
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
  assert.doesNotMatch(result.stdout + result.stderr, /private-fixture-value|legacy-runtime/u);
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

test("rollback preparation never writes config outside native writer serialization", (t) => {
  const f = fixture(t);
  f.begin();
  pass(f.call("writing"));
  const current = f.publish();
  const prepared = f.call("restore");
  assert.equal(
    hash(readFileSync(f.config)),
    hash(current),
    "proof helper bypassed native config writer serialization",
  );
  assert.equal(pass(prepared), "CONFIG_RESTORING");
});

test("restores only the original config before acceptance, retaining native backups and database bytes", (t) => {
  const f = fixture(t);
  const token = f.begin();
  pass(f.call("writing"));
  f.publish();
  writeFileSync(`${f.config}.bak`, "native-writer-backup-evidence", { mode: 0o600 });
  const database = readFileSync(f.database);
  assert.equal(pass(f.call("restore")), "CONFIG_RESTORING");
  assert.equal(JSON.parse(pass(f.call("expected-value", [JSON.stringify(token)]))), oldSetup);
  assert.equal(JSON.parse(pass(f.call("replacement-value", [JSON.stringify(token)]))), replacement);
  f.publish(structuredClone(f.original), oldSetup); // The native writer owns this conditional inverse.
  assert.equal(pass(f.call("restore")), "CONFIG_RESTORED");
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

test("recovers after the native inverse committed but its journal update was interrupted", (t) => {
  const f = fixture(t);
  f.begin();
  pass(f.call("writing"));
  f.publish();
  pass(f.call("restore"));
  const restoredBytes = f.publish(structuredClone(f.original), oldSetup);
  assert.equal(JSON.parse(readFileSync(f.journal)).phase, "CONFIG_RESTORING");
  assert.equal(pass(f.call("restore")), "CONFIG_RESTORED");
  assert.deepEqual(
    readFileSync(f.config),
    restoredBytes,
    "recovery must not perform another config write",
  );
  pass(f.call("check"));
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
