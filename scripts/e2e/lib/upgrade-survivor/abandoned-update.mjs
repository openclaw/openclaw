import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const runId = "f9bdb286-8f8a-4b72-a792-3ca83ad07605";
const postCoreRunId = "2ff0cdf2-7fcb-4070-a901-4c4c520253bb";
const failedFinalizeRunId = "75b82c5b-d7bc-4a8a-91dd-27b68aeaf317";
const budgetMs = 15_000;
const [command, first, second, third] = process.argv.slice(2);
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

function withDatabase(stateDir, write, callback) {
  const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
  assert(fs.existsSync(databasePath), "the published Gateway must create its own state database");
  const db = new DatabaseSync(databasePath, { readOnly: !write });
  try {
    return callback(db);
  } finally {
    db.close();
  }
}

function readRun(db, selectedRunId = runId) {
  const row = db.prepare("SELECT * FROM update_runs WHERE run_id = ?").get(selectedRunId);
  assert(row, "the pre-upgrade ledger specimen disappeared");
  return row;
}

function seed(stateDir, artifactRoot, postCore = false) {
  const baseline = readJson(path.join(artifactRoot, "abandoned-update-packages.json")).baseline
    .version;
  withDatabase(stateDir, true, (db) => {
    assert.equal(
      db.prepare("SELECT count(*) AS total FROM update_runs WHERE status = 'running'").get().total,
      0,
      "previous update work must finish before seeding",
    );
    // Deliberately older than the product's shared thirty-minute inactivity bound.
    const lastActivity = Date.now() - 60 * 60_000;
    const selectedRunId = postCore ? postCoreRunId : runId;
    const row = {
      run_id: selectedRunId,
      created_at_ms: lastActivity,
      updated_at_ms: lastActivity,
      trigger: "cli",
      phase: "requested",
      status: "running",
      reason: null,
      origin_json: "{}",
      target_json: "{}",
      before_json: JSON.stringify({ version: baseline }),
      after_json: "{}",
      steps_json: JSON.stringify([
        { step: "requested", status: "in_progress", startedAtMs: lastActivity },
      ]),
      verification_json: "{}",
      repair_json: "[]",
      confirmed_at_ms: null,
      finished_at_ms: null,
      downtime_ms: null,
    };
    const insert = db.prepare(
      `INSERT INTO update_runs (${Object.keys(row).join(",")}) VALUES (${Object.keys(row)
        .map(() => "?")
        .join(",")})`,
    );
    insert.run(...Object.values(row));
    if (postCore) {
      // Released repair attempts could fail Doctor without recording a reason.
      const failed = {
        ...row,
        run_id: failedFinalizeRunId,
        created_at_ms: lastActivity + 1,
        updated_at_ms: lastActivity + 1,
        phase: "finished",
        status: "failed",
        finished_at_ms: lastActivity + 1,
        steps_json: JSON.stringify([
          { step: "finalize:doctor", status: "failed", endedAtMs: lastActivity + 1 },
        ]),
      };
      insert.run(...Object.values(failed));
      writeJson(
        path.join(artifactRoot, "failed-finalize-before.json"),
        readRun(db, failedFinalizeRunId),
      );
    }
    writeJson(
      path.join(artifactRoot, postCore ? "post-core-run-before.json" : "abandoned-run-before.json"),
      readRun(db, selectedRunId),
    );
  });
}

function preserved(stateDir, artifactRoot) {
  withDatabase(stateDir, false, (db) => {
    assert.deepEqual(
      { ...readRun(db) },
      readJson(path.join(artifactRoot, "abandoned-run-before.json")),
      "the abandoned repair input must remain intact until explicit repair",
    );
    const active = db.prepare("SELECT run_id FROM update_runs WHERE status = 'running'").all();
    assert.deepEqual(
      active.map((row) => row.run_id),
      [runId],
      "the real updater must finish its own run",
    );
  });
}

function processIdentity(pid) {
  assert(Number.isSafeInteger(pid) && pid > 1, "invalid service process ID");
  const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
  assert.notEqual(fields[0], "Z", "service process is a zombie");
  assert(fields[19], "process start time is missing");
  return { pid, startTime: fields[19] };
}

