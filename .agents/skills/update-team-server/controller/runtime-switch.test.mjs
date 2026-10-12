import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { events, makeReleaseFixture, runOwner } from "./worker-config-owner-fixture.mjs";

const linuxRoot = { skip: process.platform !== "linux" || process.getuid() !== 0 ? "requires disposable Linux root" : false };
const digest = path => createHash("sha256").update(readFileSync(path)).digest("hex");
const identity = path => { const s = lstatSync(path); return [s.dev, s.ino]; };

function fixture(t, scenario = "success", version) {
  const f = makeReleaseFixture(t, scenario);
  if (!existsSync(f.lockFile)) writeFileSync(f.lockFile, "", { mode: 0o600 });
  mkdirSync(join(f.root, "bin"));
  if (version) {
    // Rejection and mutation cases use a disposable runtime probe instead of modifying installed Bun.
    f.bun = join(f.root, "bin/bun");
    writeFileSync(f.bun, `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({ node: "24.15.0", bun: version, sqlite: "3.53.2" })}'\n`, { mode: 0o755 });
  } else {
    f.bun = realpathSync(process.env.OPENCLAW_TEST_BUN ?? "/usr/local/bin/bun");
  }
  f.target = ["--switch-runtime", "bun", f.bun, digest(f.bun)];
  f.pointers = ["current", "previous"].map(name => {
    const path = join(f.serving, name);
    return existsSync(path) ? [name, identity(path), readlinkSync(path)] : [name, null];
  });
  f.databaseIdentity = identity(f.databasePath);
  return f;
}

function run(f, args = f.target) {
  const result = runOwner(f, args);
  assert.ifError(result.error);
  return result;
}
function accepted(f, result) {
  assert.equal(result.status, 0, result.stderr + result.stdout + events(f));
  assert.equal(existsSync(f.journal), false, "accepted transaction must retire its journal");
  assert.deepEqual(readFileSync(f.configPath), f.originalConfigBytes);
  assert.deepEqual(identity(f.databasePath), f.databaseIdentity);
  assert.deepEqual(["current", "previous"].map(name => {
    const path = join(f.serving, name);
    return existsSync(path) ? [name, identity(path), readlinkSync(path)] : [name, null];
  }), f.pointers, "runtime switching must preserve application pointers");
}

test("Node to Bun to Node changes only the selected runtime and is idempotent", linuxRoot, t => {
  const f = fixture(t);
  accepted(f, run(f));
  assert.match(readFileSync(f.runtimeDrop, "utf8"), /Gateway runtime: bun/);
  assert.equal(readFileSync(join(f.state, "runtime-executable"), "utf8"), f.bun);
  assert.doesNotMatch(events(f), /git\.fetch|build\.|pointer\.mv|service\.(system|user)\.(enable|disable)/);
  const before = events(f);
  accepted(f, run(f));
  assert.match(events(f).slice(before.length), /gateway/);
  assert.doesNotMatch(events(f).slice(before.length), /service\.system\.(restart|start|stop)/);
  accepted(f, run(f, ["--switch-runtime", "node", process.execPath, digest(process.execPath)]));
  assert.match(readFileSync(f.runtimeDrop, "utf8"), /Gateway runtime: node/);
  assert.equal(readFileSync(join(f.state, "runtime-executable"), "utf8"), process.execPath);
});

test("wrong pins, writable binaries, and unsupported runtimes fail before activation", linuxRoot, async t => {
  for (const reason of ["hash", "writable", "version"]) {
    await t.test(reason, t => {
      const f = fixture(t, "success", reason === "version" ? "1.3.0" : reason === "writable" ? "1.4.3" : undefined);
      if (reason === "hash") f.target[3] = "0".repeat(64);
      if (reason === "writable") chmodSync(f.bun, 0o777);
      const result = run(f);
      assert.notEqual(result.status, 0);
      assert.equal(existsSync(f.runtimeDrop), false);
      assert.equal(existsSync(f.journal), false);
      assert.doesNotMatch(events(f), /service\.system\.(restart|start|stop)/);
    });
  }
});

