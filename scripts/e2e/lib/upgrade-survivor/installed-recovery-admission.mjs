// What the next plain `openclaw update` may settle by itself after a real killed update,
// in a container that shares the host's PID namespace and machine identity:
// 1. A machine restart cleared the update lease store. The update must refuse and name
//    repair, because a container restart is not a host restart; repair then restores it.
// 2. The killed run and 99 older routine runs fill one 100-row history page. The update
//    must finish the killed run itself and serve the version it installed.
// Every check is recorded before the cell fails, so one run shows each outcome.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { inspect } from "node:util";
import {
  packFirstHopUpdateFixture,
  packKilledUpdaterDoctorFixture,
} from "../update-first-hop-package-fixtures.mjs";
import { runInstalledRecoveryCommand } from "./installed-recovery-command.mjs";
import {
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
const HOST_PID_NAMESPACE = "pid:[4026531836]";

async function main([artifacts, prefix, tarball, configPath, summary]) {
  const timeout = process.env.OPENCLAW_E2E_COMMAND_TIMEOUT;
  assert(timeout !== undefined, "missing survivor command timeout");
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
  const runs = () =>
    readDatabase(stateDatabase, (db) =>
      (db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'update_runs'").get()
        ? db
            .prepare(
              "SELECT run_id, trigger, status, reason, steps_json, origin_json, created_at_ms, updated_at_ms FROM update_runs ORDER BY created_at_ms DESC, run_id DESC",
            )
            .all()
        : []
      ).map((row) => ({
        run_id: row.run_id,
        trigger: row.trigger,
        status: row.status,
        reason: row.reason,
        steps: JSON.parse(row.steps_json),
        origin: JSON.parse(row.origin_json),
        created_at_ms: row.created_at_ms,
        updated_at_ms: row.updated_at_ms,
      })),
    );
  const cohort = (runId) =>
    readDatabase(
      stateDatabase,
      (db) =>
        db
          .prepare("SELECT value_json FROM config_machine_state WHERE state_key = ?")
          .get(`update.pluginCohort.${runId}`)?.value_json ?? null,
    );
  const hasStep = (run, name, status = "completed") =>
    run?.steps.some((step) => step.step === name && step.status === status) === true;

  const evidence = {
    status: "running",
    runDirectory: path.basename(artifacts),
    selectedCuts: ["killed-run-admission"],
    scope: "installed-killed-update-admission",
    seeded: [],
    checks: [],
    commands: [],
  };
  write(summary, evidence);
  /** Record a check and keep going, so a red run shows every outcome. */
  const check = (name, condition, detail) => {
    const passed = Boolean(condition);
    evidence.checks.push({ name, passed, ...(passed ? {} : { detail: String(detail ?? "") }) });
    write(summary, evidence);
    console.log(`[installed-recovery-admission] ${passed ? "PASS" : "FAIL"}: ${name}`);
    return passed;
  };
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const run = async (name, args) => {
    console.log(`[installed-recovery-admission] $ openclaw ${args.join(" ")}`);
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
    console.log(`[installed-recovery-admission]   exit ${result.status}`);
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
      return !fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").at(-1).startsWith("Z ");
    } catch (error) {
      if (error.code === "ENOENT") {
        return false;
      }
      throw error;
    }
  };
  /** The managed Gateway answers its own hello with `version`. */
  const serving = async (name) => {
    if (serviceActive() !== 0 || (await readyz()) !== 200) {
      return undefined;
    }
    const { pid } = read(runtimeFile);
    if (!alive(pid)) {
      return undefined;
    }
    const probe = await run(`${name}-probe`, [
      "gateway",
      "probe",
      "--url",
      `ws://127.0.0.1:${port}`,
      "--token",
      token,
      "--json",
    ]);
    const target = JSON.parse(probe.stdout || "{}").targets?.find(
      (entry) => entry.url === `ws://127.0.0.1:${port}`,
    );
    return target?.connect?.ok === true ? { pid, version: target.server.version } : undefined;
  };
  const stopped = async () => serviceActive() === 3 && (await readyz()) === "refused";

  /** A real updater killed in its post-activation Doctor, after it stopped the Gateway. */
  const killUpdate = async (name, sequence) => {
    const target = path.join(artifacts, `${name}.tgz`);
    const marker = path.join(artifacts, `${name}.doctor`);
    packKilledUpdaterDoctorFixture(tarball, target, stateDir, marker, sequence);
    const version = packedVersion(target);
    const before = new Set(runs().map((row) => row.run_id));
    const killed = await run(name, ["update", "--tag", `file:${target}`, "--yes", "--json"]);
    assert.equal(killed.status, 128 + 9, `${name}: the updater must be SIGKILLed`);
    assert(fs.existsSync(marker), `${name}: the post-activation Doctor must kill the updater`);
    assert.equal(installedVersion(), version, `${name}: the candidate must be installed`);
    const [row, ...others] = runs().filter((entry) => !before.has(entry.run_id));
    assert.equal(others.length, 0);
    assert.deepEqual([row.trigger, row.status], ["cli", "running"]);
    assert(hasStep(row, "service-stop"), `${name}: the update must record its Gateway stop`);
    assert(cohort(row.run_id), `${name}: the update must reserve its plugin recovery`);
    assert(await stopped(), `${name}: the Gateway must be stopped`);
    fs.unlinkSync(target);
    return { runId: row.run_id, version };
  };
  const nextTarget = (name, sequence) => {
    const target = path.join(artifacts, `${name}.tgz`);
    packFirstHopUpdateFixture(tarball, target, sequence);
    return { target, version: packedVersion(target) };
  };

  const namespace = fs.readlinkSync("/proc/self/ns/pid");
  evidence.pidNamespace = namespace;
  assert.equal(namespace, HOST_PID_NAMESPACE, "the cell must share the host PID namespace");
  assert(fs.existsSync("/.dockerenv"), "the cell must be a detectable Docker container");
  const baseline = await serving("baseline");
  assert(baseline, "the baseline Gateway must serve");

  // 1. Restart: the lease store is gone, and the killed update ran in an earlier boot.
  const rebootKilled = await killUpdate("reboot-killed", 1);
  const leaseStore = path.join(
    os.tmpdir(),
    `openclaw-${process.getuid()}`,
    "managed-update-handoffs.sqlite",
  );
  for (const suffix of ["", "-wal", "-shm"]) {
    if (fs.existsSync(`${leaseStore}${suffix}`)) {
      fs.renameSync(`${leaseStore}${suffix}`, `${leaseStore}${suffix}.cleared-by-restart`);
    }
  }
  assert(fs.existsSync(`${leaseStore}.cleared-by-restart`), "the lease store must have existed");
  {
    // Seeded: no container can reboot its host. Give the killed run's recorded driver an
    // earlier boot identity of this machine, and move its last activity before this boot.
    const row = runs().find((entry) => entry.run_id === rebootKilled.runId);
    const recorded = JSON.parse(row.origin.driver.namespace);
    assert.equal(recorded[2], HOST_PID_NAMESPACE, "the killed update recorded the host namespace");
    assert(recorded[3], "the killed update recorded this machine's identity");
    const earlierBoot = "00000000-0000-4000-8000-00000000000a";
    const origin = {
      ...row.origin,
      driver: {
        ...row.origin.driver,
        namespace: JSON.stringify([recorded[0], earlierBoot, recorded[2], recorded[3]]),
      },
    };
    const before = Date.now() - os.uptime() * 1000 - 60_000;
    const steps = row.steps;
    for (const step of steps) {
      if (step.startedAtMs) {
        step.startedAtMs = before;
      }
      if (step.endedAtMs) {
        step.endedAtMs = before;
      }
    }
    const db = new DatabaseSync(stateDatabase);
    try {
      db.prepare(
        "UPDATE update_runs SET origin_json = ?, steps_json = ?, created_at_ms = ?, updated_at_ms = ? WHERE run_id = ?",
      ).run(JSON.stringify(origin), JSON.stringify(steps), before, before, rebootKilled.runId);
    } finally {
      db.close();
    }
    evidence.seeded.push(
      "reboot: lease store renamed; killed run's recorded boot identity and activity times moved before this boot",
    );
  }
  const reserved = () => ({
    run: runs().find((entry) => entry.run_id === rebootKilled.runId),
    cohort: cohort(rebootKilled.runId),
    config: fs.readFileSync(configPath, "utf8"),
  });
  const beforeRefusal = reserved();
  const tree = JSON.stringify(capturePackageTree(root));
  const next1 = nextTarget("reboot-next", 2);
  const refused = await run("reboot-next-update", [
    "update",
    "--tag",
    `file:${next1.target}`,
    "--yes",
    "--json",
  ]);
  const refusal = `${refused.stdout}\n${refused.stderr}`;
  evidence.reboot = { killedRunId: rebootKilled.runId, exit: refused.status };
  check("reboot: plain update exits 1", refused.status === 1, `exit ${refused.status}`);
  check(
    "reboot: refusal names the lease store and openclaw update repair",
    /no longer holds that update's lease.*Run openclaw update repair/su.test(refusal),
    refusal.slice(-600),
  );
  check(
    "reboot: killed run, reserved recovery and config unchanged",
    JSON.stringify(reserved()) === JSON.stringify(beforeRefusal),
  );
  check("reboot: installed package unchanged", JSON.stringify(capturePackageTree(root)) === tree);
  check("reboot: Gateway still stopped", await stopped());
  const repaired = await run("reboot-repair", ["update", "repair", "--yes", "--json"]);
  check("reboot: openclaw update repair exits 0", repaired.status === 0, `exit ${repaired.status}`);
  check("reboot: repair settles the recovery", cohort(rebootKilled.runId) === null);
  const afterRepair = await serving("reboot-repair");
  check("reboot: Gateway serves after repair", afterRepair, "not serving");
  fs.rmSync(next1.target, { force: true });

  // 2. History: 99 older routine runs, recorded by the real CLI, then the killed run.
  const next2 = nextTarget("history-next", 4);
  const routine = Math.max(0, 99 - runs().length);
  for (let index = 0; index < routine; index += 1) {
    const preview = await run(`history-dry-run-${index}`, [
      "update",
      "--dry-run",
      "--tag",
      `file:${next2.target}`,
      "--json",
    ]);
    assert.equal(preview.status, 0, `dry run ${index}: exit ${preview.status}`);
  }
  assert.equal(runs().length, 99, "dry runs must each record one routine run");
  const historyKilled = await killUpdate("history-killed", 3);
  const page = runs();
  assert.equal(page.length, 100, "the killed run and 99 older runs fill one page");
  assert.equal(page[0].run_id, historyKilled.runId, "the killed run is the newest");
  const historyBefore = new Set(page.map((row) => row.run_id));
  const finished = await run("history-next-update", [
    "update",
    "--tag",
    `file:${next2.target}`,
    "--yes",
    "--json",
  ]);
  const finishedOutput = `${finished.stdout}\n${finished.stderr}`;
  evidence.history = {
    killedRunId: historyKilled.runId,
    routineRuns: routine,
    exit: finished.status,
  };
  check("history: plain update exits 0", finished.status === 0, finishedOutput.slice(-600));
  check(
    "history: no 'Other update history also needs repair' refusal",
    !/Other update history also needs repair/u.test(finishedOutput),
    finishedOutput.slice(-600),
  );
  check(
    "history: the update installed its target",
    installedVersion() === next2.version,
    installedVersion(),
  );
  const after = runs();
  const killedAfter = after.find((row) => row.run_id === historyKilled.runId);
  check(
    "history: the killed run is retired and acknowledged",
    killedAfter?.status === "failed" &&
      killedAfter.reason === "abandoned" &&
      hasStep(killedAfter, "reconcile:acknowledged"),
    JSON.stringify([killedAfter?.status, killedAfter?.reason]),
  );
  check("history: the reserved recovery is settled", cohort(historyKilled.runId) === null);
  const created = after.filter((row) => !historyBefore.has(row.run_id));
  check(
    "history: one repair-shaped run finished the killed update",
    created.filter((row) => hasStep(row, "finalize:repair-continuation")).length === 1,
    created.map((row) => row.run_id).join(","),
  );
  const finalServing = await serving("history-next-update");
  check(
    "history: Gateway serves the installed version",
    finalServing?.version === next2.version,
    JSON.stringify(finalServing),
  );
  fs.rmSync(next2.target, { force: true });

  const failed = evidence.checks.filter((entry) => !entry.passed);
  evidence.status = failed.length ? "failed" : "passed";
  delete evidence.current;
  write(summary, evidence);
  assert.equal(failed.length, 0, `${failed.length} checks failed`);
  console.log(
    "[installed-recovery-admission] PASS: restart refusal names repair; full history page finishes",
  );
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
    console.error("[installed-recovery-admission] inspect driver.err in the private run evidence");
    console.error("[installed-recovery-admission] FAILED (exit 1)");
    process.exitCode = 1;
  }
}
