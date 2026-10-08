import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { runCancelableCommand } from "../../../lib/cancelable-command.mts";
import { toErrorObject } from "../../../lib/error-format.mts";
import { runManagedCommand } from "../../../lib/managed-child-process.mts";
import { sourceCustodyStateEnvironment, snapshotSourceCustodyState } from "./state.mjs";

const baseline = "bcfc88812a35243893585dbeca87ca41b48272ca";
const root = "/home/appuser/source-custody/release";
const prefix = "/home/appuser/source-custody/prefix";
const artifacts = "/proof";
const [mode, cell] = process.argv.slice(2);
assert.equal(process.platform, "linux");
assert(fs.existsSync("/.dockerenv"), "This destructive fixture requires its Docker namespace");
assert.equal(os.userInfo().homedir, "/home/appuser");
assert(["prepare", "cell"].includes(mode));
assert(mode === "prepare" || ["legacy", "escaped", "active", "stopped"].includes(cell));
const candidate = process.env.OPENCLAW_SOURCE_CUSTODY_CANDIDATE_SHA;
assert.match(candidate ?? "", /^[a-f0-9]{40}$/);
const deadline = Number(process.env.OPENCLAW_SOURCE_CUSTODY_DEADLINE) * 1000;
assert(Number.isSafeInteger(deadline) && deadline > Date.now());
const env = {
  PATH: prefix + "/bin:" + process.env.PATH,
  ...sourceCustodyStateEnvironment(os.userInfo().homedir),
  CI: "true",
  COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
  OPENCLAW_NO_ONBOARD: "1",
  OPENCLAW_NO_PROMPT: "1",
  OPENCLAW_SKIP_PROVIDERS: "1",
  OPENCLAW_SKIP_CHANNELS: "1",
  OPENCLAW_DISABLE_BONJOUR: "1",
  npm_config_prefix: prefix,
  npm_config_cache: "/home/appuser/.npm",
  OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_LOG: artifacts + "/systemctl.log",
  OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_PID_FILE: artifacts + "/service.pid",
  OPENCLAW_UPGRADE_SURVIVOR_SYSTEMCTL_SHIM_DAEMON_LOG: artifacts + "/gateway.log",
  XDG_RUNTIME_DIR: prefix + "/bin/runtime",
  DBUS_SESSION_BUS_ADDRESS: "unix:path=" + prefix + "/bin/runtime/bus",
};
const json = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const record = (name, value) =>
  fs.writeFileSync(path.join(artifacts, name + ".json"), JSON.stringify(value, null, 2) + "\n");
