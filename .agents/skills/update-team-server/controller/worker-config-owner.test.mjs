import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { events, makeWorkerConfigFixture, runOwner } from "./worker-config-owner-fixture.mjs";

const linuxRoot = {
  skip:
    process.platform !== "linux" || process.getuid() !== 0
      ? "requires isolated Linux root for real filesystem ownership"
      : false,
};
const replacement = "#!/usr/bin/env bash\nset -eu\ncommand -v node\ncommand -v npm\n";
const args = (f) => [
  "--repair-worker-bootstrap",
  f.sha,
  f.pid,
  f.start,
  f.configSha256,
  f.oldSetupSha256,
];
const config = (f) => JSON.parse(readFileSync(f.configPath, "utf8"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

test(
  "fixture mirrors native refusal of conditional batch mode even for one operation",
  linuxRoot,
  (t) => {
    const f = makeWorkerConfigFixture(t);
    const result = spawnSync(
      process.execPath,
      [
        join(f.initial, "dist/index.js"),
        "config",
        "set",
        "--batch-file",
        join(f.root, "must-not-be-read.json"),
        "--expect-current-json",
        JSON.stringify(f.oldSetup),
      ],
      {
        encoding: "utf8",
        cwd: f.root,
        env: { ...f.env, OPENCLAW_CONFIG_PATH: f.configPath, OPENCLAW_STATE_DIR: f.root },
      },
    );
    assert.ifError(result.error);
    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /conditional expectations require one path operation and cannot be combined with batch mode/u,
    );
    assert.deepEqual(readFileSync(f.configPath), f.originalConfigBytes);
  },
);

function runRepair(f) {
  const result = runOwner(f, args(f), replacement);
  assert.ifError(result.error);
  return result;
}

test(
  "the real canonical lock excludes a second owner while the native writer is active",
  linuxRoot,
  async (t) => {
    const f = makeWorkerConfigFixture(t, "hold-writer");
    assert.equal(
      f.lockMode,
      "real-flock",
      "Linux proof requires actual flock, not the fixture fallback",
    );
    const child = spawn(
      f.realCommands.bash,
      [
        "-c",
        'export FIXTURE_OWNER_PID=$$; exec "$@"',
        "fixture-owner",
        f.owner,
        ...args(f).map(String),
      ],
      {
        env: f.env,
        cwd: f.root,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 90000,
      },
    );
    let output = "",
      exited = false;
    child.stdout.on("data", (bytes) => {
      output += bytes;
    });
    child.stderr.on("data", (bytes) => {
      output += bytes;
    });
    const completion = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        exited = true;
        resolve({ code, signal });
      });
    });
    child.stdin.end(replacement);
    try {
      const deadline = Date.now() + 20000;
      while (!existsSync(join(f.state, "writer-blocked")) && !exited && Date.now() < deadline)
        await delay(25);
      assert.equal(existsSync(join(f.state, "writer-blocked")), true, output + events(f));
      const second = runOwner(f, args(f), replacement);
      assert.ifError(second.error);
      assert.notEqual(second.status, 0);
      assert.match(second.stderr, /canonical deployment lock is busy/u);
    } finally {
      writeFileSync(join(f.state, "release-writer"), "release\n");
      const finished = await completion;
      assert.equal(finished.code, 0, output + events(f));
    }
    assert.equal(events(f).split("gateway config set\n").length - 1, 1);
  },
);

