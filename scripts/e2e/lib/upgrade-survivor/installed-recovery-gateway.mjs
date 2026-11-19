// A killed `openclaw update` that stopped a real managed Gateway: a plain next update
// finishes it and the Gateway serves the version that update installed. With
// --no-restart the next update refuses and names repair, which restores the Gateway.
// The owed-plugin-retry cut instead proves that, with automatic updates on, the Gateway
// itself retries owed plugin convergence once.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import {
  packFirstHopUpdateFixture,
  packKilledUpdaterDoctorFixture,
} from "../update-first-hop-package-fixtures.mjs";
import { runInstalledRecoveryCommand } from "./installed-recovery-command.mjs";
import {
  assertPackageTree,
  capturePackageTree,
  openInstalledRecoveryEvidence,
  writeInstalledRecoveryEvidence as write,
} from "./installed-recovery-observations.mjs";
import { readDatabase } from "./observations.mjs";

const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const packedVersion = (tarball) =>
  JSON.parse(execFileSync("tar", ["-xOf", tarball, "package/package.json"], { encoding: "utf8" }))
    .version;
const port = 18789;

async function main([artifacts, prefix, tarball, configPath, summary]) {
  const timeout = process.env.OPENCLAW_E2E_COMMAND_TIMEOUT;
  assert(timeout !== undefined, "missing survivor command timeout");
  assert.equal(process.platform, "linux", "the live Gateway cell owns a disposable container");
  for (const file of [artifacts, prefix, tarball, configPath, summary]) {
    assert(file && path.isAbsolute(file));
  }
  const root = fs.realpathSync(path.join(prefix, "lib/node_modules/openclaw"));
  const bin = path.join(prefix, "bin/openclaw");
  const node = fs.realpathSync(process.execPath);
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  assert(stateDir && path.isAbsolute(stateDir), "missing isolated state directory");
  const token = process.env.GATEWAY_AUTH_TOKEN_REF;
  assert(token, "missing fixture Gateway token");
  const runtimeFile = `${process.env.OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_DAEMON_LOG}.runtime.json`;
  const stateDatabase = path.join(stateDir, "state", "openclaw.sqlite");
  const installedVersion = () => read(path.join(root, "package.json")).version;
  // The first update creates update history.
  const runs = () =>
    readDatabase(stateDatabase, (db) =>
      (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'update_runs'").get()
        ? db.prepare("SELECT run_id, trigger, status, reason, steps_json FROM update_runs").all()
        : []
      ).map(({ run_id, trigger, status, reason, steps_json }) => ({
        run_id,
        trigger,
        status,
        reason,
        steps: JSON.parse(steps_json),
      })),
    );
  const hasStep = (run, name, status = "completed") =>
    run.steps.some((step) => step.step === name && step.status === status);

  const cut = process.env.OPENCLAW_UPGRADE_SURVIVOR_INSTALLED_RECOVERY_CUT;
  assert(["live-gateway", "owed-plugin-retry"].includes(cut), "unknown live Gateway cut");
  const evidence = {
    status: "running",
    runDirectory: path.basename(artifacts),
    selectedCuts: [cut],
    scope:
      cut === "owed-plugin-retry"
        ? "installed-owed-plugin-retry-live-gateway"
        : "installed-killed-update-live-gateway",
    commands: [],
  };
  write(summary, evidence);
  // The cell's shell already exports the fixture service manager's environment.
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const killedStatus = 128 + 9;
  const run = async (name, args, expected) => {
    console.log(`[installed-recovery-gateway] ${name}`);
    const result = await runInstalledRecoveryCommand({
      bin: node,
      args: [bin, ...args],
      env,
      stdout: path.join(artifacts, `${name}.out`),
      stderr: path.join(artifacts, `${name}.err`),
      timeout,
      timeoutKillGraceMs: 10_000,
      record: (outcome) => {
        // Root-level files: the shared diagnostics reader publishes this cut-less record.
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
    evidence.commands.push({
      name,
      args: args.map((arg) => (arg === token ? "<fixture-token>" : arg)),
      status: result.status,
    });
    write(summary, evidence);
    assert.equal(result.status, expected, `${name}: exit ${result.status}`);
    return result;
  };

  const serviceActive = () =>
    spawnSync("systemctl", ["--user", "is-active", "--quiet", "openclaw-gateway.service"], {
      env,
      stdio: "ignore",
    }).status;
  const readyz = () =>
    fetch(`http://127.0.0.1:${port}/readyz`).then(
      (response) => response.status,
      () => "refused",
    );
  const alive = (pid) => {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      return !stat.split(") ").at(-1).startsWith("Z ");
    } catch (error) {
      if (error.code === "ENOENT") {
        return false;
      }
      throw error;
    }
  };
  /** The managed Gateway serves `version` from the installed package, through its own hello. */
  const assertServing = async (name, version, previousPid) => {
    assert.equal(serviceActive(), 0, `${name}: managed service must be active`);
    const { pid } = read(runtimeFile);
    assert(Number.isSafeInteger(pid) && pid > 1 && alive(pid), `${name}: Gateway must run`);
    if (previousPid !== undefined) {
      assert.notEqual(pid, previousPid, `${name}: a new Gateway process must serve`);
    }
    assert.equal(await readyz(), 200, `${name}: Gateway must be ready`);
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
    assert(
      cmdline.some((arg) => arg.startsWith(`${root}/`)),
      `${name}: Gateway must run the installed package`,
    );
    const probe = await run(
      `${name}-probe`,
      ["gateway", "probe", "--url", `ws://127.0.0.1:${port}`, "--token", token, "--json"],
      0,
    );
    const target = JSON.parse(probe.stdout).targets.find(
      (entry) => entry.url === `ws://127.0.0.1:${port}`,
    );
    assert.equal(target?.connect?.ok, true, `${name}: Gateway hello must succeed`);
    assert.equal(target.server.version, version, `${name}: Gateway must serve ${version}`);
    return pid;
  };
  const assertStopped = async (name, previousPid) => {
    assert.equal(serviceActive(), 3, `${name}: managed service must be inactive`);
    assert.equal(alive(previousPid), false, `${name}: the stopped Gateway must be gone`);
    assert.equal(await readyz(), "refused", `${name}: nothing may listen on the Gateway port`);
  };

  /** Kill an updater in its post-activation Doctor, after it stopped the Gateway. */
  const killUpdate = async (name, sequence, servingPid) => {
    const target = path.join(artifacts, `${name}.tgz`);
    const marker = path.join(artifacts, `${name}.doctor`);
    packKilledUpdaterDoctorFixture(tarball, target, stateDir, marker, sequence);
    const version = packedVersion(target);
    const before = new Set(runs().map((row) => row.run_id));
    await run(name, ["update", "--tag", `file:${target}`, "--yes", "--json"], killedStatus);
    assert(fs.existsSync(marker), `${name}: the post-activation Doctor must kill the updater`);
    assert.equal(installedVersion(), version, `${name}: the candidate must be installed`);
    const [killed, ...others] = runs().filter((row) => !before.has(row.run_id));
    assert.equal(others.length, 0);
    assert.deepEqual([killed.trigger, killed.status], ["cli", "running"]);
    assert(hasStep(killed, "service-stop"), `${name}: the update must record its Gateway stop`);
    await assertStopped(name, servingPid);
    fs.unlinkSync(target);
    return { runId: killed.run_id, version };
  };
  const assertKilledRetired = (name, runId) => {
    const after = runs();
    const killed = after.find((row) => row.run_id === runId);
    assert.deepEqual([killed.status, killed.reason], ["failed", "abandoned"], name);
    assert(hasStep(killed, "reconcile:acknowledged"), `${name}: the killed run is acknowledged`);
    assert.deepEqual(
      after.filter((row) => row.status === "running").map((row) => row.run_id),
      [],
      `${name}: no run may be left running`,
    );
  };

  /** With automatic updates on, the Gateway itself retries owed plugin convergence once. */
  const retryOwedPluginConvergence = async (previousPid) => {
    // With automatic updates on, a kept update that still owes plugin convergence is
    // retried once by the Gateway itself, through a campaign for the installed version.
    const owedTarget = path.join(artifacts, "owed-update.tgz");
    packFirstHopUpdateFixture(tarball, owedTarget, 5);
    const owedVersion = packedVersion(owedTarget);
    const beforeOwed = new Set(runs().map((row) => row.run_id));
    await run("owed-update", ["update", "--tag", `file:${owedTarget}`, "--yes", "--json"], 0);
    const [owner, ...extraOwners] = runs().filter((row) => !beforeOwed.has(row.run_id));
    assert.equal(extraOwners.length, 0, "one update run installs the owed version");
    assert.equal(owner?.status, "succeeded");
    const owedPid = await assertServing("owed-update", owedVersion, previousPid);
    const owedStep = "finalize:owed:plugin-convergence";
    const unitFile = path.join(env.HOME, ".config/systemd/user/openclaw-gateway.service");
    const unit = fs.readFileSync(unitFile, "utf8");
    const registryDirectory = fs.mkdtempSync(path.join(artifacts, "owed-registry-"));
    const registryPort = path.join(registryDirectory, "port");
    const registryLog = fs.openSync(path.join(artifacts, "owed-registry.log"), "a");
    // The package registry names the installed version as current for stable.
    let registryError;
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
          OPENCLAW_NPM_REGISTRY_DIST_TAGS: `beta=${owedVersion}`,
          OPENCLAW_NPM_REGISTRY_BIND_HOST: "127.0.0.1",
          OPENCLAW_NPM_REGISTRY_PORT: "0",
        },
        stdio: ["ignore", registryLog, registryLog],
      },
    );
    registry.once("error", (error) => {
      registryError = error;
    });
    const registryExit = once(registry, "close");
    // The cell's shell opts out of automatic updates; this service runs without that opt-out.
    const serviceEnv = { ...env };
    delete serviceEnv.OPENCLAW_NO_AUTO_UPDATE;
    const systemctl = (...args) => {
      const manager = spawnSync("systemctl", ["--user", ...args], {
        env: serviceEnv,
        stdio: "ignore",
      });
      assert.equal(manager.status, 0, `systemctl ${args.join(" ")}`);
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
    const checkState = () =>
      readDatabase(stateDatabase, (db) =>
        JSON.parse(
          db
            .prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?")
            .get("update.checkState")?.value_json ?? "{}",
        ),
      );
    const writeState = (mutate) => {
      const db = new DatabaseSync(stateDatabase);
      try {
        mutate(db);
      } finally {
        db.close();
      }
    };
    /** Fixture time: the hourly check and automatic-attempt throttles are two hours old. */
    const shiftChecksBack = () => {
      const earlier = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
      const shifted = { ...checkState(), lastCheckedAt: earlier, autoLastAttemptAt: earlier };
      writeState((db) =>
        db
          .prepare(
            "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES (?, ?, ?) ON CONFLICT(state_key) DO UPDATE SET value_json = excluded.value_json, updated_at_ms = excluded.updated_at_ms",
          )
          .run("update.checkState", JSON.stringify(shifted), Date.now()),
      );
      return earlier;
    };
    try {
      const registryAddress = await waitFor(
        "owed-registry",
        () => {
          if (registryError || registry.exitCode !== null) {
            throw registryError ?? new Error(`owed registry exited ${registry.exitCode}`);
          }
          return fs.existsSync(registryPort) && fs.readFileSync(registryPort, "utf8");
        },
        30_000,
      );
      // Fixture: the update kept its result but owes plugin convergence, recorded in the
      // same row shape the updater writes when convergence cannot complete.
      systemctl("stop", "openclaw-gateway.service");
      writeState((db) => {
        // Reread after the stop so steps the Gateway recorded on this run are kept.
        const steps = [
          ...runs().find((row) => row.run_id === owner.run_id).steps,
          {
            step: owedStep,
            status: "skipped",
            endedAtMs: Date.now(),
            detail: "Fixture: the plugin registry was unreachable",
          },
        ];
        db.prepare("UPDATE update_runs SET steps_json = ? WHERE run_id = ?").run(
          JSON.stringify(steps),
          owner.run_id,
        );
      });
      // Point this service's registry reads at the fixture registry: the updater's loopback
      // seam, and a harness preload for the Gateway's release discovery, which reads public npm.
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
        "owed-enable-auto",
        [
          "config",
          "set",
          "update",
          JSON.stringify({ channel: "stable", auto: { enabled: true } }),
          "--strict-json",
        ],
        0,
      );
      await run("owed-status-before", ["update", "status", "--json"], 0);
      // The update that installed this version ran its own check within the hour.
      const firstEarlier = shiftChecksBack();
      systemctl("start", "openclaw-gateway.service");
      await waitFor(
        "owed-first-check",
        () => checkState().lastCheckedAt !== firstEarlier,
        5 * 60_000,
      );

      // No person runs a command: the Gateway announces, waits for idle, and hands off.
      const retry = await waitFor(
        "owed-campaign",
        () =>
          runs().find(
            (row) =>
              !beforeOwed.has(row.run_id) &&
              row.run_id !== owner.run_id &&
              row.status !== "running",
          ),
        10 * 60_000,
      );
      const retryRecord = readDatabase(stateDatabase, (db) =>
        db
          .prepare("SELECT target_json, before_json FROM update_runs WHERE run_id = ?")
          .get(retry.run_id),
      );
      const retryPid = await waitFor(
        "owed-serving",
        async () => {
          const { pid } = read(runtimeFile);
          return serviceActive() === 0 && pid > 1 && alive(pid) && (await readyz()) === 200 && pid;
        },
        5 * 60_000,
      );
      const statusAfter = await run("owed-status-after", ["update", "status", "--json"], 0);
      const ownerAfter = runs().find((row) => row.run_id === owner.run_id);
      evidence.owedPluginRetry = {
        ownerRunId: owner.run_id,
        version: owedVersion,
        retry: {
          runId: retry.run_id,
          trigger: retry.trigger,
          status: retry.status,
          reason: retry.reason,
          target: JSON.parse(retryRecord.target_json),
          before: JSON.parse(retryRecord.before_json),
          steps: retry.steps.map((entry) => `${entry.step}:${entry.status}`),
        },
        ownerOwedStep: ownerAfter.steps.find(({ step }) => step === owedStep)?.status,
        owedSteps: JSON.parse(statusAfter.stdout).owedSteps ?? [],
        gatewayPids: [owedPid, retryPid],
      };
      write(summary, evidence);
      assert.equal(retry.trigger, "campaign");
      assert.notEqual(retry.status, "failed", "the same-version update must keep its result");
      assert.deepEqual(
        [
          evidence.owedPluginRetry.retry.target.version,
          evidence.owedPluginRetry.retry.before.version,
        ],
        [owedVersion, owedVersion],
      );
      assert.equal(
        evidence.owedPluginRetry.ownerOwedStep,
        "completed",
        "the retry settles the row",
      );
      assert.deepEqual(evidence.owedPluginRetry.owedSteps, [], "nothing stays owed");
      assert.equal(installedVersion(), owedVersion, "the core is unchanged");
      await assertServing("owed-retry", owedVersion);

      // Two hours later the next check finds nothing to retry and starts no campaign.
      systemctl("stop", "openclaw-gateway.service");
      const earlier = shiftChecksBack();
      const settledRuns = runs().map((row) => row.run_id);
      systemctl("start", "openclaw-gateway.service");
      await waitFor("owed-next-check", () => checkState().lastCheckedAt !== earlier, 5 * 60_000);
      // Longer than the one-minute countdown a campaign would need before its update run.
      await delay(90_000);
      evidence.owedPluginRetry.nextCheck = {
        lastCheckedAt: checkState().lastCheckedAt,
        runs: runs().map((row) => row.run_id),
      };
      write(summary, evidence);
      assert.deepEqual(evidence.owedPluginRetry.nextCheck.runs, settledRuns, "no second campaign");
      await assertServing("owed-next-check", owedVersion);
    } finally {
      // Best effort: a failed assertion must still leave the original unit and no registry.
      fs.writeFileSync(unitFile, unit);
      spawnSync("systemctl", ["--user", "daemon-reload"], { env, stdio: "ignore" });
      if (registry.exitCode === null && registry.signalCode === null) {
        registry.kill("SIGTERM");
        if ((await Promise.race([registryExit, delay(10_000, "timeout")])) === "timeout") {
          registry.kill("SIGKILL");
        }
      }
      await registryExit;
      fs.closeSync(registryLog);
      fs.rmSync(owedTarget, { force: true });
    }
  };

  const baselineVersion = installedVersion();
  const firstPid = await assertServing("baseline", baselineVersion);
  if (cut === "owed-plugin-retry") {
    await retryOwedPluginConvergence(firstPid);
    evidence.status = "passed";
    delete evidence.current;
    write(summary, evidence);
    console.log(
      "[installed-recovery-gateway] PASS: the Gateway retried owed plugin convergence once",
    );
    return;
  }

  // A plain next update finishes the killed one itself: one result document,
  // the Gateway serving the version this update installed.
  const killed = await killUpdate("killed-update", 1, firstPid);
  const before = new Set(runs().map((row) => row.run_id));
  const nextTarget = path.join(artifacts, "next-update.tgz");
  packFirstHopUpdateFixture(tarball, nextTarget, 2);
  const nextVersion = packedVersion(nextTarget);
  const next = await run(
    "next-update",
    ["update", "--tag", `file:${nextTarget}`, "--yes", "--json"],
    0,
  );
  const result = JSON.parse(next.stdout.trim());
  const after = runs();
  const created = after.filter((row) => !before.has(row.run_id));
  // Record what the update left before asserting on it.
  evidence.plainUpdate = {
    killedRunId: killed.runId,
    killedVersion: killed.version,
    nextVersion,
    resultStatus: result.status,
    runs: [after.find((row) => row.run_id === killed.runId), ...created].map((row) => ({
      runId: row?.run_id,
      status: row?.status,
      reason: row?.reason,
      steps: row?.steps.map(({ step, status }) => `${step}:${status}`),
    })),
  };
  write(summary, evidence);
  assert.equal(result.status, "ok");
  assert.equal(installedVersion(), nextVersion);
  assertKilledRetired("next-update", killed.runId);
  const isStage = (row) => hasStep(row, "finalize:repair-continuation");
  const [stage, ...otherStages] = created.filter(isStage);
  const [nextRun, ...otherRuns] = created.filter((row) => !isStage(row));
  assert.equal(otherStages.length, 0, "one repair-shaped run finishes the killed update");
  assert.deepEqual([stage?.trigger, stage?.status], ["cli", "succeeded"]);
  assert(hasStep(stage, "finalize:gatewayRestoration"), "the stage restores the Gateway");
  assert.equal(otherRuns.length, 0);
  assert.equal(nextRun?.status, "succeeded");
  // Step history keeps these warnings; their bare step records are evictable diagnostics.
  const detail = (name) => nextRun.steps.find(({ step }) => step === `warning:${name}`)?.detail;
  assert.match(detail("interrupted-update-recovery") ?? "", /stopped the Gateway/u);
  const pointer = detail("interrupted-update-finalization") ?? "";
  assert(pointer.includes(killed.runId) && pointer.includes(stage.run_id), pointer);
  const nextPid = await assertServing("next-update", nextVersion, firstPid);
  Object.assign(evidence.plainUpdate, {
    stageRunId: stage.run_id,
    nextRunId: nextRun.run_id,
    gatewayPids: [firstPid, nextPid],
  });
  write(summary, evidence);
  fs.unlinkSync(nextTarget);

  // With --no-restart the next update cannot finish a Gateway stop: it refuses,
  // names repair, and changes nothing. Repair then starts the Gateway again.
  const stopped = await killUpdate("killed-update-no-restart", 3, nextPid);
  const config = fs.readFileSync(configPath);
  const history = runs();
  const tree = capturePackageTree(root);
  const refusedTarget = path.join(artifacts, "refused-update.tgz");
  packFirstHopUpdateFixture(tarball, refusedTarget, 4);
  const refused = await run(
    "refused-update",
    ["update", "--tag", `file:${refusedTarget}`, "--yes", "--no-restart", "--json"],
    1,
  );
  const refusal = `${refused.stdout}\n${refused.stderr}`;
  assert.match(refusal, /asked not to restart it/u);
  assert.match(refusal, /Run openclaw update repair to settle it and restart the Gateway/u);
  assert.deepEqual(runs(), history, "the refused update must not change update history");
  assert.deepEqual(fs.readFileSync(configPath), config, "the refused update changed config");
  assertPackageTree(tree, capturePackageTree(root));
  await assertStopped("refused-update", nextPid);
  fs.unlinkSync(refusedTarget);

  const repaired = await run("update-repair", ["update", "repair", "--yes", "--json"], 0);
  const repair = JSON.parse(repaired.stdout.trim());
  evidence.noRestart = {
    killedRunId: stopped.runId,
    killedVersion: stopped.version,
    refusedExit: refused.status,
    repairStatus: repair.status,
    reconciledRuns: repair.reconciledRuns,
  };
  write(summary, evidence);
  assert(["ok", "warning"].includes(repair.status), `update repair status ${repair.status}`);
  assert(repair.reconciledRuns.includes(stopped.runId), "update repair must settle the killed run");
  assertKilledRetired("update-repair", stopped.runId);
  const repairedPid = await assertServing("update-repair", stopped.version, nextPid);
  evidence.noRestart.gatewayPids = [nextPid, repairedPid];
  write(summary, evidence);

  evidence.status = "passed";
  delete evidence.current;
  write(summary, evidence);
  console.log("[installed-recovery-gateway] PASS: refusal, repair, and plain update restore it");
}

let driverError;
let failed = false;
try {
  const artifacts = process.argv[2];
  assert(artifacts && path.isAbsolute(artifacts));
  // Assertion values can carry config bytes; keep the whole exception private.
  driverError = openInstalledRecoveryEvidence(path.join(artifacts, "driver.err"));
  await main(process.argv.slice(2));
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
    console.error("[installed-recovery-gateway] inspect driver.err in the private run evidence");
    console.error("[installed-recovery-gateway] FAILED (exit 1)");
    process.exitCode = 1;
  }
}
