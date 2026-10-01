#!/usr/bin/env node
// One managed update across the published-driver/candidate boundary, with synthetic state only.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyReleaseTrain, parseReleaseVersion } from "../../../lib/release-version.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const [candidateArg, artifactsArg, driverTag = "latest"] = process.argv.slice(2);
assert.equal(process.platform, "linux", "The managed-service fixture requires Linux");
assert(fs.existsSync("/.dockerenv"), "Run through the bare Docker E2E runner");
const accountHome = os.userInfo().homedir;
assert.equal(accountHome, "/home/appuser", "Expected the disposable E2E account");
assert(candidateArg && artifactsArg, "Expected candidate tarball and artifact directory");
const requestedDriver = parseReleaseVersion(driverTag);
assert(
  driverTag === "latest" || (requestedDriver && classifyReleaseTrain(requestedDriver) === "stable"),
  "Driver must be a published stable version",
);
const candidate = fs.realpathSync(candidateArg);
const artifacts = path.resolve(artifactsArg);
fs.mkdirSync(artifacts, { recursive: true });
const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-published-driver-"));
const prefix = path.join(runtime, "npm");
const state = path.join(accountHome, ".openclaw");
assert(!fs.existsSync(state), "The published-driver cell requires a fresh account home");
const packageRoot = path.join(prefix, "lib/node_modules/openclaw");
const bin = path.join(prefix, "bin");
const env = {
  PATH: `${bin}:${process.env.PATH}`,
  HOME: accountHome,
  TMPDIR: path.join(runtime, "tmp"),
  CI: "true",
  OPENCLAW_STATE_DIR: state,
  OPENCLAW_CONFIG_PATH: path.join(state, "openclaw.json"),
  OPENCLAW_NO_ONBOARD: "1",
  OPENCLAW_NO_PROMPT: "1",
  OPENCLAW_SKIP_PROVIDERS: "1",
  OPENCLAW_SKIP_CHANNELS: "1",
  OPENCLAW_DISABLE_BONJOUR: "1",
  npm_config_prefix: prefix,
  NPM_CONFIG_PREFIX: prefix,
  npm_config_cache: path.join(runtime, "npm-cache"),
  npm_config_audit: "false",
  npm_config_fund: "false",
  npm_config_loglevel: "error",
  XDG_RUNTIME_DIR: path.join(bin, "runtime"),
  DBUS_SESSION_BUS_ADDRESS: `unix:path=${path.join(bin, "runtime/bus")}`,
  OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_LOG: path.join(artifacts, "systemctl.log"),
  OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE: path.join(runtime, "service.pid"),
  OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_DAEMON_LOG: path.join(artifacts, "gateway.log"),
};
for (const directory of [env.HOME, env.TMPDIR, state, bin]) {
  fs.mkdirSync(directory, { recursive: true });
}