test("always-DRAINING interruption arms the exact native handoff before stop", linuxRoot, (t) => {
  const f = makeWorkerConfigFixture(t, "always-draining");
  f.env.OPENCLAW_TEAM_DRAIN_BUDGET = "1";
  const result = runOwner(f, [...args(f), "--interrupt-after-drain"], replacement);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr + events(f));
  assert.match(result.stdout, /INTERRUPTING authorized after 1-second graceful drain/u);
  assert.match(result.stdout, /HANDOFF_ARMED/u);
  const log = events(f);
  assert.ok(log.includes("suspension.draining"));
  assert.ok(
    log.indexOf("handoff.armed") >= 0 &&
      log.indexOf("handoff.armed") < log.indexOf("service.system.stop"),
    log,
  );
  assert.ok(log.indexOf("handoff.consumed") > log.indexOf("service.system.stop"), log);
  assert.equal(readFileSync(join(f.state, "shutdown-kind"), "utf8"), "external-restart");
  assert.equal(config(f).cloudWorkers.profiles.aws.settings.setup, replacement);
  assertNoDeployment(f);
});

test("always-DRAINING work defers without interruption authority", linuxRoot, (t) => {
  const f = makeWorkerConfigFixture(t, "always-draining");
  f.env.OPENCLAW_TEAM_DRAIN_BUDGET = "1";
  const result = runRepair(f);
  assert.equal(result.status, 75, result.stderr + events(f));
  assert.deepEqual(readFileSync(f.configPath), f.originalConfigBytes);
  assert.doesNotMatch(
    events(f),
    /gateway.suspend.handoff|handoff.armed|service.system.stop|config.write.committed/u,
  );
  assert.equal(existsSync(f.journal), false);
});

test(
  "refused or uncertain DRAINING handoff never reaches stop and safely cancels",
  linuxRoot,
  async (t) => {
    for (const scenario of ["handoff-refused", "handoff-uncertain"]) {
      await t.test(scenario, (t) => {
        const f = makeWorkerConfigFixture(t, scenario);
        f.env.OPENCLAW_TEAM_DRAIN_BUDGET = "1";
        const result = runOwner(f, [...args(f), "--interrupt-after-drain"], replacement);
        assert.ifError(result.error);
        assert.notEqual(result.status, 0);
        assert.match(events(f), /gateway.suspend.handoff/u);
        assert.doesNotMatch(events(f), /service.system.stop|config.write.committed/u);
        assert.match(result.stdout, /RECOVERED .*result=RESTORED/u, result.stderr + events(f));
        assert.deepEqual(readFileSync(f.configPath), f.originalConfigBytes);
        assert.equal(existsSync(f.journal), false);
        assert.equal(existsSync(f.permit), true);
        assert.equal(existsSync(join(f.state, "armed-handoff")), false);
      });
    }
  },
);

function assertNoDeployment(f) {
  assert.doesNotMatch(
    events(f),
    /git\.fetch|build\.|pointer\.mv|service\.(?:system|user)\.(?:enable|disable)/u,
  );
}

test(
  "fixed owner repair stops, conditionally writes, starts and fully verifies without changing release pointers",
  linuxRoot,
  (t) => {
    const f = makeWorkerConfigFixture(t);
    const foreignConfig = join(f.root, "foreign-config.json");
    writeFileSync(foreignConfig, f.originalConfigBytes, { mode: 0o600 });
    f.env.OPENCLAW_CONFIG_PATH = foreignConfig;
    f.env.OPENCLAW_STATE_DIR = join(f.root, "foreign-state");
    const pointer = readlinkSync(join(f.servingRoot, "current"));
    const result = runRepair(f);
    assert.equal(result.status, 0, result.stderr + result.stdout + events(f));
    assert.match(result.stdout, /SUCCESS .*action=repair-worker-bootstrap result=APPLIED/u);
    const expected = structuredClone(f.original);
    expected.cloudWorkers.profiles.aws.settings.setup = replacement;
    assert.deepEqual(config(f), expected);
    assert.deepEqual(readFileSync(foreignConfig), f.originalConfigBytes);
    assert.equal(existsSync(join(f.root, "foreign-state")), false);
    assert.equal(readlinkSync(join(f.servingRoot, "current")), pointer);
    assert.equal(existsSync(join(f.servingRoot, "previous")), false);
    assert.equal(existsSync(f.journal), false);
    assert.equal(existsSync(f.permit), true);
    const observed = events(f).trimEnd().split("\n");
    const ordered = [
      "gateway config set --dry-run",
      "gateway gateway call gateway.suspend.prepare",
      "service.system.stop",
      "config.write.committed",
      "service.system.start",
      "gateway gateway call agent",
      "gateway gateway call agent.wait",
    ];
    let last = -1;
    for (const event of ordered) {
      const index = observed.indexOf(event);
      assert.ok(index > last, `missing or out-of-order boundary ${event}\n${observed.join("\n")}`);
      last = index;
    }
    assertNoDeployment(f);
  },
);

