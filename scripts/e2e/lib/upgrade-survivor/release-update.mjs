// Packed PR head -> source-built schema successor, through the normal update CLI.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { readDatabase } from "./observations.mjs";
import { mapRegistryHosts, prepareRegistryTls, startRegistryTlsRelay } from "./registry-tls.mjs";
import { startNodeFixture } from "./release-process.mjs";

assert(
  fs.existsSync("/.dockerenv") || fs.existsSync("/run/.containerenv"),
  "requires an isolated container",
);
const sourceTarball = process.env.OPENCLAW_CURRENT_PACKAGE_TGZ;
assert(sourceTarball, "missing packed current checkout");
const artifacts = process.env.OPENCLAW_UPGRADE_SURVIVOR_ARTIFACT_ROOT;
assert(artifacts, "missing artifact directory");
const fixtureRoot = "/tmp/openclaw-release-fixtures";
const fixture = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "fixture.json"), "utf8"));
const containerStartedAt = performance.now();
fixture.next.tarball = path.join(fixtureRoot, "next.tgz");
const expected = fixture.next;
fs.mkdirSync(artifacts, { recursive: true });
// openclaw-temp-dir: allow standalone Docker lane owns its runtime until container removal.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-release-survivor-"));
const state = path.join(root, "home", ".openclaw");
const prefix = path.join(root, "prefix");
fs.mkdirSync(state, { recursive: true });
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) =>
      !key.startsWith("OPENCLAW_") &&
      !/^npm_config_/iu.test(key) &&
      !["DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR"].includes(key),
  ),
);
Object.assign(env, {
  HOME: path.join(root, "home"),
  PATH: `${prefix}/bin:${process.env.PATH}`,
  OPENCLAW_STATE_DIR: state,
  OPENCLAW_CONFIG_PATH: path.join(state, "openclaw.json"),
  OPENCLAW_DISABLE_BONJOUR: "1",
  OPENCLAW_NO_ONBOARD: "1",
  OPENCLAW_NO_PROMPT: "1",
  CI: "true",
});
const save = (name, value) =>
  fs.writeFileSync(path.join(artifacts, name), `${JSON.stringify(value, null, 2)}\n`);
const children = [];
let tlsRelay;
function start(program, args, logName, extra = {}) {
  const fd = fs.openSync(path.join(artifacts, logName), "a");
  try {
    const child = spawn(program, args, { env, stdio: ["ignore", fd, fd], ...extra });
    children.push(child);
    return child;
  } finally {
    fs.closeSync(fd);
  }
}
async function command(program, args, logName, expectedCode = 0) {
  const child = start(program, args, logName);
  const [code, signal] = await once(child, "exit");
  assert.equal(code, expectedCode, `${program} exited ${code ?? signal}; see ${logName}`);
}
async function waitFor(read, message, budget = 300_000) {
  const deadline = Date.now() + budget;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) {
      return value;
    }
    await delay(250);
  }
  throw new Error(message);
}
const port = 18789;
const ready = async () => {
  try {
    return (await fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(1000) }))
      .ok;
  } catch {
    return false;
  }
};
const database = path.join(state, "state", "openclaw.sqlite");
const readRun = () =>
  readDatabase(database, (db) =>
    db.prepare("SELECT * FROM update_runs ORDER BY created_at_ms DESC LIMIT 1").get(),
  );
const seedConfig = (gatewayPort) => ({
  gateway: {
    mode: "local",
    bind: "loopback",
    port: gatewayPort,
    auth: { mode: "token", token: "release-survivor-token" },
  },
  update: { channel: "stable", checkOnStart: false },
});

