#!/usr/bin/env node
// Native managed-service proof with shared survivor seeds and assertions.
// Run as root on a disposable Linux Crabbox guest; never on an operator host.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  assertNativeUnit,
  assertNativeUpdate,
  planNativeUpgradeSurvivor,
} from "./native-systemd-contract.mjs";

const [candidateArg, artifactsArg, ...baselines] = process.argv.slice(2);
const selectedBaselines = candidateArg === "--plan" ? process.argv.slice(3) : baselines;
const plan = planNativeUpgradeSurvivor({
  baselines: selectedBaselines.length ? selectedBaselines : undefined,
});
if (candidateArg === "--plan") {
  console.log(JSON.stringify(plan, null, 2));
  process.exit(0);
}
assert.equal(process.platform, "linux");
assert.equal(process.getuid(), 0, "Run as root on a disposable Linux Crabbox guest");
assert(!fs.existsSync("/.dockerenv"), "Native systemd proof requires a VM");
assert(
  candidateArg && artifactsArg,
  "Usage: native-systemd.mjs candidate.tgz artifacts [baseline versions...]",
);
const artifacts = path.resolve(artifactsArg);
fs.mkdirSync(artifacts, { recursive: true });
const harness = path.dirname(import.meta.filename);
const runtime = fs.mkdtempSync("/tmp/openclaw-survivor-systemd-");
fs.chmodSync(runtime, 0o755);
const candidateFile = path.join(runtime, "candidate.tgz");
fs.copyFileSync(path.resolve(candidateArg), candidateFile);
fs.chmodSync(candidateFile, 0o644);
const summary = {
  flow: "systemd",
  candidateSha256: createHash("sha256").update(fs.readFileSync(candidateFile)).digest("hex"),
  cases: [],
};
const save = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
let cellDir = artifacts;
function run(
  name,
  command,
  args,
  { env = process.env, cwd = runtime, timeout = 180_000, allowFailure = false } = {},
) {
  fs.writeFileSync(path.join(cellDir, "phase.txt"), `${name}\n`);
  const stdout = fs.openSync(path.join(cellDir, `${name}.stdout`), "w");
  const stderr = fs.openSync(path.join(cellDir, `${name}.stderr`), "w");
  let result;
  try {
    result = spawnSync(command, args, {
      env,
      cwd,
      timeout,
      killSignal: "SIGTERM",
      stdio: ["ignore", stdout, stderr],
    });
  } finally {
    fs.closeSync(stdout);
    fs.closeSync(stderr);
  }
  save(path.join(cellDir, `${name}.result.json`), {
    exitCode: result.status,
    signal: result.signal,
    error: result.error?.message,
  });
  if (!allowFailure) {
    assert.equal(result.status, 0, `${name} failed; see ${cellDir}`);
  }
  return { ...result, stdout: fs.readFileSync(path.join(cellDir, `${name}.stdout`), "utf8") };
}
const candidate = JSON.parse(
  run("candidate-identity", "tar", ["-xOf", candidateFile, "package/dist/build-info.json"]).stdout,
);
assert(candidate.version && candidate.buildId, "Candidate build identity missing");
summary.candidate = candidate;
save(path.join(artifacts, "plan.json"), plan);
try {
  for (const row of plan) {
    cellDir = path.join(artifacts, row.version);
    fs.mkdirSync(cellDir);
    const user = `ocsurv${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const home = `/home/${user}`;
    run("user-create", "useradd", ["--create-home", "--shell", "/bin/bash", user]);
    const uid = run("uid", "id", ["-u", user]).stdout.trim();
    const state = `${home}/.openclaw`;
    const workspace = `${home}/workspace`;
    const prefix = `${home}/npm`;
    const cli = `${prefix}/bin/openclaw`;
    const packageRoot = `${prefix}/lib/node_modules/openclaw`;
    const env = {
      HOME: home,
      USER: user,
      LOGNAME: user,
      PATH: `${prefix}/bin:${path.dirname(process.execPath)}:${process.env.PATH}`,
      XDG_RUNTIME_DIR: `/run/user/${uid}`,
      DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${uid}/bus`,
      OPENCLAW_STATE_DIR: state,
      OPENCLAW_CONFIG_PATH: `${state}/openclaw.json`,
      OPENCLAW_TEST_WORKSPACE_DIR: workspace,
      OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: "base",
      OPENCLAW_UPGRADE_SURVIVOR_BASELINE_VERSION: row.version,
      npm_config_prefix: prefix,
      CI: "1",
    };
    const asUser = (name, command, args, options) =>
      run(
        name,
        "runuser",
        [
          "-u",
          user,
          "--",
          "env",
          "-i",
          ...Object.entries(env).map(([key, value]) => `${key}=${value}`),
          command,
          ...args,
        ],
        { cwd: home, ...options },
      );
    const oracle = (name, command, args = []) =>
      run(name, process.execPath, [path.join(harness, "assertions.mjs"), command, ...args], {
        env: { ...env, PATH: process.env.PATH },
      });
    const unit = (name, allowFailure = false) => {
      const output = asUser(
        name,
        "systemctl",
        [
          "--user",
          "show",
          "openclaw-gateway.service",
          "--property=MainPID,ControlGroup,ActiveState,SubState,FragmentPath",
        ],
        { allowFailure },
      ).stdout;
      const facts = Object.fromEntries(
        output
          .trim()
          .split("\n")
          .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
      );
      save(path.join(cellDir, `${name}.json`), facts);
      return facts;
    };
    const record = { ...row, home, uid, status: "failed" };
    summary.cases.push(record);
    let linger = false;
    try {
      run("linger", "loginctl", ["enable-linger", user]);
      linger = true;
      run("user-manager", "systemctl", ["start", `user@${uid}.service`]);
      asUser("mkdir", "mkdir", ["-p", state, workspace, prefix]);
      record.runtime = JSON.parse(
        asUser("runtime", "node", [
          "-p",
          "JSON.stringify({version:process.version,execPath:process.execPath,sqlite:process.versions.sqlite})",
        ]).stdout,
      );
      assert.equal(
        record.runtime.version,
        process.version,
        "Fixture runtime differs from controller",
      );
      record.npmVersion = asUser("npm-version", "npm", ["--version"]).stdout.trim();
      asUser(
        "baseline-install",
        "npm",
        ["install", "--global", "--prefix", prefix, "--no-audit", "--no-fund", row.baseline],
        { timeout: 900_000 },
      );
      const baseline = JSON.parse(fs.readFileSync(`${packageRoot}/dist/build-info.json`, "utf8"));
      assert.equal(baseline.version, row.version);
      record.baselineIdentity = baseline;
      oracle("seed", "seed", [packageRoot]);
      const token = "synthetic-native-survivor-token";
      const port = 19751;
      save(`${state}/openclaw.json`, {
        gateway: {
          mode: "local",
          bind: "loopback",
          port,
          auth: { mode: "token", token },
          reload: { mode: "off" },
        },
        plugins: { enabled: false },
        agents: { defaults: { workspace, heartbeat: { every: "0m" } } },
      });
      run("seed-owner", "chown", ["-R", `${user}:${user}`, state, workspace]);
      // The shared seed includes legacy sessions. Prepare them with the actual
      // baseline before requiring a healthy native predecessor for the update.
      asUser("baseline-doctor", cli, ["doctor", "--fix", "--non-interactive"]);
      asUser("service-install", cli, [
        "gateway",
        "install",
        "--force",
        "--runtime",
        "node",
        "--port",
        String(port),
        "--token",
        token,
        "--json",
      ]);
      const probe = (stage) => {
        for (const [endpoint, expectation] of [
          ["healthz", "live"],
          ["readyz", "ready"],
        ]) {
          run(
            `${stage}-${endpoint}`,
            process.execPath,
            [
              path.join(harness, "probe-gateway.mjs"),
              "--base-url",
              `http://127.0.0.1:${port}`,
              "--path",
              `/${endpoint}`,
              "--expect",
              expectation,
              "--timeout-ms",
              "180000",
              "--out",
              path.join(cellDir, `${stage}-${endpoint}.json`),
            ],
            { timeout: 190_000 },
          );
        }
        return JSON.parse(
          asUser(`${stage}-rpc`, cli, [
            "gateway",
            "status",
            "--url",
            `ws://127.0.0.1:${port}`,
            "--token",
            token,
            "--require-rpc",
            "--timeout",
            "30000",
            "--json",
          ]).stdout,
        );
      };
      record.beforeRpc = probe("before");
      record.before = unit("before-unit");
      assertNativeUnit(record.before, { home, uid });
      assert.equal(record.beforeRpc.rpc?.ok, true);
      assert.equal(record.beforeRpc.rpc.server.buildId, baseline.buildId);
      // This is the installed published updater. Only it may stop/restart the
      // service between these observations; no harness start follows this call.
      const update = asUser(
        "update",
        cli,
        [
          "update",
          ...row.updateArgs,
          "--tag",
          candidateFile,
          "--yes",
          "--json",
          "--timeout",
          "1500",
        ],
        { timeout: 1800_000, allowFailure: true },
      );
      record.updateExitCode = update.status;
      record.update = JSON.parse(update.stdout);
      assert.equal(update.status, 0, `Published updater failed: ${record.update.reason}`);
      record.afterRpc = probe("after");
      record.after = unit("after-unit");
      assertNativeUnit(record.after, { home, uid });
      assertNativeUpdate({
        result: record.update,
        before: record.before,
        after: record.after,
        rpc: record.afterRpc,
        candidate,
      });
      oracle("state-survived", "assert-state");
      oracle("approvals-survived", "assert-exec-approvals");
    } catch (error) {
      record.error = String(error);
      throw error;
    } finally {
      // Preserve failure facts before stopping even when the update fails.
      asUser("recorded-run", cli, ["update", "status", "--json"], { allowFailure: true });
      asUser(
        "journal",
        "journalctl",
        ["--user-unit=openclaw-gateway.service", "--no-pager", "-n", "250"],
        { allowFailure: true },
      );
      unit("final-unit", true);
      asUser("stop", "systemctl", ["--user", "stop", "openclaw-gateway.service"], {
        allowFailure: true,
      });
      const stopped = unit("stopped-unit", true);
      record.stopped = stopped;
      save(path.join(artifacts, "summary.json"), summary);
      assert.equal(stopped.MainPID, "0", "Owned native service did not stop");
      if (linger) {
        run("disable-linger", "loginctl", ["disable-linger", user]);
      }
    }
    record.status = "passed";
    console.log(`${row.baseline} -> ${candidate.buildId}: PASS`);
  }
} finally {
  save(path.join(artifacts, "summary.json"), summary);
  fs.rmSync(runtime, { recursive: true, force: true });
}