test(
  "failed native writes recover only the original config and preserve the failed repair outcome",
  linuxRoot,
  async (t) => {
    for (const scenario of ["writer-fail-before", "writer-fail-after"]) {
      await t.test(scenario, (t) => {
        const f = makeWorkerConfigFixture(t, scenario);
        const result = runRepair(f);
        assert.notEqual(result.status, 0);
        assert.match(result.stdout, /RECOVERED .*result=RESTORED/u, result.stderr + events(f));
        assert.deepEqual(config(f), f.original);
        if (scenario === "writer-fail-before")
          assert.deepEqual(readFileSync(f.configPath), f.originalConfigBytes);
        assert.equal(existsSync(f.journal), false);
        assert.equal(readFileSync(join(f.state, "system"), "utf8"), "active");
        assertNoDeployment(f);
      });
    }
  },
);

test(
  "external writers are preserved and refuse acceptance or backup overwrite",
  linuxRoot,
  async (t) => {
    for (const scenario of [
      "preread-unrelated-write",
      "preread-leaf-change",
      "writer-cas-conflict",
    ]) {
      await t.test(scenario, (t) => {
        const f = makeWorkerConfigFixture(t, scenario);
        const result = runRepair(f);
        assert.notEqual(result.status, 0);
        assert.equal(
          JSON.parse(readFileSync(f.journal)).phase,
          "CONFIG_WRITING",
          result.stderr + events(f),
        );
        assert.equal(existsSync(f.permit), false);
        assert.equal(readFileSync(join(f.state, "system"), "utf8"), "inactive");
        assert.doesNotMatch(events(f), /service.system.start/u);
        const persisted = readFileSync(f.configPath);
        if (scenario === "preread-leaf-change")
          assert.match(
            config(f).cloudWorkers.profiles.aws.settings.setup,
            /synthetic concurrent setup/u,
          );
        else
          assert.equal(
            config(f).syntheticUnrelated.concurrent,
            scenario === "writer-cas-conflict" ? "cas-conflict" : "preserved",
          );
        const recovery = runOwner(f, ["--recover"]);
        assert.ifError(recovery.error);
        assert.notEqual(recovery.status, 0);
        assert.deepEqual(readFileSync(f.configPath), persisted);
        assert.equal(existsSync(f.journal), true);
        assertNoDeployment(f);
      });
    }
  },
);

test(
  "the native inverse refuses a concurrent writer without restoring over its change",
  linuxRoot,
  (t) => {
    const f = makeWorkerConfigFixture(t, "inverse-cas-conflict");
    const result = runRepair(f);
    assert.notEqual(result.status, 0);
    assert.match(events(f), /config.inverse.cas-conflict/u, result.stderr);
    assert.equal(JSON.parse(readFileSync(f.journal)).phase, "CONFIG_RESTORING");
    assert.equal(config(f).syntheticUnrelated.concurrent, "inverse-cas-winner");
    assert.equal(config(f).cloudWorkers.profiles.aws.settings.setup, replacement);
    const observed = readFileSync(f.configPath);
    const recovery = runOwner(f, ["--recover"]);
    assert.ifError(recovery.error);
    assert.notEqual(recovery.status, 0);
    assert.deepEqual(readFileSync(f.configPath), observed);
    assert.equal(existsSync(f.permit), false);
    assert.doesNotMatch(events(f), /service.system.start/u);
  },
);

