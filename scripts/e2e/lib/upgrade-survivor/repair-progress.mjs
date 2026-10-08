import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { toErrorObject } from "../../../lib/error-format.mts";
import { createServiceProbe } from "./service-probe.mjs";
import {
  assertWorkerCellPackageIdentity,
  readWorkerCellPackageIdentity,
} from "./worker-cell-package.mjs";

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const hash = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const save = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");

async function snapshot(source, destination) {
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    await backup(db, destination);
  } finally {
    db.close();
  }
}
function inspectAgent(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    return {
      version: db.prepare("PRAGMA user_version").get().user_version,
      sessions: db
        .prepare("SELECT session_key,current_session_id FROM session_nodes ORDER BY session_key")
        .all(),
    };
  } finally {
    db.close();
  }
}

async function seedLegacyAgent({ run, runtime, artifacts, env }) {
  const home = path.join(runtime, "progress-legacy-home");
  const state = path.join(home, ".openclaw");
  const prefix = path.join(runtime, "progress-legacy-npm");
  const workspace = path.join(home, "workspace");
  const sessions = path.join(state, "agents/main/sessions");
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  const sessionId = "progress-legacy-session";
  const sessionFile = path.join(sessions, sessionId + ".jsonl");
  save(path.join(sessions, "sessions.json"), {
    "agent:main:progress-legacy": { sessionId, sessionFile, updatedAt: 1 },
  });
  fs.writeFileSync(
    sessionFile,
    JSON.stringify({
      type: "session",
      id: sessionId,
      version: 3,
      timestamp: "2026-09-01T00:00:00.000Z",
      cwd: workspace,
    }) + "\n",
  );
  save(path.join(state, "openclaw.json"), {
    gateway: { mode: "local" },
    plugins: { enabled: false },
    agents: { defaults: { workspace }, list: [{ id: "main", default: true, workspace }] },
  });
  const saved = { ...env };
  try {
    Object.assign(env, {
      HOME: home,
      OPENCLAW_STATE_DIR: state,
      OPENCLAW_CONFIG_PATH: path.join(state, "openclaw.json"),
      npm_config_prefix: prefix,
      NPM_CONFIG_PREFIX: prefix,
      OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: "repair-progress",
      OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT: path.join(artifacts, "progress-legacy-package"),
      OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT: home,
    });
    fs.mkdirSync(env.OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT);
    await run("progress-legacy-install", "npm", [
      "install",
      "-g",
      "openclaw@2026.9.4",
      "--no-audit",
      "--no-fund",
    ]);
    const packageRoot = path.join(prefix, "lib/node_modules/openclaw");
    await run("progress-legacy-identity", process.execPath, [
      fileURLToPath(new URL("./worker-cell-package.mjs", import.meta.url)),
      "baseline",
      packageRoot,
    ]);
    await run("progress-legacy-doctor", process.execPath, [
      path.join(packageRoot, "openclaw.mjs"),
      "doctor",
      "--fix",
      "--non-interactive",
    ]);
    const baseline = path.join(runtime, "progress-baseline-agent.sqlite");
    await snapshot(path.join(state, "agents/main/agent/openclaw-agent.sqlite"), baseline);
    const { version, buildInfo, sha256, integrity, url } = readJson(
      path.join(env.OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT, "baseline-package-identity.json"),
    );
    return { database: baseline, package: { version, buildInfo, sha256, integrity, url } };
  } finally {
    for (const key of Object.keys(env)) {
      delete env[key];
    }
    Object.assign(env, saved);
  }
}