function gatewayListenerPid(supervisorPid) {
  const listeningSockets = new Set(
    ["tcp", "tcp6"].flatMap((name) =>
      fs
        .readFileSync(`/proc/net/${name}`, "utf8")
        .trim()
        .split("\n")
        .slice(1)
        .map((line) => line.trim().split(/\s+/u))
        .filter(
          (fields) => fields[3] === "0A" && Number.parseInt(fields[1].split(":")[1], 16) === 18789,
        )
        .map((fields) => `socket:[${fields[9]}]`),
    ),
  );
  assert(listeningSockets.size > 0, "the Gateway port must have a listening socket");
  const descendants = [supervisorPid];
  const listeners = [];
  for (const pid of descendants) {
    const children = fs
      .readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8")
      .trim()
      .split(/\s+/u)
      .filter(Boolean)
      .map(Number);
    descendants.push(...children);
    const ownsListener = fs.readdirSync(`/proc/${pid}/fd`).some((fd) => {
      try {
        return listeningSockets.has(fs.readlinkSync(`/proc/${pid}/fd/${fd}`));
      } catch (error) {
        if (error.code === "ENOENT") {
          return false;
        }
        throw error;
      }
    });
    if (ownsListener) {
      listeners.push(pid);
    }
  }
  assert.equal(listeners.length, 1, "one supervised Gateway must own the listening port");
  return listeners[0];
}

function service(pidFile, logFile, output) {
  const supervisorPid = Number(fs.readFileSync(pidFile, "utf8").trim());
  writeJson(output, {
    supervisor: processIdentity(supervisorPid),
    // The socket owner is authoritative even if a CLI respawn adds a wrapper.
    gateway: processIdentity(gatewayListenerPid(supervisorPid)),
    operations: fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean),
    callers: fs
      .readFileSync(`${logFile}.callers`, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse),
    unitSha256: createHash("sha256")
      .update(
        fs.readFileSync(
          path.join(process.env.HOME, ".config/systemd/user/openclaw-gateway.service"),
        ),
      )
      .digest("hex"),
  });
}

function packages(tarball, packageRoot, artifactRoot) {
  const packedJson = (relative) =>
    JSON.parse(execFileSync("tar", ["-xOf", tarball, `package/${relative}`], { encoding: "utf8" }));
  const baseline = {
    version: readJson(path.join(packageRoot, "package.json")).version,
    build: readJson(path.join(packageRoot, "dist", "build-info.json")),
  };
  const candidate = {
    version: packedJson("package.json").version,
    build: packedJson("dist/build-info.json"),
  };
  assert(
    baseline.build.buildId && candidate.build.buildId,
    "both packages must identify their build",
  );
  assert.notEqual(
    candidate.build.buildId,
    baseline.build.buildId,
    "candidate must be a distinct build, even when versions match",
  );
  writeJson(path.join(artifactRoot, "abandoned-update-packages.json"), { baseline, candidate });
}

function installed(packageRoot, artifactRoot) {
  const expected = readJson(path.join(artifactRoot, "abandoned-update-packages.json")).candidate;
  const actual = {
    version: readJson(path.join(packageRoot, "package.json")).version,
    build: readJson(path.join(packageRoot, "dist", "build-info.json")),
  };
  assert.deepEqual(actual, expected, "the updater must install the selected candidate build");
}