test("stale admission has no config write, stop, pointer mutation or journal", linuxRoot, (t) => {
  const f = makeWorkerConfigFixture(t);
  const stale = args(f);
  stale[4] = "0".repeat(64);
  const result = runOwner(f, stale, replacement);
  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
  assert.deepEqual(readFileSync(f.configPath), f.originalConfigBytes);
  assert.equal(existsSync(f.journal), false);
  assert.doesNotMatch(events(f), /service.system.stop|gateway config set/u);
  assertNoDeployment(f);
});

test(
  "a skipped start cannot retire an accepted config transaction or restore old config",
  linuxRoot,
  (t) => {
    const f = makeWorkerConfigFixture(t, "start-skip0");
    const result = runRepair(f);
    assert.notEqual(result.status, 0);
    assert.equal(
      config(f).cloudWorkers.profiles.aws.settings.setup,
      replacement,
      result.stderr + events(f),
    );
    assert.equal(JSON.parse(readFileSync(f.journal)).phase, "CONFIG_VERIFIED");
    assert.equal(readFileSync(join(f.state, "system"), "utf8"), "inactive");
    assert.equal(existsSync(f.permit), true, "the failed start already published its permit");
    writeFileSync(join(f.state, "scenario"), "success");
    const recovered = runOwner(f, ["--recover"]);
    assert.ifError(recovered.error);
    assert.equal(recovered.status, 0, recovered.stderr + events(f));
    assert.match(recovered.stdout, /RECOVERED .*result=APPLIED/u);
    assert.equal(existsSync(f.journal), false);
    assert.equal(config(f).cloudWorkers.profiles.aws.settings.setup, replacement);
    assertNoDeployment(f);
  },
);

test(
  "missing original session history warns without blocking accepted config",
  linuxRoot,
  (t) => {
    const f = makeWorkerConfigFixture(t, "lose-session-on-start");
    const result = runRepair(f);
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr + events(f));
    assert.match(result.stderr, /WARNING HISTORY_PRESERVATION_GAPS count=1/u);
    assert.match(result.stdout, /SUCCESS .*action=repair-worker-bootstrap result=APPLIED/u);
    const evidence = /^WORKER_CONFIG_EVIDENCE=(.+)$/mu.exec(result.stdout)?.[1];
    assert.ok(evidence, "owner must retain its private evidence location");
    const witness = JSON.parse(readFileSync(join(evidence, "witness.json")));
    assert.ok(witness.length > 0, "original witness remains present after acceptance");
    assert.equal(JSON.parse(witness[0])[5], "synthetic-generation");
    assert.equal(existsSync(f.journal), false);
    assert.equal(config(f).cloudWorkers.profiles.aws.settings.setup, replacement);
  },
);

// The fault wrapper executes the real proof operation, then kills only this fixture's owner.
function crashAfterProof(f, operation) {
  const wrapper = join(f.root, `crash-after-${operation}.mjs`);
  writeFileSync(
    wrapper,
    `import {spawnSync} from 'node:child_process';\nconst args=process.argv.slice(2);\nconst result=spawnSync(process.execPath,['--no-warnings',${JSON.stringify(f.library)},...args],{stdio:'inherit'});\nif(result.status===0&&args[0]==='worker-config'&&args[1]===${JSON.stringify(operation)})process.kill(Number(process.env.FIXTURE_OWNER_PID),'SIGKILL');\nprocess.exit(result.status??1);\n`,
  );
  f.env.OPENCLAW_TEAM_RELEASE_LIB = wrapper;
}