function writeJson(name, value) {
  fs.writeFileSync(path.join(artifacts, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
}

function run(name, command, args, allowFailure = false) {
  const started = Date.now();
  const out = fs.openSync(path.join(artifacts, `${name}.stdout`), "w");
  const err = fs.openSync(path.join(artifacts, `${name}.stderr`), "w");
  let result;
  try {
    result = spawnSync(command, args, { cwd: root, env, stdio: ["ignore", out, err] });
  } finally {
    fs.closeSync(out);
    fs.closeSync(err);
  }
  console.log(`${name}: exit=${result.status} durationMs=${Date.now() - started}`);
  writeJson(`${name}-exit`, { status: result.status, signal: result.signal });
  if (!allowFailure) {
    assert.equal(result.status, 0, `${name} failed; see ${artifacts}/${name}.stderr`);
  }
  return result;
}

function output(name) {
  const text = fs.readFileSync(path.join(artifacts, `${name}.stdout`), "utf8");
  return JSON.parse(text.slice(text.indexOf("{")));
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

function ready(name, port) {
  run(name, process.execPath, [
    "scripts/e2e/lib/upgrade-survivor/probe-gateway.mjs",
    "--base-url",
    `http://127.0.0.1:${port}`,
    "--path",
    "/readyz",
    "--expect",
    "ready",
    "--out",
    path.join(artifacts, `${name}.json`),
  ]);
  assert.equal(readJson(path.join(artifacts, `${name}.json`)).status, 200);
}

let fixtureInstalled = false;
try {
  run("resolve-driver", "npm", ["view", `openclaw@${driverTag}`, "version", "--json"]);
  const driverVersion = JSON.parse(
    fs.readFileSync(path.join(artifacts, "resolve-driver.stdout"), "utf8"),
  );
  const driverRelease = parseReleaseVersion(driverVersion);
  assert(
    driverRelease && classifyReleaseTrain(driverRelease) === "stable",
    "npm latest must resolve to stable",
  );
  run("install-driver", "npm", [
    "install",
    "-g",
    `openclaw@${driverVersion}`,
    "--no-fund",
    "--no-audit",
  ]);
  assert.equal(readJson(path.join(packageRoot, "package.json")).version, driverVersion);
  run("candidate-build", "tar", ["-xOf", candidate, "package/dist/build-info.json"]);
  const build = output("candidate-build");
  writeJson("inputs", { driverVersion, candidate: build });

  const port = await freePort();
  const token = "published-driver-synthetic-token";
  const config = {
    gateway: {
      mode: "local",
      port,
      bind: "loopback",
      auth: { mode: "token", token },
      reload: { mode: "off" },
    },
    plugins: { enabled: false },
    agents: {
      list: [
        { id: "main", default: true, workspace: path.join(runtime, "workspaces", "main") },
        { id: "second", workspace: path.join(runtime, "workspaces", "second") },
      ],
    },
  };
  for (const agent of config.agents.list) {
    fs.mkdirSync(agent.workspace, { recursive: true });
  }
  fs.writeFileSync(env.OPENCLAW_CONFIG_PATH, `${JSON.stringify(config)}\n`);
  run("fixture", "bash", [
    "-c",
    'source "$1"; install_update_restart_systemctl_shim absent',
    "fixture",
    "scripts/e2e/lib/upgrade-survivor/update-restart-auth.sh",
  ]);
  fixtureInstalled = true;
  run("seed-state", "openclaw", ["doctor", "--fix", "--non-interactive"]);
  run("install-service", "openclaw", ["gateway", "install", "--force", "--json"]);
  ready("before-ready", port);
  const beforePid = fs.readFileSync(env.OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE, "utf8");
  const update = run("update", "openclaw", ["update", "--tag", candidate, "--yes", "--json"], true);
  // Check the durable record too: a CLI return cannot stand in for restart finalization.
  run("recorded-run", "openclaw", ["update", "status", "--json"]);
  const result = output("update");
  const recorded = output("recorded-run").lastRun;
  assert(recorded, "Update omitted its durable run");
  for (const record of [result.run, recorded].filter(Boolean)) {
    assert(
      !/candidate-startup-failed|authority-check-failed/i.test(JSON.stringify(record)),
      "Update recorded startup or authority failure",
    );
    for (const step of record.steps ?? []) {
      if (step.step?.startsWith("warning:")) {
        assert(
          !/canary|identity|lease/i.test(JSON.stringify(step)),
          `Update boundary warning: ${JSON.stringify(step)}`,
        );
      }
    }
  }
  assert.equal(update.status, 0, "Published updater failed");
  assert.equal(result.status, "ok");
  assert.equal(recorded.runId, result.run?.runId, "Status read a different update run");
  assert.equal(recorded.phase, "finished");
  assert.equal(recorded.status, "succeeded");
  assert.equal(result.after?.version, build.version);
  assert.deepEqual(readJson(path.join(packageRoot, "dist/build-info.json")), build);
  assert.notEqual(
    fs.readFileSync(env.OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE, "utf8"),
    beforePid,
    "Update did not replace the managed service",
  );
  ready("after-ready", port);
  run("running-version", "openclaw", [
    "gateway",
    "probe",
    "--url",
    `ws://127.0.0.1:${port}`,
    "--token",
    token,
    "--json",
  ]);
  const target = output("running-version").targets.find(
    (entry) => entry.url === `ws://127.0.0.1:${port}`,
  );
  assert.equal(target?.connect.ok, true);
  assert.equal(target.server.version, build.version);
  writeJson("summary", {
    driverVersion,
    candidate: build,
    runId: recorded.runId,
    phase: recorded.phase,
    readyz: 200,
    runningVersion: target.server.version,
  });
  console.log(
    `PASS published ${driverVersion} → candidate ${build.version} (${build.commit}): finished, readyz=200, running version verified`,
  );
} finally {
  if (fixtureInstalled) {
    run("stop-service", path.join(bin, "systemctl"), [
      "--user",
      "stop",
      "openclaw-gateway.service",
    ]);
  }
  fs.rmSync(runtime, { recursive: true, force: true });
}
