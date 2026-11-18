// A real managed Gateway with automatic updates on a one-minute cron schedule. A plugin step is
// owed by the automatic update that installed this version five minutes earlier; the Gateway
// must not retry it in the next windows, and it retries exactly once after the hour.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { packFirstHopUpdateFixture } from "../update-first-hop-package-fixtures.mjs";
import { runInstalledRecoveryCommand } from "./installed-recovery-command.mjs";
import {
  openInstalledRecoveryEvidence,
  writeInstalledRecoveryEvidence as write,
} from "./installed-recovery-observations.mjs";
import { readDatabase } from "./observations.mjs";

const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const port = 18789;
const owedStep = "finalize:owed:plugin-convergence";
// Every minute opens a start window, so only the cooldown can hold the retry back.
const schedule = "* * * * *";

async function main([artifacts, prefix, tarball, summary]) {
  const timeout = process.env.OPENCLAW_E2E_COMMAND_TIMEOUT;
  assert(timeout !== undefined, "missing survivor command timeout");
  assert.equal(process.platform, "linux", "the live Gateway cell owns a disposable container");
  for (const file of [artifacts, prefix, tarball, summary]) {
    assert(file && path.isAbsolute(file));
  }
  const root = fs.realpathSync(path.join(prefix, "lib/node_modules/openclaw"));
  const bin = path.join(prefix, "bin/openclaw");
  const node = fs.realpathSync(process.execPath);
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  assert(stateDir && path.isAbsolute(stateDir), "missing isolated state directory");
  const daemonLog = process.env.OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_DAEMON_LOG;
  const runtimeFile = `${daemonLog}.runtime.json`;
  const stateDatabase = path.join(stateDir, "state", "openclaw.sqlite");
  const installedVersion = () => read(path.join(root, "package.json")).version;
  const evidence = {
    status: "running",
    runDirectory: path.basename(artifacts),
    selectedCuts: ["owed-plugin-retry-schedule"],
    scope: "installed-owed-plugin-retry-schedule-live-gateway",
    schedule,
    commands: [],
  };
  write(summary, evidence);
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const run = async (name, args, expected) => {
    console.log(`[owed-retry-schedule] ${name}`);
    const result = await runInstalledRecoveryCommand({
      bin: node,
      args: [bin, ...args],
      env,
      stdout: path.join(artifacts, `${name}.out`),
      stderr: path.join(artifacts, `${name}.err`),
      timeout,
      timeoutKillGraceMs: 10_000,
      record: (outcome) => {
        evidence.current = {
          cut: null,
          name,
          stdout: `${name}.out`,
          stderr: `${name}.err`,
          ...outcome,
        };
        write(summary, evidence);
      },
    });
    evidence.commands.push({ name, args, status: result.status });
    write(summary, evidence);
    assert.equal(result.status, expected, `${name}: exit ${result.status}`);
    return result;
  };
  const runs = () =>
    readDatabase(stateDatabase, (db) =>
      db
        .prepare(
          "SELECT run_id, trigger, status, steps_json, target_json, before_json FROM update_runs ORDER BY created_at_ms",
        )
        .all()
        .map((row) => ({
          runId: row.run_id,
          trigger: row.trigger,
          status: row.status,
          steps: JSON.parse(row.steps_json),
          target: JSON.parse(row.target_json),
          before: JSON.parse(row.before_json),
        })),
    );
  const checkState = () =>
    readDatabase(stateDatabase, (db) =>
      JSON.parse(
        db
          .prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?")
          .get("update.checkState")?.value_json ?? "{}",
      ),
    );
  const mutate = (change) => {
    const db = new DatabaseSync(stateDatabase);
    try {
      change(db);
    } finally {
      db.close();
    }
  };
  /** Fixture time: the throttle is two hours old and the installing attempt is `attemptAgoMs` old. */
  const setCheckState = (version, attemptAgoMs) => {
    const next = {
      ...checkState(),
      lastCheckedAt: new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
      autoLastAttemptVersion: version,
      autoLastAttemptAt: new Date(Date.now() - attemptAgoMs).toISOString(),
    };
    mutate((db) =>
      db
        .prepare(
          "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?) ON CONFLICT(state_key) DO UPDATE SET value_json = excluded.value_json, updated_at_ms = excluded.updated_at_ms",
        )
        .run("update.checkState", JSON.stringify(next), Date.now()),
    );
    return next;
  };
  const serviceEnv = { ...env };
  // The cell's shell opts out of automatic updates; this service runs without that opt-out.
  delete serviceEnv.OPENCLAW_NO_AUTO_UPDATE;
  const systemctl = (...args) => {
    const manager = spawnSync("systemctl", ["--user", ...args], {
      env: serviceEnv,
      stdio: "ignore",
    });
    assert.equal(manager.status, 0, `systemctl ${args.join(" ")}`);
  };
  const serving = async () => {
    try {
      const { pid } = read(runtimeFile);
      const ready = await fetch(`http://127.0.0.1:${port}/readyz`).then(
        (response) => response.status === 200,
        () => false,
      );
      return ready && fs.existsSync(`/proc/${pid}`) && pid;
    } catch {
      return false;
    }
  };
  const waitFor = async (name, predicate, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await predicate();
      if (value) {
        return value;
      }
      assert(Date.now() < deadline, `${name}: timed out`);
      await delay(1_000);
    }
  };
  const logLines = (pattern) =>
    fs.existsSync(daemonLog)
      ? fs
          .readFileSync(daemonLog, "utf8")
          .split("\n")
          .filter((line) => pattern.test(line))
      : [];
  const retryAnnounced = /automatic update will retry owed plugin steps/u;

  // A real update installs the version that will owe the step.
  const owedTarget = path.join(artifacts, "owed-update.tgz");
  packFirstHopUpdateFixture(tarball, owedTarget, 5);
  const owedVersion = JSON.parse(
    execFileSync("tar", ["-xOf", owedTarget, "package/package.json"], { encoding: "utf8" }),
  ).version;
  await waitFor("baseline", serving, 5 * 60_000);
  await run("owed-update", ["update", "--tag", `file:${owedTarget}`, "--yes", "--json"], 0);
  assert.equal(installedVersion(), owedVersion);
  const [owner] = runs().slice(-1);
  assert.equal(owner.status, "succeeded");
  await waitFor("owed-update-serving", serving, 5 * 60_000);

  const registryDirectory = fs.mkdtempSync(path.join(artifacts, "owed-registry-"));
  const registryPort = path.join(registryDirectory, "port");
  const registryLog = fs.openSync(path.join(artifacts, "owed-registry.log"), "a");
  const unitFile = path.join(env.HOME, ".config/systemd/user/openclaw-gateway.service");
  const unit = fs.readFileSync(unitFile, "utf8");
  // Observe spawn failure and exit from creation, so neither can escape as an unhandled event.
  const registry = spawn(
    node,
    [
      fileURLToPath(new URL("../plugins/npm-registry-server.mjs", import.meta.url)),
      registryPort,
      "openclaw",
      owedVersion,
      owedTarget,
    ],
    {
      env: {
        ...env,
        OPENCLAW_NPM_REGISTRY_UPSTREAM: "",
        OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_URL: "",
        OPENCLAW_NPM_REGISTRY_BIND_HOST: "127.0.0.1",
        OPENCLAW_NPM_REGISTRY_PORT: "0",
      },
      stdio: ["ignore", registryLog, registryLog],
    },
  );
  const registryExit = new Promise((resolve) => {
    registry.once("error", (error) => resolve({ error }));
    registry.once("close", (code, signal) => resolve({ code, signal }));
  });
  let registryEnded;
  void registryExit.then((outcome) => {
    registryEnded = outcome;
  });
  try {
    const registryAddress = await waitFor(
      "owed-registry",
      () => {
        assert(registryEnded === undefined, `owed registry ended: ${inspect(registryEnded)}`);
        return fs.existsSync(registryPort) && fs.readFileSync(registryPort, "utf8");
      },
      30_000,
    );
    systemctl("stop", "openclaw-gateway.service");
    // Fixture: the kept update owes plugin convergence, in the row shape the updater writes.
    mutate((db) => {
      const steps = [
        ...runs().find((row) => row.runId === owner.runId).steps,
        {
          step: owedStep,
          status: "skipped",
          endedAtMs: Date.now(),
          detail: "Fixture: plugin convergence threw before publishing",
        },
      ];
      db.prepare("UPDATE update_runs SET steps_json = ? WHERE run_id = ?").run(
        JSON.stringify(steps),
        owner.runId,
      );
    });
    const registryUrl = `http://127.0.0.1:${registryAddress}`;
    const redirect = fileURLToPath(new URL("./plugin-registry-redirect.mjs", import.meta.url));
    assert(unit.includes("\nEnvironment=NODE_OPTIONS=\n"), "the unit must pin NODE_OPTIONS");
    fs.writeFileSync(
      unitFile,
      unit.replace(
        "\nEnvironment=NODE_OPTIONS=\n",
        [
          "",
          `Environment=NODE_OPTIONS=--import=${redirect}`,
          `Environment=OPENCLAW_UPGRADE_SURVIVOR_NPM_REGISTRY=${registryUrl}`,
          "Environment=OPENCLAW_UPGRADE_SURVIVOR_NPM_REGISTRY_CORE=1",
          "Environment=OPENCLAW_UPDATE_PACKAGE_SPEC=openclaw",
          `Environment=NPM_CONFIG_REGISTRY=${registryUrl}`,
          "",
        ].join("\n"),
      ),
    );
    systemctl("daemon-reload");
    await run(
      "enable-auto-schedule",
      [
        "config",
        "set",
        "update",
        JSON.stringify({ channel: "stable", auto: { enabled: true, schedule } }),
        "--strict-json",
      ],
      0,
    );

    // Phase 1: the automatic update that installed this version started five minutes ago.
    const early = setCheckState(owedVersion, 5 * 60_000);
    const runsBefore = new Set(runs().map((row) => row.runId));
    systemctl("start", "openclaw-gateway.service");
    await waitFor("early-serving", serving, 5 * 60_000);
    await waitFor(
      "early-first-check",
      () => checkState().lastCheckedAt !== early.lastCheckedAt,
      5 * 60_000,
    );
    const firstCheckAt = checkState().lastCheckedAt;
    // Three more windows: each one checks again, and each must decline to start the retry.
    await waitFor(
      "early-three-windows",
      () => Date.parse(checkState().lastCheckedAt) >= Date.parse(firstCheckAt) + 3 * 60_000,
      6 * 60_000,
    );
    // Longer than the countdown a campaign would need before it creates its update run.
    await delay(75_000);
    evidence.early = {
      attemptAt: early.autoLastAttemptAt,
      firstCheckAt,
      lastCheckedAt: checkState().lastCheckedAt,
      newRuns: runs()
        .filter((row) => !runsBefore.has(row.runId))
        .map(({ runId, trigger, status }) => ({ runId, trigger, status })),
      announcements: logLines(retryAnnounced).length,
    };
    write(summary, evidence);
    assert.deepEqual(
      evidence.early.newRuns,
      [],
      "no retry within the hour after the installing update",
    );
    assert.equal(
      runs()
        .find((row) => row.runId === owner.runId)
        .steps.find(({ step }) => step === owedStep)?.status,
      "skipped",
      "the step stays owed",
    );

    // Phase 2: the same attempt is now two hours old; the next window retries once.
    systemctl("stop", "openclaw-gateway.service");
    const late = setCheckState(owedVersion, 2 * 60 * 60_000);
    systemctl("start", "openclaw-gateway.service");
    const retry = await waitFor(
      "late-retry",
      () =>
        runs().find(
          (row) =>
            !runsBefore.has(row.runId) && row.trigger === "campaign" && row.status !== "running",
        ),
      10 * 60_000,
    );
    await waitFor("late-serving", serving, 5 * 60_000);
    await waitFor(
      "late-next-check",
      () => checkState().lastCheckedAt !== late.lastCheckedAt,
      5 * 60_000,
    );
    const settledAt = checkState().lastCheckedAt;
    // Two more windows after the retry settled: no second campaign.
    await waitFor(
      "late-two-windows",
      () => Date.parse(checkState().lastCheckedAt) >= Date.parse(settledAt) + 2 * 60_000,
      5 * 60_000,
    );
    await delay(75_000);
    const after = runs();
    evidence.late = {
      attemptAt: late.autoLastAttemptAt,
      retry: {
        runId: retry.runId,
        trigger: retry.trigger,
        status: retry.status,
        before: retry.before.version,
        target: retry.target.version,
      },
      ownerOwedStep: after
        .find((row) => row.runId === owner.runId)
        .steps.find(({ step }) => step === owedStep)?.status,
      campaignRuns: after.filter((row) => !runsBefore.has(row.runId)).length,
      announcements: logLines(retryAnnounced).length,
      lastCheckedAt: checkState().lastCheckedAt,
    };
    write(summary, evidence);
    assert.notEqual(retry.status, "failed", "the same-version update keeps its result");
    assert.deepEqual([retry.before, retry.target], [owedVersion, owedVersion]);
    assert.equal(evidence.late.ownerOwedStep, "completed", "the retry settles the row");
    assert.equal(evidence.late.campaignRuns, 1, "exactly one retry");
    assert.equal(installedVersion(), owedVersion, "the core is unchanged");
    assert(await serving(), "the Gateway serves after the retry");
    evidence.status = "passed";
    delete evidence.current;
    write(summary, evidence);
  } finally {
    fs.writeFileSync(unitFile, unit);
    spawnSync("systemctl", ["--user", "daemon-reload"], { env, stdio: "ignore" });
    if (registryEnded === undefined) {
      registry.kill("SIGTERM");
      if ((await Promise.race([registryExit, delay(10_000, "timeout")])) === "timeout") {
        registry.kill("SIGKILL");
      }
    }
    await registryExit;
    fs.closeSync(registryLog);
    fs.rmSync(owedTarget, { force: true });
  }
}

let driverError;
let failed = false;
try {
  const artifacts = process.argv[2];
  assert(artifacts && path.isAbsolute(artifacts));
  // Assertion values can carry config bytes; keep the whole exception private.
  driverError = openInstalledRecoveryEvidence(path.join(artifacts, "driver.err"));
  await main(process.argv.slice(2));
  console.log("[owed-retry-schedule] PASS: no retry within the hour; exactly one after it");
} catch (error) {
  failed = true;
  if (driverError !== undefined) {
    fs.writeFileSync(driverError, `${inspect(error, { customInspect: false })}\n`);
  }
} finally {
  if (driverError !== undefined) {
    fs.closeSync(driverError);
  }
  if (failed) {
    console.error("[owed-retry-schedule] inspect driver.err in the private run evidence");
    console.error("[owed-retry-schedule] FAILED (exit 1)");
    process.exitCode = 1;
  }
}