test("live cancellation recognizes already-running after a lost resume receipt", linuxRoot, (t) => {
  const f = makeWorkerConfigFixture(t, "stop-refused");
  crashAfterProof(f, "cancellation-result");
  const interrupted = runRepair(f);
  assert.equal(interrupted.signal, "SIGKILL", interrupted.stderr + events(f));
  assert.equal(JSON.parse(readFileSync(f.journal)).phase, "CONFIG_RESTORED");
  assert.equal(existsSync(f.permit), true);
  assert.equal(existsSync(join(f.state, "active-lease")), false);
  f.env.OPENCLAW_TEAM_RELEASE_LIB = f.library;
  const recovery = runOwner(f, ["--recover"]);
  assert.ifError(recovery.error);
  assert.equal(recovery.status, 0, recovery.stderr + events(f));
  assert.match(recovery.stdout, /WORKER_CONFIG_CANCELLATION suspension=ALREADY_RUNNING/u);
  assert.equal(existsSync(f.journal), false);
  assert.deepEqual(readFileSync(f.configPath), f.originalConfigBytes);
  assert.doesNotMatch(events(f), /service.system.start|config.write.committed/u);
});

test(
  "live cancellation refuses a replacement suspension instead of claiming release",
  linuxRoot,
  (t) => {
    const f = makeWorkerConfigFixture(t, "stop-refused");
    crashAfterProof(f, "cancel");
    assert.equal(runRepair(f).signal, "SIGKILL");
    const lease = JSON.stringify({ id: "unrelated-synthetic-lease", expiry: Date.now() + 120000 });
    writeFileSync(join(f.state, "active-lease"), lease);
    f.env.OPENCLAW_TEAM_RELEASE_LIB = f.library;
    const recovery = runOwner(f, ["--recover"]);
    assert.ifError(recovery.error);
    assert.notEqual(recovery.status, 0);
    assert.equal(readFileSync(join(f.state, "active-lease"), "utf8"), lease);
    assert.equal(existsSync(f.journal), true);
    assert.doesNotMatch(recovery.stdout, /suspension=(RESUMED|ALREADY_RUNNING)/u);
    assert.deepEqual(readFileSync(f.configPath), f.originalConfigBytes);
  },
);

test("live cancellation recovers a crash before permit publication", linuxRoot, (t) => {
  const f = makeWorkerConfigFixture(t, "stop-refused");
  crashAfterProof(f, "cancel");
  const interrupted = runRepair(f);
  assert.equal(interrupted.signal, "SIGKILL", interrupted.stderr + events(f));
  assert.equal(JSON.parse(readFileSync(f.journal)).phase, "CONFIG_RESTORED");
  assert.equal(existsSync(f.permit), false);
  assert.equal(readFileSync(join(f.state, "pid"), "utf8"), "111");
  f.env.OPENCLAW_TEAM_RELEASE_LIB = f.library;
  const recovery = runOwner(f, ["--recover"]);
  assert.ifError(recovery.error);
  assert.equal(recovery.status, 0, recovery.stderr + events(f));
  assert.equal(existsSync(f.journal), false);
  assert.equal(existsSync(f.permit), true);
  assert.deepEqual(readFileSync(f.configPath), f.originalConfigBytes);
  assert.doesNotMatch(events(f), /service.system.start|config.write.committed/u);
});

test(
  "a crash at the durable write boundary recovers original config without replaying the writer",
  linuxRoot,
  (t) => {
    const f = makeWorkerConfigFixture(t);
    crashAfterProof(f, "writing");
    const result = runRepair(f);
    assert.equal(result.signal, "SIGKILL", result.stderr + events(f));
    assert.equal(JSON.parse(readFileSync(f.journal)).phase, "CONFIG_WRITING");
    assert.deepEqual(readFileSync(f.configPath), f.originalConfigBytes);
    assert.equal(existsSync(f.permit), false);
    f.env.OPENCLAW_TEAM_RELEASE_LIB = f.library;
    const recovery = runOwner(f, ["--recover"]);
    assert.ifError(recovery.error);
    assert.equal(recovery.status, 0, recovery.stderr + events(f));
    assert.match(recovery.stdout, /RECOVERED .*result=RESTORED/u);
    assert.equal(existsSync(f.journal), false);
    assert.doesNotMatch(events(f), /config.write.committed/u);
    assertNoDeployment(f);
  },
);