function recovered(stateDir, artifactRoot, postCore = false) {
  const prefix = postCore ? "full-repair" : "repair";
  const statusPrefix = postCore ? "full-repair-status" : "update-status";
  const selectedRunId = postCore ? postCoreRunId : runId;
  const before = readJson(path.join(artifactRoot, `${prefix}-service-before.json`));
  const after = readJson(path.join(artifactRoot, `${prefix}-service-after.json`));
  const repairExit = Number(fs.readFileSync(path.join(artifactRoot, `${prefix}.exit`), "utf8"));
  const statusExit = Number(
    fs.readFileSync(path.join(artifactRoot, `${statusPrefix}.exit`), "utf8"),
  );
  const repairOutput = fs.readFileSync(path.join(artifactRoot, `${prefix}.json`), "utf8");
  const repairError = fs.readFileSync(path.join(artifactRoot, `${prefix}.err`), "utf8");
  const row = withDatabase(stateDir, false, (db) => readRun(db, selectedRunId));
  const operations = after.operations.slice(before.operations.length);
  const callers = after.callers.slice(before.callers.length);
  writeJson(
    path.join(artifactRoot, `${postCore ? "post-core" : "abandoned"}-update-evidence.json`),
    {
      runId: selectedRunId,
      repairExit,
      statusExit,
      row,
      serviceBefore: { supervisor: before.supervisor, gateway: before.gateway },
      serviceAfter: { supervisor: after.supervisor, gateway: after.gateway },
      operations,
      callers,
      repairOutput,
      repairError,
    },
  );
  assert.equal(repairExit, 0, `update repair failed: ${repairError || repairOutput}`);
  assert.equal(statusExit, 0, "update status failed");
  const repair = JSON.parse(repairOutput);
  assert(postCore ? ["ok", "warning"].includes(repair.status) : repair.status === "ok");
  assert.equal(repair.mode, postCore ? "finalize" : "repair");
  assert.equal(repair.restart, false);
  assert.deepEqual(repair.reconciledRuns, [selectedRunId]);
  if (!postCore) {
    assert.match(repair.message, /No maintenance or service restart was needed/u);
  }
  assert.equal(row.status, "failed");
  assert.equal(row.phase, "finished");
  assert.equal(row.reason, "abandoned");
  assert(Number.isSafeInteger(row.finished_at_ms));
  assert(
    JSON.parse(row.steps_json).some(
      (step) =>
        step.step === "reconcile:abandoned" && step.detail === "operator-reconciled-inactive-run",
    ),
  );
  assert(
    JSON.parse(row.steps_json).some(
      (step) => step.step === "reconcile:acknowledged" && step.status === "completed",
    ),
    "successful repair must acknowledge its abandoned run",
  );
  const status = readJson(path.join(artifactRoot, `${statusPrefix}.json`));
  assert.equal(status.activeRun, undefined, "update status must have no active run");
  assert.equal(after.unitSha256, before.unitSha256, "repair replaced the owned service definition");
  const activation = operations.filter((operation) =>
    /(?:^|\s)(?:stop|restart|start|enable|disable)(?:\s|$)/u.test(operation),
  );
  if (postCore) {
    const failed = withDatabase(stateDir, false, (db) => readRun(db, failedFinalizeRunId));
    assert.deepEqual(
      { ...failed },
      readJson(path.join(artifactRoot, "failed-finalize-before.json")),
    );
    assert.equal(
      status.lastRun?.status,
      "succeeded",
      "successful repair must supersede the empty-reason failure",
    );
    assert.notEqual(status.lastRun?.runId, failedFinalizeRunId);
    assert.notDeepEqual(
      after.supervisor,
      before.supervisor,
      "full repair did not restore the service",
    );
    assert.notDeepEqual(after.gateway, before.gateway, "full repair did not replace the Gateway");
    assert.equal(activation.length, 2, "full repair must park and restore the service once");
    assert.equal(activation[0], "--user stop openclaw-gateway.service");
    assert.match(activation[1], /^--user (?:start|restart) openclaw-gateway\.service$/u);
    assert.deepEqual(
      callers.map(({ action }) => action),
      ["stop", activation[1].split(" ")[1]],
    );
    for (const { roles } of callers) {
      assert(roles.includes("update"), "the repair parent did not own service activation");
      assert(!roles.includes("doctor"), "a Doctor child changed service activation");
    }
  } else {
    assert.deepEqual(after.supervisor, before.supervisor, "repair replaced the service supervisor");
    assert.deepEqual(after.gateway, before.gateway, "repair replaced the Gateway process");
    assert.deepEqual(activation, [], "ledger-only repair changed service activation");
    assert.deepEqual(callers, []);
  }
  console.log(
    JSON.stringify({
      runId: selectedRunId,
      status: row.status,
      reason: row.reason,
      repairExit,
      activeRun: null,
      gatewayPid: after.gateway.pid,
      serviceUnchanged: !postCore,
      ...(postCore ? { parentOwnsActivation: true } : {}),
    }),
  );
}

function createDeadlineHook(packageRoot, artifactRoot) {
  const dist = path.join(packageRoot, "dist");
  const modules = fs
    .readdirSync(dist)
    .filter((file) => /\.[cm]?js$/u.test(file))
    .map((file) => ({
      url: pathToFileURL(path.join(dist, file)).href,
      source: fs.readFileSync(path.join(dist, file), "utf8"),
    }));
  const marker = "async function updatePluginsAfterCoreUpdate(params) {";
  const plugins = modules.filter((module) => module.source.includes(marker));
  const mutations = modules.filter((module) =>
    /mutateConfigFileWithRetry as \w+/u.test(module.source),
  );
  assert.equal(plugins.length, 1, "one built plugin-convergence owner must be injectable");
  assert.equal(mutations.length, 1, "one built config mutation owner must be exported");
  const mutationExport = /mutateConfigFileWithRetry as (\w+)/u.exec(mutations[0].source)[1];
  const output = path.join(artifactRoot, "repair-deadline-hook.mjs");
  fs.writeFileSync(
    output,
    `
import { registerHooks } from 'node:module';
import fs from 'node:fs';
const update = process.argv.indexOf('update');
if (update >= 2 && process.argv[update + 1] === 'repair') {
  const key = Symbol.for('openclaw.e2e.repair-deadline');
  globalThis[key] = async params => {
    console.error('[fixture] Plugin convergence entered; waiting past its ${budgetMs}ms deadline.');
    await new Promise(resolve => setTimeout(resolve, ${budgetMs + 1_000}));
    const writer = await import(${JSON.stringify(mutations[0].url)});
    try {
      await writer[${JSON.stringify(mutationExport)}]({
        writeOptions: params.configWriteOptions,
        mutate: draft => { draft.update = { ...draft.update, channel: 'beta' }; },
      });
      throw new Error('The late config write was applied');
    } catch (error) {
      if (!error.message.includes('Update finalization timed out in plugins after ${budgetMs}ms')) throw error;
      fs.writeFileSync(${JSON.stringify(path.join(artifactRoot, "deadline-write-refused.json"))}, JSON.stringify({ phase: 'plugins', deadlineMs: ${budgetMs}, refused: true }));
      console.error('[fixture] Late config write refused by the expired phase authority.');
      throw error;
    }
  };
  registerHooks({ load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (url !== ${JSON.stringify(plugins[0].url)}) return loaded;
    const source = typeof loaded.source === 'string' ? loaded.source : Buffer.from(loaded.source).toString('utf8');
    if (!source.includes(${JSON.stringify(marker)})) throw new Error('Plugin deadline injection target changed');
    return { ...loaded, source: source.replace(${JSON.stringify(marker)}, ${JSON.stringify(`${marker}\n  await globalThis[Symbol.for('openclaw.e2e.repair-deadline')](params);`)}) };
  }});
}
`,
  );
  console.log(output);
}