async function reportBackwardRead(previous, previousBuild) {
  const probeHome = path.join(root, "backward-read");
  const probeState = path.join(probeHome, ".openclaw");
  const snapshot = path.join(probeState, "state", "openclaw.sqlite");
  const probePort = 28789; // Keep Gateway-derived sidecar ports away from the live 18789 range.
  const args = [path.join(previous, "openclaw.mjs"), "gateway", "run", "--port", String(probePort)];
  const receipt = {
    scope: "shared-state-database-only",
    result: "unproven",
    expectedBuild: {
      version: fixture.previous.version,
      buildId: previousBuild.buildId,
      commit: previousBuild.commit,
      root: previous,
    },
    invocation: { executable: process.execPath, args, port: probePort, launcherForwarded: true },
    snapshot: {
      method: "node:sqlite.backup",
      path: snapshot,
      beforeSchema: null,
      afterSchema: null,
    },
    ready: false,
    live: false,
    exitCode: null,
    signal: null,
  };
  let gateway;
  let identity;
  try {
    fs.mkdirSync(path.dirname(snapshot), { recursive: true });
    const probeEnv = {
      ...env,
      HOME: probeHome,
      PATH: env.PATH.split(path.delimiter)
        .filter((entry) => entry !== path.join(prefix, "bin"))
        .join(path.delimiter),
      OPENCLAW_STATE_DIR: probeState,
      OPENCLAW_CONFIG_PATH: path.join(probeState, "openclaw.json"),
      // This is also how the real release launcher starts T during rollback.
      OPENCLAW_RELEASE_LAUNCHER_FORWARDED: "1",
    };
    fs.writeFileSync(probeEnv.OPENCLAW_CONFIG_PATH, JSON.stringify(seedConfig(probePort)));
    const source = new DatabaseSync(database, { readOnly: true });
    // Match sqlite-backup.ts: native completion needs a callback checkpoint on Node 24.
    const checkpoint = setInterval(() => {}, 100);
    try {
      receipt.snapshot.pages = await backup(source, snapshot);
    } finally {
      clearInterval(checkpoint);
      source.close();
    }
    receipt.snapshot.beforeSchema = readDatabase(
      snapshot,
      (db) => db.prepare("PRAGMA user_version").get().user_version,
    );
    assert.equal(receipt.snapshot.beforeSchema, fixture.next.schema, "snapshot is not schema N+1");
    gateway = startNodeFixture(args, probeEnv);
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (gateway.error()) {
        throw gateway.error();
      }
      if (gateway.child.exitCode !== null || gateway.child.signalCode !== null) {
        await Promise.race([gateway.done, delay(1000)]);
        break;
      }
      try {
        receipt.ready = (
          await fetch(`http://127.0.0.1:${probePort}/readyz`, {
            signal: AbortSignal.timeout(1000),
          })
        ).ok;
      } catch {
        // Readiness remains an observation, not a lane assertion.
      }
      if (receipt.ready) {
        identity = startNodeFixture(
          [
            path.join(previous, "openclaw.mjs"),
            "gateway",
            "probe",
            "--url",
            `ws://127.0.0.1:${probePort}`,
            "--token",
            "release-survivor-token",
            "--json",
          ],
          probeEnv,
        );
        await Promise.race([identity.done, delay(15_000)]);
        if (identity.error()) {
          throw identity.error();
        }
        if (identity.child.exitCode === 0) {
          const target = JSON.parse(identity.output()).targets.find(
            (entry) => entry.url === `ws://127.0.0.1:${probePort}`,
          );
          if (target?.connect.ok) {
            receipt.observedBuild = {
              source: "probe-rpc",
              version: target.server.version,
              buildId: target.server.buildId,
            };
          }
        }
        break;
      }
      await delay(250);
    }
    receipt.live = gateway.child.exitCode === null && gateway.child.signalCode === null;
    receipt.exitCode = gateway.child.exitCode;
    receipt.signal = gateway.child.signalCode;
    const output = gateway.output();
    const refusal = output.match(/Refused by OpenClaw (\S+)(?: \(([^)\n]+)\))? installed at /u);
    const refusedByT =
      refusal?.[1] === fixture.previous.version && output.includes(`${refusal[0]}${previous}.`);
    if (refusedByT) {
      receipt.observedBuild = {
        source: "schema-refusal",
        version: refusal[1],
        commit: refusal[2],
        root: previous,
      };
    }
    // These are the two existing product messages, not a general error classifier.
    const schemaRefusal =
      output.includes(
        `${snapshot} uses newer schema version ${fixture.next.schema}; this build supports ${fixture.previous.schema}.`,
      ) ||
      output.includes(
        `${snapshot} uses schema ${fixture.next.schema}; this build supports ${fixture.previous.schema};`,
      );
    if (
      receipt.ready &&
      receipt.live &&
      receipt.observedBuild?.source === "probe-rpc" &&
      receipt.observedBuild.version === fixture.previous.version &&
      (receipt.observedBuild.buildId === undefined ||
        receipt.observedBuild.buildId === previousBuild.buildId)
    ) {
      receipt.result = "readable";
    } else if (!receipt.ready && receipt.exitCode === 78 && refusedByT && schemaRefusal) {
      receipt.result = "refused";
    }
  } catch (error) {
    receipt.error = error.message.slice(-4096);
  } finally {
    for (const process of [identity, gateway]) {
      try {
        await process?.stop();
      } catch (error) {
        receipt.result = "unproven";
        receipt.cleanupError = error.message.slice(-4096);
      }
    }
    receipt.outputTail = gateway?.output() ?? "";
    receipt.cleanupExitCode = gateway?.child.exitCode ?? null;
    receipt.cleanupSignal = gateway?.child.signalCode ?? null;
    receipt.identityExitCode = identity?.child.exitCode ?? null;
    receipt.identitySignal = identity?.child.signalCode ?? null;
    try {
      if (fs.existsSync(snapshot)) {
        receipt.snapshot.afterSchema = readDatabase(
          snapshot,
          (db) => db.prepare("PRAGMA user_version").get().user_version,
        );
      }
      fs.rmSync(probeHome, { recursive: true, force: true });
    } catch (error) {
      receipt.result = "unproven";
      receipt.cleanupError = error.message.slice(-4096);
    }
    try {
      save("backward-read.json", receipt);
    } catch (error) {
      console.error(`Could not preserve backward-read observation: ${error.message}`);
    }
  }
}
let success;
try {
  const tlsRoot = path.join(root, "tls");
  await prepareRegistryTls(tlsRoot);
  mapRegistryHosts(tlsRoot);
  env.NODE_EXTRA_CA_CERTS = path.join(tlsRoot, "cert.pem");
  for (const name of ["cert.pem", "hosts.before", "hosts.effective", "public-ip"]) {
    fs.copyFileSync(path.join(tlsRoot, name), path.join(artifacts, `tls-${name}`));
  }
  save("fixture.json", fixture);
  assert.notEqual(fixture.previous.buildId, fixture.next.buildId);
  assert.equal(fixture.next.schema, fixture.previous.schema + 1);
  const registry = start(
    process.execPath,
    [
      path.resolve("scripts/e2e/lib/plugins/npm-registry-server.mjs"),
      path.join(root, "registry.port"),
      "openclaw",
      fixture.previous.version,
      sourceTarball,
      "openclaw",
      fixture.next.version,
      fixture.next.tarball,
    ],
    "registry.log",
    {
      env: { ...env, OPENCLAW_NPM_REGISTRY_UPSTREAM: "https://registry.npmjs.org" },
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    },
  );
  const [registryPort] = await once(registry, "message");
  tlsRelay = await startRegistryTlsRelay(
    tlsRoot,
    { t: fixture.previous, next: fixture.next },
    registryPort,
  );
  fs.writeFileSync(
    path.join(env.HOME, ".npmrc"),
    `registry=http://127.0.0.1:${registryPort}\nprefix=${prefix}\ncache=${root}/npm-cache\n`,
  );
  fs.writeFileSync(env.OPENCLAW_CONFIG_PATH, JSON.stringify(seedConfig(port)));
  const installStartedAt = performance.now();
  await command(
    "npm",
    ["install", "--global", sourceTarball, "--no-audit", "--no-fund"],
    "install.log",
  );
  const initialInstall = performance.now() - installStartedAt;
  await command("npm", ["view", "openclaw", "dist-tags", "--json"], "registry-dist-tags.json");
  await command(
    "npm",
    ["view", "openclaw", "dist-tags", "--json", "--registry=https://registry.npmjs.org"],
    "public-dist-tags.json",
  );
  assert(!Object.hasOwn(env, "OPENCLAW_UPDATE_PACKAGE_SPEC"), "CLI target override present");
  const bootstrapStartedAt = performance.now();
  const bootstrap = start("openclaw", ["gateway", "run"], "gateway.log", { detached: true });
  await waitFor(ready, "T did not initialize its state");
  const bootstrapStartup = performance.now() - bootstrapStartedAt;
  const stopped = once(bootstrap, "exit");
  assert(bootstrap.pid, "T bootstrap did not start");
  process.kill(-bootstrap.pid, "SIGTERM");
  await stopped;
  await waitFor(async () => !(await ready()), "T still owns the seed database");
  const seed = new DatabaseSync(database);
  seed.exec(
    "INSERT INTO mcp_oauth_stores VALUES ('release-survivor-a', 1, '{\"sentinel\":\"a\"}', 1), ('release-survivor-b', 1, '{\"sentinel\":\"b\"}', 2)",
  );
  seed.close();
  const sentinels = () =>
    readDatabase(database, (db) =>
      db
        .prepare(
          "SELECT * FROM mcp_oauth_stores WHERE store_key LIKE 'release-survivor-%' ORDER BY store_key",
        )
        .all(),
    );
  const before = sentinels();
  save("rows-before.json", before);
  assert.equal(before.length, 2, "fixture seed is empty");
  const gatewayStartedAt = performance.now();
  const gateway = start("openclaw", ["gateway", "run"], "gateway.log", { detached: true });
  await waitFor(ready, "T did not become ready");
  // Measure both starts without folding the intervening stop and seed writes into startup.
  const gatewayStartup = bootstrapStartup + (performance.now() - gatewayStartedAt);
  assert.equal(gateway.exitCode, null, "T exited before the API update");
  assert(
    !fs
      .readFileSync(`/proc/${gateway.pid}/environ`, "utf8")
      .split("\0")
      .some((entry) => entry.startsWith("OPENCLAW_UPDATE_PACKAGE_SPEC=")),
    "Gateway target override present",
  );
  const startedAt = performance.now();
  await command("openclaw", ["update", "--yes", "--json"], "update-cli.json");
  const row = await waitFor(
    () => {
      const current = readRun();
      return current && current.status !== "running" ? current : null;
    },
    "release update did not finish",
    12 * 60_000,
  );
  const assertionsStartedAt = performance.now();
  save("update-row.json", row);
  assert.equal(row.trigger, "api");
  assert.equal(row.status, "succeeded", row.reason ?? "release update failed");
  assert.equal(JSON.parse(row.before_json).version, fixture.previous.version);
  assert.equal(JSON.parse(row.target_json).version, fixture.next.version);
  const verification = JSON.parse(row.verification_json);
  assert.equal(verification.runningBuildId, expected.buildId, "wrong build is serving");
  assert.equal(verification.runningVersion, expected.version);
  assert.equal(verification.booted, true);
  await waitFor(ready, "expected Gateway is not serving");
  await command("openclaw", ["gateway", "status", "--json"], "serving.json");
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(artifacts, "serving.json"), "utf8")).gateway.version,
    expected.version,
    "live Gateway has the wrong version",
  );
  assert.equal(
    readDatabase(database, (db) => db.prepare("PRAGMA user_version").get().user_version),
    expected.schema,
    "live state has the wrong schema",
  );
  const after = sentinels();
  assert.equal(after.length, before.length, "row counts changed");
  for (const entry of before) {
    entry.store_json = '{"migrated":true}';
  }
  assert.deepEqual(after, before);
  save("rows-after.json", after);
  assert.equal(
    Boolean(
      readDatabase(database, (db) =>
        db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'fixture_update_migration'").get(),
      ),
    ),
    true,
  );
  const releasePrefix = path.join(state, "git-install");
  const trial = JSON.parse(fs.readFileSync(path.join(releasePrefix, "releases", ".trial"), "utf8"));
  assert.equal(trial.phase, "committed");
  assert.equal(trial.buildId, fixture.next.buildId);
  const previous = path.resolve(releasePrefix, trial.previous);
  assert(fs.existsSync(path.join(previous, "openclaw.mjs")), "previous release was not retained");
  const previousBuild = JSON.parse(
    fs.readFileSync(path.join(previous, "dist", "build-info.json"), "utf8"),
  );
  assert.equal(previousBuild.buildId, fixture.previous.buildId);
  const selected = fs.realpathSync(path.join(releasePrefix, "openclaw"));
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(selected, "dist", "build-info.json"), "utf8")).buildId,
    expected.buildId,
  );
  assert(
    fs
      .readFileSync(path.join(artifacts, "gateway.log"), "utf8")
      .includes(`update.run ${row.run_id}`),
    "Gateway route receipt is missing",
  );
  save("trial.json", trial);
  const assertionsFinishedAt = performance.now();
  const summary = {
    head: fixture.previous.commit,
    runId: row.run_id,
    trigger: row.trigger,
    status: row.status,
    servingBuildId: verification.runningBuildId,
    previous,
    // Legacy wall clock: update command through assertions, excluding the observation and teardown.
    wallMs: Math.round(assertionsFinishedAt - startedAt),
    fixtureTimingsMs: fixture.timingsMs,
    beforeUpdateMs: Math.round(startedAt - containerStartedAt),
    initialInstallMs: Math.round(initialInstall),
    migrationProof: true,
    servingSchema: expected.schema,
    rowCount: after.length,
  };
  const backwardReadStartedAt = performance.now();
  try {
    await reportBackwardRead(previous, previousBuild);
  } catch (error) {
    console.error(`Backward-read observation did not complete: ${error.message}`);
  }
  success = {
    summary,
    timings: {
      initialInstall,
      gatewayStartup,
      update: assertionsStartedAt - startedAt,
      assertions: assertionsFinishedAt - assertionsStartedAt,
      backwardRead: performance.now() - backwardReadStartedAt,
    },
  };
} catch (error) {
  try {
    const source = path.join(state, "git-install", "releases", ".trial");
    if (fs.existsSync(source)) {
      const destination = path.join(artifacts, "trial.json");
      fs.copyFileSync(source, destination);
      // The isolated container owns the copy; the product's live trial stays 0600.
      fs.chmodSync(destination, 0o644);
    }
  } catch (captureError) {
    console.error(`Could not preserve trial.json: ${captureError.message}`);
  }
  try {
    save(
      "update-runs.json",
      readDatabase(database, (db) =>
        db.prepare("SELECT * FROM update_runs ORDER BY created_at_ms DESC LIMIT 20").all(),
      ),
    );
  } catch (captureError) {
    console.error(`Could not preserve update rows: ${captureError.message}`);
  }
  try {
    save("summary.json", {
      head: fixture.previous.commit,
      status: "failed",
      case: "healthy",
      ready: await ready(),
      error: error.message,
      servingSchema: readDatabase(
        database,
        (db) => db.prepare("PRAGMA user_version").get().user_version,
      ),
    });
  } catch (captureError) {
    console.error(`Could not preserve update state: ${captureError.message}`);
  }
  try {
    // The foreground launcher inherits Gateway stdout/stderr: this is their shared journal.
    fs.writeFileSync(
      path.join(artifacts, "gateway-launcher.log"),
      fs.readFileSync(path.join(artifacts, "gateway.log")).subarray(-65536),
    );
  } catch (captureError) {
    console.error(`Could not preserve Gateway/launcher journal: ${captureError.message}`);
  }
  throw error;
} finally {
  const teardownStartedAt = performance.now();
  const closing = [];
  if (tlsRelay) {
    closing.push(once(tlsRelay, "close"));
    tlsRelay.close();
    tlsRelay.closeAllConnections();
  }
  for (const child of children.toReversed()) {
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      if (
        child.spawnargs[0] === "openclaw" &&
        child.spawnargs[1] === "gateway" &&
        child.spawnargs[2] === "run"
      ) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch (error) {
          if (error.code !== "ESRCH") {
            console.error(error);
            process.exitCode = 1;
            continue;
          }
        }
      } else {
        child.kill("SIGTERM");
      }
      closing.push(once(child, "exit"));
    }
  }
  await Promise.all(closing);
  if (success && !process.exitCode) {
    const finishedAt = performance.now();
    const timings = { ...success.timings, teardown: finishedAt - teardownStartedAt };
    const total = finishedAt - containerStartedAt;
    // Account for setup, tag probes, and seeding between the named phases.
    const other = total - Object.values(timings).reduce((sum, elapsed) => sum + elapsed, 0);
    save("summary.json", {
      ...success.summary,
      containerTimingsMs: Object.fromEntries(
        Object.entries({ ...timings, other, total }).map(([name, ms]) => [name, Math.round(ms)]),
      ),
    });
  }
}