test("an unchanged Node selection does not restart the legacy service", linuxRoot, t => {
  const f = fixture(t);
  accepted(f, run(f, ["--switch-runtime", "node", process.execPath, digest(process.execPath)]));
  assert.equal(existsSync(f.runtimeDrop), false);
  assert.doesNotMatch(events(f), /service\.system\.(restart|start|stop)/);
});

test("a replaced default Node binary cannot pass runtime-switch admission", linuxRoot, async t => {
  for (const kind of ["node", "bun"]) {
    await t.test(kind, t => {
      const f = fixture(t);
      const oldNode = join(f.root, "bin/old-node");
      copyFileSync(process.execPath, oldNode);
      const runningExecutable = join(f.root, "proc", String(f.pid), "exe");
      unlinkSync(runningExecutable);
      symlinkSync(oldNode, runningExecutable);
      const result = run(f, kind === "node" ? ["--switch-runtime", "node", process.execPath, digest(process.execPath)] : f.target);
      assert.notEqual(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stderr, /process is not using the selected executable/);
      assert.equal(existsSync(f.runtimeDrop), false);
      assert.equal(existsSync(f.journal), false);
      assert.doesNotMatch(events(f), /gateway\.suspend\.prepare|service\.system\.(restart|start|stop)/);
    });
  }
});

test("runtime switching reports lock contention and preserves a busy Gateway", linuxRoot, async t => {
  await t.test("lock", t => {
    const f = fixture(t);
    writeFileSync(f.commandPaths.flock, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const result = run(f);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /deployment lock is busy/);
    assert.equal(existsSync(f.runtimeDrop), false);
  });
  await t.test("drain", t => {
    const f = fixture(t, "always-draining");
    f.env.OPENCLAW_TEAM_DRAIN_BUDGET = "1";
    const result = run(f);
    assert.equal(result.status, 75, result.stderr);
    assert.equal(existsSync(f.runtimeDrop), false);
    assert.equal(existsSync(f.journal), false);
    assert.doesNotMatch(events(f), /service\.system\.(restart|stop|start)/);
  });
});

test("explicit bounded interruption arms native handoff before switching", linuxRoot, t => {
  const f = fixture(t, "always-draining");
  f.env.OPENCLAW_TEAM_DRAIN_BUDGET = "1";
  accepted(f, run(f, [...f.target, "--interrupt-after-drain"]));
  const log = events(f);
  assert.ok(log.indexOf("handoff.armed") >= 0 && log.indexOf("handoff.armed") < log.indexOf("service.system.restart"), log);
  assert.equal(readFileSync(join(f.state, "shutdown-kind"), "utf8"), "external-restart");
});

test("failed runtime exec restores Node through the existing rollback", linuxRoot, t => {
  const f = fixture(t, "runtime-start-fail");
  const result = run(f);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ROLLED_BACK/);
  assert.equal(existsSync(f.runtimeDrop), false);
  assert.equal(existsSync(f.journal), false);
  assert.equal(readFileSync(join(f.state, "runtime-executable"), "utf8"), "/usr/bin/node");
  assert.equal(readFileSync(join(f.state, "system"), "utf8"), "active");
  assert.deepEqual(readFileSync(f.configPath), f.originalConfigBytes);
});

test("an unhealthy Bun successor is suspended before rolling back", linuxRoot, t => {
  const f = fixture(t, "runtime-unhealthy");
  f.env.OPENCLAW_TEAM_VERIFICATION_BUDGET = "8";
  const result = run(f);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ROLLED_BACK/);
  const log = events(f);
  assert.equal(log.split("service.system.restart\n").length - 1, 2, log);
  assert.ok(log.lastIndexOf("gateway.suspend.prepare") > log.indexOf("service.system.restart"), log);
  assert.equal(existsSync(f.runtimeDrop), false);
  assert.equal(existsSync(f.journal), false);
});