function verifyDeadlineRecovery(stateDir, artifacts) {
  assert.equal(Number(fs.readFileSync(path.join(artifacts, "deadline-repair.exit"), "utf8")), 1);
  const result = readJson(path.join(artifacts, "deadline-repair.json"));
  assert.equal(result.status, "failed");
  assert.equal(result.stuckPhase, "plugins");
  assert.deepEqual(readJson(path.join(artifacts, "deadline-write-refused.json")), {
    phase: "plugins",
    deadlineMs: budgetMs,
    refused: true,
  });
  assert.equal(readJson(process.env.OPENCLAW_CONFIG_PATH).update.channel, "stable");
  const before = readJson(path.join(artifacts, "deadline-service-before.json"));
  const after = readJson(path.join(artifacts, "deadline-service-after.json"));
  assert.notDeepEqual(after.gateway, before.gateway, "the stopped Gateway must be restored");
  assert.equal(after.unitSha256, before.unitSha256);
  const callers = after.callers.slice(before.callers.length);
  assert.equal(callers.length, 2);
  assert.equal(callers[0].action, "stop");
  assert(["start", "restart"].includes(callers[1].action));
  for (const { roles } of callers) {
    assert(roles.includes("update"));
    assert(!roles.includes("doctor"));
  }
  const db = new DatabaseSync(path.join(stateDir, "state", "openclaw.sqlite"), { readOnly: true });
  let warning;
  try {
    const run = db
      .prepare(
        "SELECT status, reason, steps_json FROM update_runs ORDER BY created_at_ms DESC LIMIT 1",
      )
      .get();
    assert.equal(run.status, "failed");
    assert.equal(run.reason, "finalization-timeout");
    warning = JSON.parse(run.steps_json).find(
      (step) => step.step === "warning:finalize:plugins:deadline",
    );
    assert.equal(warning?.status, "completed");
    assert(warning.detail.includes(`timed out in plugins after ${budgetMs}ms`));
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM update_runs WHERE status = 'running'").get().n,
      0,
    );
    assert.equal(
      db
        .prepare("SELECT count(*) AS n FROM state_leases WHERE scope = 'core:plugin-lifecycle'")
        .get().n,
      0,
    );
  } finally {
    db.close();
  }
  const stderr = fs.readFileSync(path.join(artifacts, "deadline-repair.err"), "utf8");
  assert(stderr.includes("Gateway restarted and verified after Doctor repair."));
  for (const line of stderr.split("\n")) {
    if (
      line.startsWith("[fixture]") ||
      line.includes("Gateway restarted and verified") ||
      line.includes("warning:finalize:plugins:deadline")
    ) {
      console.log(line);
    }
  }
  console.log(
    JSON.stringify({
      phase: "plugins",
      deadlineMs: budgetMs,
      exitCode: 1,
      gatewayRestored: true,
      gatewayPid: after.gateway.pid,
      lateWriteRefused: true,
      custodyReleased: true,
      warning: warning.detail,
    }),
  );
}

if (command === "seed") {
  seed(first, second);
} else if (command === "seed-post-core") {
  seed(first, second, true);
} else if (command === "preserved") {
  preserved(first, second);
} else if (command === "service") {
  service(first, second, third);
} else if (command === "recovered") {
  recovered(first, second);
} else if (command === "recovered-post-core") {
  recovered(first, second, true);
} else if (command === "packages") {
  packages(first, second, third);
} else if (command === "installed") {
  installed(first, second);
} else if (command === "deadline-hook") {
  createDeadlineHook(first, second);
} else if (command === "deadline-verify") {
  verifyDeadlineRecovery(first, second);
} else {
  throw new Error(`Unknown abandoned-update fixture command: ${command}`);
}