// Reuses the published-driver cell's runtime, service custody, deadline and cleanup.
export async function prepareRepairProgress({
  run,
  artifacts,
  runtime,
  state,
  packageRoot,
  candidate,
  env,
  bin,
}) {
  const identityHelper = fileURLToPath(new URL("./worker-cell-package.mjs", import.meta.url));
  env.OPENCLAW_UPGRADE_SURVIVOR_SCENARIO = "repair-progress";
  env.OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT = artifacts;
  env.OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT = runtime;
  await run("progress-baseline-identity", process.execPath, [
    identityHelper,
    "baseline",
    packageRoot,
  ]);
  const extracted = path.join(runtime, "progress-candidate");
  fs.mkdirSync(extracted);
  await run("progress-candidate-extract", "tar", ["-xf", candidate, "-C", extracted]);
  const expected = readWorkerCellPackageIdentity(path.join(extracted, "package"));
  assert.equal(expected.buildInfo.commit, process.env.OPENCLAW_DOCKER_E2E_SELECTED_SHA);
  const agent = path.join(state, "agents/main/agent/openclaw-agent.sqlite");
  const legacy = await seedLegacyAgent({ run, runtime, artifacts, env });
  const baseline = legacy.database;
  const before = inspectAgent(baseline);
  const manifest = readJson(path.join(extracted, "package/package.json"));
  assert(
    before.version < manifest.openclaw.schemaVersions.agent,
    "Cell needs a real published-agent migration, not a rewritten schema marker",
  );
  save(path.join(artifacts, "progress-package.json"), {
    candidateSha256: hash(candidate),
    expected: {
      version: expected.version,
      buildInfo: expected.buildInfo,
      payloadSha256: createHash("sha256").update(JSON.stringify(expected)).digest("hex"),
      fileCount: Object.keys(expected.files).length,
    },
    baseline: { ...before, package: legacy.package },
  });

  let managedProbe;
  const prove = async () => {
    assertWorkerCellPackageIdentity(readWorkerCellPackageIdentity(packageRoot), expected);
    const stop = () =>
      run("progress-stop", path.join(bin, "systemctl"), [
        "--user",
        "stop",
        "openclaw-gateway.service",
      ]);
    await stop();
    const probe = fileURLToPath(new URL("./repair-progress-probe.mjs", import.meta.url));
    const runProbe = async (name, args, identities, options = {}) => {
      const directory = path.join(artifacts, name);
      fs.mkdirSync(directory);
      const fixture = {
        identities,
        quiet: options.quiet === true,
        migrated: options.migrated === true,
      };
      save(path.join(directory, "fixture.json"), fixture);
      const fifo = path.join(directory, "release.fifo");
      await run(name + "-fifo", "mkfifo", [fifo]);
      const gate = fs.openSync(fifo, "r+");
      let pending = "";
      let observation;
      /** @type {Error | undefined} */
      let observerFailure;
      const observe = (chunk, stream, child) => {
        if (stream !== "stderr" || observerFailure) {
          return;
        }
        try {
          pending += chunk.toString("utf8");
          assert(pending.length <= 1024 * 1024, "Unbounded unterminated proof output");
          for (;;) {
            const newline = pending.indexOf("\n");
            if (newline < 0) {
              break;
            }
            const line = pending.slice(0, newline);
            pending = pending.slice(newline + 1);
            if (!line.startsWith("[update progress] ") || observation || fixture.quiet) {
              continue;
            }
            const progress = JSON.parse(line.slice("[update progress] ".length));
            if (
              progress.operation !== "sqlite-integrity" ||
              progress.operationPhase !== "checking"
            ) {
              continue;
            }
            if (!fs.existsSync(path.join(directory, "held.json"))) {
              continue;
            }
            const held = readJson(path.join(directory, "held.json"));
            assert.equal(child.exitCode, null, "Progress arrived after CLI exit");
            assert(
              !fs.existsSync(path.join(directory, "released.json")),
              "Progress arrived after release",
            );
            assert(progress.elapsedMs >= 10_000);
            if (fixture.migrated) {
              assert(held.ancestors.some((entry) => entry.migrated));
            }
            observation = {
              at: Date.now(),
              progress,
              held,
              topLevelPid: child.pid,
              beforeSettlement: true,
            };
            save(path.join(directory, "observed.json"), observation);
            fs.writeSync(gate, Buffer.from([1]));
          }
        } catch (error) {
          observerFailure = toErrorObject(error, "Progress observer failed");
          fs.writeSync(gate, Buffer.from([1]));
        }
      };
      const scoped = createServiceProbe({
        run,
        bin,
        artifacts,
        env,
        preload: probe,
        selectors: {
          OPENCLAW_REPAIR_PROGRESS_PROBE: directory,
          OPENCLAW_LOG_LEVEL: fixture.quiet ? "silent" : "info",
        },
      });
      try {
        if (fixture.migrated) {
          managedProbe = scoped;
          await scoped.install();
        }
        await scoped.withCaller(() => run(name, "openclaw", args, false, observe));
      } finally {
        fs.closeSync(gate);
      }
      if (observerFailure) {
        throw observerFailure;
      }
      const stdout = fs.readFileSync(path.join(artifacts, name + ".stdout"), "utf8");
      const result = JSON.parse(stdout); // Entire stdout, not a suffix after stray diagnostics.
      assert(["ok", "warning"].includes(result.status), "CLI did not complete successfully");
      const stderr = fs.readFileSync(path.join(artifacts, name + ".stderr"), "utf8");
      assert.match(stderr, /CRITICAL: only 50 MB free/);
      assert.match(stderr, /Free up disk space immediately/);
      if (fixture.quiet) {
        assert(!stderr.includes("[update progress]"));
        const heartbeat = readJson(path.join(directory, "heartbeat.json"));
        const held = readJson(path.join(directory, "held.json"));
        const released = readJson(path.join(directory, "released.json"));
        assert(held.ancestors.some((entry) => entry.pid === heartbeat.pid));
        assert(held.at <= heartbeat.at && heartbeat.at <= released.at);
      } else {
        assert(observation, "Real Doctor heartbeat was not visible before completion");
        assert(fs.existsSync(path.join(directory, "released.json")));
        assert.equal(
          stderr.split("\n").filter((line) => line.startsWith("[update progress] ")).length,
          1,
          "Progress was replayed at completion",
        );
      }
      save(path.join(directory, "result.json"), {
        status: result.status,
        singleTerminalJson: true,
        quiet: fixture.quiet,
        observation,
      });
      return result;
    };
    await runProbe("progress-repair", ["update", "repair", "--yes", "--json"], [expected]);
    await runProbe("progress-quiet", ["update", "repair", "--yes", "--json"], [expected], {
      quiet: true,
    });
    await stop();
    assertWorkerCellPackageIdentity(readWorkerCellPackageIdentity(packageRoot), expected);

    // Restore this same synthetic agent's native baseline backup, preserving its
    // candidate files separately. No schema markers or authority facts are forged.
    const preserved = path.join(runtime, "progress-before-migration");
    fs.mkdirSync(preserved);
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      if (fs.existsSync(agent + suffix)) {
        fs.renameSync(agent + suffix, path.join(preserved, "agent.sqlite" + suffix));
      }
    }
    fs.copyFileSync(baseline, agent);
    assert.deepEqual(inspectAgent(agent), before);
    const future = path.join(runtime, "progress-future.tgz");
    await run("progress-relabel", process.execPath, [
      fileURLToPath(new URL("../update-first-hop-package-fixtures.mjs", import.meta.url)),
      "first-hop-tarball",
      candidate,
      future,
    ]);
    const relabel = readJson(path.join(artifacts, "progress-relabel.stdout"));
    assert(
      relabel.members.changes.every((entry) =>
        [
          "package.json",
          "dist/build-info.json",
          "dist/postinstall-content-inventory.json",
        ].includes(entry.path),
      ),
      "Fixture relabel changed runtime code",
    );
    save(path.join(artifacts, "progress-relabel.json"), relabel);
    const target = path.join(runtime, "progress-target");
    fs.mkdirSync(target);
    await run("progress-target-extract", "tar", ["-xf", future, "-C", target]);
    const futureIdentity = readWorkerCellPackageIdentity(path.join(target, "package"));
    await runProbe(
      "progress-migrated",
      ["update", "--tag", future, "--yes", "--json", "--no-restart"],
      [expected, futureIdentity],
      { migrated: true },
    );
    assertWorkerCellPackageIdentity(readWorkerCellPackageIdentity(packageRoot), futureIdentity);
    const after = inspectAgent(agent);
    assert.equal(after.version, manifest.openclaw.schemaVersions.agent);
    for (const session of before.sessions) {
      assert(
        after.sessions.some(
          (entry) =>
            entry.session_key === session.session_key &&
            entry.current_session_id === session.current_session_id,
        ),
      );
    }
    save(path.join(artifacts, "progress-summary.json"), {
      source: expected.buildInfo,
      target: futureIdentity.buildInfo,
      baseline: before,
      after,
      packageSha256: hash(candidate),
      fixtureSha256: hash(future),
      limitation:
        "Controlled native-boundary hold; not a large-data timing benchmark. Published driver output remains buffered.",
    });
  };
  return {
    prove,
    restore: (settlement) => managedProbe?.finish(settlement) ?? { retained: false },
  };
}