const digest = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
let commandSignal;
async function run(name, bin, args, options = {}) {
  const started = Date.now();
  const timeoutMs = deadline - started - 30_000;
  assert(timeoutMs > 0, "Cell work budget exhausted; cleanup grace retained");
  fs.writeFileSync(artifacts + "/phase.txt", name + "\n");
  const stdout = fs.openSync(artifacts + "/" + name + ".stdout", "w");
  const stderr = fs.openSync(artifacts + "/" + name + ".stderr", "w");
  let code;
  let pid;
  try {
    code = await runManagedCommand({
      bin,
      args,
      onReady: (child) => {
        pid = child.pid;
      },
      cwd: options.cwd ?? "/app",
      env: { ...env, ...options.env },
      stdio: ["ignore", stdout, stderr],
      signal: commandSignal,
      timeoutMs,
      timeoutKillGraceMs: 5_000,
      abortKillGraceMs: 5_000,
      signalKillGraceMs: 5_000,
      cleanupDrainTimeoutMs: 5_000,
      requireProcessTreeExit: true,
    });
  } finally {
    fs.closeSync(stdout);
    fs.closeSync(stderr);
    record(name + "-exit", { code: code ?? null, pid, durationMs: Date.now() - started });
  }
  if (!options.allowFailure) {
    assert.equal(code, 0, name + " failed; inspect its logs");
  }
  return code;
}
function output(name) {
  const text = fs.readFileSync(artifacts + "/" + name + ".stdout", "utf8");
  return JSON.parse(text.slice(text.indexOf("{")));
}
async function git(name, args) {
  await run(name, "git", ["-C", root, ...args]);
  return fs.readFileSync(artifacts + "/" + name + ".stdout", "utf8").trim();
}
async function identity(name, expected) {
  assert.equal(await git(name + "-head", ["rev-parse", "HEAD"]), expected);
  assert.equal(await git(name + "-clean", ["status", "--porcelain", "--untracked-files=no"]), "");
  const manifest = json(root + "/package.json");
  assert.equal(manifest.version, "2026.9.9");
  assert.deepEqual(manifest.openclaw.schemaVersions, {
    state: expected === baseline ? 19 : 20,
    agent: 24,
  });
  const build = json(root + "/dist/build-info.json");
  assert.equal(
    await git(name + "-built-commit", ["rev-parse", build.commit + "^{commit}"]),
    expected,
  );
  const wrapper = fs.readFileSync(prefix + "/bin/openclaw", "utf8");
  assert(wrapper.includes(prefix + "/tools/node/bin/node"));
  assert(wrapper.includes(root + "/dist/entry.js"));
  await run(name + "-version", prefix + "/bin/openclaw", ["--version"]);
  record(name, {
    sourceSha: expected,
    packageVersion: manifest.version,
    schemas: manifest.openclaw.schemaVersions,
    build,
    entrySha256: digest(root + "/dist/entry.js"),
    wrapperSha256: digest(prefix + "/bin/openclaw"),
    distribution: "published-release-source-build, not npm binary",
  });
  return build;
}
function admitResources() {
  const minimum = 16 * 1024 ** 3;
  const host =
    Number(/^MemTotal:\s+(\d+)\s+kB/m.exec(fs.readFileSync("/proc/meminfo", "utf8"))?.[1]) * 1024;
  const limitPath = fs.existsSync("/sys/fs/cgroup/memory.max")
    ? "/sys/fs/cgroup/memory.max"
    : "/sys/fs/cgroup/memory/memory.limit_in_bytes";
  const raw = fs.readFileSync(limitPath, "utf8").trim();
  const limit = raw === "max" ? Infinity : Number(raw);
  record("resources", {
    hostMemoryBytes: host,
    cgroupMemoryBytes: Number.isFinite(limit) ? limit : null,
    requiredBytes: minimum,
    cpus: os.availableParallelism(),
  });
  assert(
    host >= minimum && limit >= minimum,
    "Source build requires at least 16 GiB host and container memory",
  );
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(toErrorObject(error, "Probe socket cleanup failed"));
      } else {
        resolve();
      }
    });
  });
  return port;
}
async function ready(name, port) {
  await run(name, process.execPath, [
    "scripts/e2e/lib/upgrade-survivor/probe-gateway.mjs",
    "--base-url",
    "http://127.0.0.1:" + port,
    "--path",
    "/readyz",
    "--expect",
    "ready",
    "--timeout-ms",
    "30000",
    "--attempt-timeout-ms",
    "1000",
    "--out",
    artifacts + "/" + name + ".json",
  ]);
}
function serviceMutations() {
  return fs
    .readFileSync(artifacts + "/systemctl.log", "utf8")
    .split("\n")
    .filter((line) => /(?:^| )(?:start|stop|restart|enable|disable)(?: |$)/.test(line));
}
async function executeCell() {
  const inheritedState = snapshotSourceCustodyState(env.OPENCLAW_STATE_DIR);
  record("inherited-state", inheritedState);
  assert.deepEqual(inheritedState, json(prefix + "/prepared-state.json"));
  const oldBuild = await identity("installed-source", baseline);
  const port = await freePort();
  fs.mkdirSync(env.OPENCLAW_STATE_DIR, { recursive: true });
  assert(!fs.existsSync(env.OPENCLAW_CONFIG_PATH), "Cell configuration must be fresh");
  fs.mkdirSync(env.OPENCLAW_STATE_DIR + "/workspace");
  fs.writeFileSync(
    env.OPENCLAW_CONFIG_PATH,
    JSON.stringify({
      gateway: {
        mode: "local",
        bind: "loopback",
        port,
        auth: { mode: "token", token: "source-custody-synthetic-token" },
        reload: { mode: "off" },
      },
      update: { channel: "dev" },
      plugins: { enabled: false },
      agents: {
        defaults: { workspace: env.OPENCLAW_STATE_DIR + "/workspace", heartbeat: { every: "0m" } },
      },
    }) + "\n",
  );
  await run("source-status", prefix + "/bin/openclaw", ["update", "status", "--json"]);
  assert.equal(output("source-status").update?.installKind, "git");
  await run("service-fixture", "bash", [
    "-c",
    "source scripts/e2e/lib/upgrade-survivor/update-restart-auth.sh; install_update_restart_systemctl_shim absent",
  ]);
  await run("install-service", prefix + "/bin/openclaw", [
    "gateway",
    "install",
    "--force",
    "--json",
  ]);
  await ready("before-ready", port);
  await run("before-probe", prefix + "/bin/openclaw", [
    "gateway",
    "probe",
    "--url",
    "ws://127.0.0.1:" + port,
    "--token",
    "source-custody-synthetic-token",
    "--json",
  ]);
  const originalServing = output("before-probe").targets.find(
    (entry) => entry.url === "ws://127.0.0.1:" + port,
  );
  assert.equal(originalServing?.connect.ok, true);
  assert.equal(originalServing.server.version, "2026.9.9");
  assert.equal(typeof oldBuild.buildId, "string");
  assert.equal(originalServing.server.buildId, oldBuild.buildId);
  const gateway = async (name, method, params) => {
    await run(name, prefix + "/bin/openclaw", [
      "gateway",
      "call",
      method,
      "--json",
      "--url",
      "ws://127.0.0.1:" + port,
      "--token",
      "source-custody-synthetic-token",
      "--params",
      JSON.stringify(params),
    ]);
    return output(name);
  };
  const session = await gateway("create", "sessions.create", {
    agentId: "main",
    key: "agent:main:source-custody-proof",
  });
  assert.equal(session.ok, true);
  assert.equal(session.runStarted, false);
  const sessionParams = { agentId: "main", sessionKey: session.key };
  await gateway("inject", "chat.inject", {
    ...sessionParams,
    message: "source custody preserves ordered history π 雪",
  });
  const history = await gateway("before-history", "chat.history", { ...sessionParams, limit: 20 });
  assert.equal(history.sessionId, session.sessionId);
  const config = fs.readFileSync(env.OPENCLAW_CONFIG_PATH, "utf8");
  const servicePid = fs.readFileSync(artifacts + "/service.pid", "utf8");
  if (cell === "stopped") {
    await run("operator-stop", prefix + "/bin/systemctl", [
      "--user",
      "stop",
      "openclaw-gateway.service",
    ]);
  }
  const lifecycleBefore = serviceMutations();
  const refused = cell === "legacy" || cell === "escaped";
  const ownerFile = root + "/.artifacts/dist-artifacts.lock/owner.json";
  let owner;
  if (refused) {
    await run(
      "abandon-owner",
      prefix + "/tools/node/bin/node",
      [
        "--import",
        root + "/scripts/tsx.mjs",
        "/app/scripts/e2e/lib/source-update-custody/owner.mjs",
        root,
        cell,
      ],
      { cwd: root },
    );
    owner = fs.readFileSync(ownerFile, "utf8");
    assert.equal(json(ownerFile).pid, json(artifacts + "/abandon-owner-exit.json").pid);
    assert.equal(
      json(ownerFile).startIdentity,
      undefined,
      "Released owner must remain identityless",
    );
  }
  const entryBefore = digest(root + "/dist/entry.js");
  const code = await run(
    "update",
    prefix + "/bin/openclaw",
    ["update", "--yes", "--json", ...(cell === "stopped" ? ["--no-restart"] : [])],
    { env: { OPENCLAW_UPDATE_DEV_TARGET_REF: candidate }, allowFailure: true },
  );
  const result = output("update");
  if (refused) {
    assert.notEqual(code, 0);
    assert.equal(result.reason, "source-artifact-ownership");
    assert.equal(await git("refused-head", ["rev-parse", "HEAD"]), baseline);
    assert.equal(fs.readFileSync(ownerFile, "utf8"), owner);
    assert.equal(digest(root + "/dist/entry.js"), entryBefore);
    assert.equal(fs.readFileSync(env.OPENCLAW_CONFIG_PATH, "utf8"), config);
    assert.deepEqual(
      serviceMutations(),
      lifecycleBefore,
      "Refused update stopped or changed service intent",
    );
    assert.equal(fs.readFileSync(artifacts + "/service.pid", "utf8"), servicePid);
    if (cell === "escaped") {
      const leaf = json(artifacts + "/leaf.json");
      assert.equal(
        fs
          .readFileSync("/proc/" + leaf.pid + "/stat", "utf8")
          .split(") ")[1]
          .split(" ")[19],
        leaf.starttime,
      );
      assert(
        !fs
          .readFileSync("/proc/" + leaf.pid + "/stat", "utf8")
          .split(") ")[1]
          .startsWith("Z "),
      );
    }
  } else {
    assert.equal(code, 0);
    assert.equal(result.status, "ok");
    await identity("candidate-source", candidate);
    const originalConfig = JSON.parse(config);
    const currentConfig = json(env.OPENCLAW_CONFIG_PATH);
    // The updater owns bookkeeping timestamps/version fields, not user settings.
    delete originalConfig.meta;
    delete currentConfig.meta;
    assert.deepEqual(currentConfig, originalConfig, "User configuration changed");
    if (cell === "stopped") {
      assert.deepEqual(
        serviceMutations(),
        lifecycleBefore,
        "No-restart update changed stopped service intent",
      );
      assert.equal(fs.existsSync(artifacts + "/service.pid"), false);
      // A deliberate fixture start after the no-start assertion permits history inspection.
      await run("verification-start", prefix + "/bin/systemctl", [
        "--user",
        "start",
        "openclaw-gateway.service",
      ]);
    } else {
      assert.notEqual(fs.readFileSync(artifacts + "/service.pid", "utf8"), servicePid);
    }
  }
  await ready("after-ready", port);
  const afterHistory = await gateway("after-history", "chat.history", {
    ...sessionParams,
    limit: 20,
  });
  assert.equal(afterHistory.sessionId, history.sessionId);
  assert.deepEqual(afterHistory.messages, history.messages, "Durable history changed");
  await run("after-probe", prefix + "/bin/openclaw", [
    "gateway",
    "probe",
    "--url",
    "ws://127.0.0.1:" + port,
    "--token",
    "source-custody-synthetic-token",
    "--json",
  ]);
  const serving = output("after-probe").targets.find(
    (entry) => entry.url === "ws://127.0.0.1:" + port,
  );
  assert.equal(serving?.connect.ok, true);
  assert.equal(serving.server.version, "2026.9.9");
  const expectedBuild = refused ? oldBuild : json(root + "/dist/build-info.json");
  assert.equal(typeof expectedBuild.buildId, "string");
  assert.equal(serving.server.buildId, expectedBuild.buildId);
  await run("cleanup-stop", prefix + "/bin/systemctl", [
    "--user",
    "stop",
    "openclaw-gateway.service",
  ]);
  record("summary", {
    cell,
    baseline,
    candidate,
    oldBuild,
    result,
    outcome: refused ? "refused-before-stop" : "updated",
    historyPreserved: true,
    serviceManager: "synthetic adapter with real Gateway",
    originalIntent: cell === "stopped" ? "stopped" : "active",
    productDistribution: "source-build",
  });
}
process.exitCode = await runCancelableCommand(async (signal) => {
  commandSignal = signal;
  admitResources();
  if (mode === "prepare") {
    const initialState = snapshotSourceCustodyState(env.OPENCLAW_STATE_DIR);
    record("before-install-state", initialState);
    assert.deepEqual(initialState, [], "Bare image must have no preexisting account state");
    assert(!fs.existsSync(root));
    fs.mkdirSync(root, { recursive: true });
    await git("init", ["init", "--initial-branch=main"]);
    await git("origin", ["remote", "add", "origin", "https://github.com/openclaw/openclaw.git"]);
    await git("baseline-fetch", ["fetch", "--depth=1", "origin", baseline]);
    await git("baseline-checkout", ["checkout", "--detach", baseline]);
    await run("install-source", "bash", [
      root + "/scripts/install-cli.sh",
      "--install-method",
      "git",
      "--git-dir",
      root,
      "--version",
      baseline,
      "--no-git-update",
      "--prefix",
      prefix,
      "--node-version",
      "24.21.0",
      "--no-onboard",
    ]);
    await identity("prepared-source", baseline);
    const preparedState = snapshotSourceCustodyState(env.OPENCLAW_STATE_DIR);
    record("after-install-state", preparedState);
    fs.writeFileSync(prefix + "/prepared-state.json", JSON.stringify(preparedState) + "\n");
    assert(
      !fs.existsSync(env.OPENCLAW_CONFIG_PATH),
      "Installer created config; preserve and inspect it",
    );
  } else {
    await executeCell();
  }
  return 0;
});