test("service metadata cannot substitute for the actual selected executable", linuxRoot, t => {
  const f = fixture(t, "runtime-wrong-executable");
  f.env.OPENCLAW_TEAM_VERIFICATION_BUDGET = "8";
  const result = run(f);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /process is not using the selected executable/);
  assert.match(result.stderr, /ROLLED_BACK/);
  assert.equal(existsSync(f.runtimeDrop), false);
  assert.equal(existsSync(f.journal), false);
});

test("unknown runtime override drift is retained without overwriting it", linuxRoot, t => {
  const f = fixture(t, "runtime-drop-drift");
  const result = run(f);
  assert.notEqual(result.status, 0);
  assert.match(readFileSync(f.runtimeDrop, "utf8"), /UNRELATED/);
  assert.equal(existsSync(f.journal), true);
  assert.doesNotMatch(events(f), /service\.system\.(restart|start|stop)/);
});

test("changing a probed executable prevents restart and retains recovery evidence", linuxRoot, t => {
  const f = fixture(t, "runtime-binary-drift", "1.4.3");
  const result = run(f);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /runtime binary SHA-256 changed/);
  assert.equal(existsSync(f.journal), true);
  assert.match(readFileSync(f.bun, "utf8"), /changed after admission/);
  assert.doesNotMatch(events(f), /service\.system\.(restart|start|stop)/);
});

for (const phase of ["publication", "selection", "start"]) {
  test(`recovery after owner death following runtime ${phase} does not repeat a restart`, linuxRoot, t => {
    const f = fixture(t, `runtime-crash-after-${phase}`);
    const killed = run(f);
    assert.equal(killed.signal, "SIGKILL", killed.stderr);
    assert.equal(existsSync(f.journal), true);
    const retry = run(f);
    assert.notEqual(retry.status, 0);
    assert.match(retry.stderr, /pending activation/);
    const before = events(f);
    accepted(f, run(f, ["--recover"]));
    assert.doesNotMatch(events(f).slice(before.length), /service\.system\.(restart|start|stop)/);
    assert.equal(existsSync(f.runtimeDrop), phase === "start");
  });
}

test("recovery does not reload an unrelated loaded service command", linuxRoot, t => {
  const f = fixture(t, "runtime-crash-after-publication");
  assert.equal(run(f).signal, "SIGKILL");
  writeFileSync(join(f.state, "runtime-executable"), "/unrelated/runtime");
  const before = events(f);
  const result = run(f, ["--recover"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /matches neither journal runtime/);
  assert.doesNotMatch(events(f).slice(before.length), /service\.system\.(daemon-reload|restart|start|stop)/);
  assert.equal(existsSync(f.journal), true);
});

test("an ordinary release activation retains the chosen Bun runtime", linuxRoot, t => {
  const f = fixture(t);
  accepted(f, run(f));
  const next = "b".repeat(40);
  f.addRelease(next);
  const git = join(dirname(f.commandPaths.systemctl), "git");
  writeFileSync(git, `#!${process.execPath}\nconst fs=require('node:fs');const a=process.argv.slice(2);if(a.includes('get-url'))console.log('https://github.com/openclaw/openclaw.git');else if(a.includes('fetch'))fs.appendFileSync(${JSON.stringify(f.eventlog)},'git.fetch\\n');else if(a.includes('rev-parse'))console.log(${JSON.stringify(next)});else process.exit(64);\n`, { mode: 0o755 });
  const result = run(f, ["--sha", next]);
  assert.equal(result.status, 0, result.stderr + result.stdout + events(f));
  assert.equal(readlinkSync(join(f.serving, "current")), join(f.serving, "releases", next));
  assert.match(readFileSync(f.runtimeDrop, "utf8"), /Gateway runtime: bun/);
  assert.equal(readFileSync(join(f.state, "runtime-executable"), "utf8"), f.bun);
  assert.equal(existsSync(f.journal), false);
});
