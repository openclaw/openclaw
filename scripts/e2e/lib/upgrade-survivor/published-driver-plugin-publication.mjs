#!/usr/bin/env node
// A published updater's first update with official npm plugins installed, while the update may
// not write openclaw.json (a link to a read-only file, as a provisioned config is). Plugin
// convergence changes no config, so the update must still succeed. With
// OPENCLAW_PUBLISHED_DRIVER_PLUGIN_FAULT=corrupt-plugin, one plugin's target tarball is corrupt
// instead and the update must succeed with a warning for that plugin. Fixture data only.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runManagedCommand, terminateManagedChild } from "../../../lib/managed-child-process.mts";
import { packFirstHopUpdateFixture } from "../update-first-hop-package-fixtures.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const [candidateArg, artifactsArg, driverVersion] = process.argv.slice(2);
const fault = process.env.OPENCLAW_PUBLISHED_DRIVER_PLUGIN_FAULT || "symlinked-config";
assert(["symlinked-config", "corrupt-plugin"].includes(fault), "Unknown plugin publication fault");
assert(candidateArg && artifactsArg && driverVersion, "Expected candidate, artifacts and driver");
assert.equal(process.platform, "linux", "The managed-service fixture requires Linux");
assert(fs.existsSync("/.dockerenv"), "Run through the bare Docker E2E runner");
const accountHome = os.userInfo().homedir;
assert.equal(accountHome, "/home/appuser", "Expected the disposable E2E account");
const cellDeadline = Number(process.env.CELL_DEADLINE_EPOCH_SECONDS) * 1000;
assert(Number.isSafeInteger(cellDeadline) && cellDeadline > 0, "Expected the cell deadline");

const plugins = ["@openclaw/zalo", "@openclaw/voice-call"];
const corruptPlugin = "@openclaw/voice-call";
const candidate = fs.realpathSync(candidateArg);
const artifacts = path.resolve(artifactsArg);
fs.mkdirSync(artifacts, { recursive: true });
const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-publication-"));
const prefix = path.join(runtime, "npm");
const state = path.join(accountHome, ".openclaw");
assert(!fs.existsSync(state), "Requires a fresh account home");
const packageRoot = path.join(prefix, "lib/node_modules/openclaw");
const bin = path.join(prefix, "bin");
const configPath = path.join(state, "openclaw.json");
const managedConfigDir = path.join(accountHome, "managed-config");
const env = {
  PATH: `${bin}:${process.env.PATH}`,
  HOME: accountHome,
  TMPDIR: path.join(runtime, "tmp"),
  CI: "true",
  OPENCLAW_STATE_DIR: state,
  OPENCLAW_CONFIG_PATH: configPath,
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
for (const directory of [env.TMPDIR, state, bin]) {
  fs.mkdirSync(directory, { recursive: true });
}
process.env.OPENCLAW_STATE_DIR = state;
process.env.OPENCLAW_CONFIG_PATH = configPath;
const { readPluginInstallRecords } = await import("../plugin-index-sqlite.mjs");

const log = (line) => {
  console.log(line);
  fs.appendFileSync(path.join(artifacts, "timeline.log"), `${new Date().toISOString()} ${line}\n`);
};
const writeJson = (name, value) =>
  fs.writeFileSync(path.join(artifacts, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const parseJsonOutput = (name) => {
  const text = fs.readFileSync(path.join(artifacts, `${name}.stdout`), "utf8");
  const start = text.indexOf("{");
  return start >= 0 ? JSON.parse(text.slice(start)) : null;
};

async function run(name, command, args, commandEnv = env, timeoutMs = 15 * 60_000) {
  const started = Date.now();
  const out = fs.openSync(path.join(artifacts, `${name}.stdout`), "w");
  const err = fs.openSync(path.join(artifacts, `${name}.stderr`), "w");
  let exitCode;
  try {
    exitCode = await runManagedCommand({
      bin: command,
      args,
      cwd: root,
      env: commandEnv,
      stdio: ["ignore", out, err],
      timeoutMs: Math.min(timeoutMs, cellDeadline - 60_000 - Date.now()),
      timeoutKillGraceMs: 5_000,
      signalKillGraceMs: 5_000,
      abortKillGraceMs: 5_000,
      cleanupDrainTimeoutMs: 5_000,
      requireProcessTreeExit: true,
    });
  } finally {
    fs.closeSync(out);
    fs.closeSync(err);
  }
  log(`${name}: exit=${exitCode} ${Date.now() - started}ms`);
  return exitCode;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => {
    server.close(resolve);
  });
  return port;
}

/** Fixture npm registry: local packages win, everything else proxies to public npm. */
async function startRegistry(name, packageArgs, distTags) {
  const directory = fs.mkdtempSync(path.join(runtime, `registry-${name}-`));
  const logFd = fs.openSync(path.join(artifacts, `registry-${name}.log`), "w");
  const ready = Promise.withResolvers();
  let child;
  const done = runManagedCommand({
    bin: process.execPath,
    args: [
      path.join(root, "scripts/e2e/lib/plugins/npm-registry-server.mjs"),
      path.join(directory, "port"),
      ...packageArgs,
    ],
    env: {
      ...env,
      OPENCLAW_NPM_REGISTRY_UPSTREAM: "https://registry.npmjs.org",
      OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_URL: "",
      OPENCLAW_NPM_REGISTRY_MERGE_UPSTREAM: "versions",
      OPENCLAW_NPM_REGISTRY_DIST_TAGS: distTags,
      OPENCLAW_NPM_REGISTRY_BIND_HOST: "127.0.0.1",
      OPENCLAW_NPM_REGISTRY_PORT: "0",
    },
    stdio: ["ignore", logFd, logFd, "ipc"],
    timeoutMs: cellDeadline - Date.now(),
    requireProcessTreeExit: true,
    onReady(process) {
      child = process;
      child.once("message", ready.resolve);
    },
  });
  void done.then(() => ready.reject(new Error("registry exited before readiness")), ready.reject);
  const port = await ready.promise;
  return {
    url: `http://127.0.0.1:${port}`,
    async stop() {
      terminateManagedChild(child, "SIGTERM");
      await done.catch(() => {});
      fs.closeSync(logFd);
    },
  };
}

const registryEnv = (url, redirectCore = false) => ({
  ...env,
  npm_config_registry: url,
  NPM_CONFIG_REGISTRY: url,
  OPENCLAW_UPGRADE_SURVIVOR_NPM_REGISTRY: url,
  ...(redirectCore ? { OPENCLAW_UPGRADE_SURVIVOR_NPM_REGISTRY_CORE: "1" } : {}),
  NODE_OPTIONS: `--import=${path.join(root, "scripts/e2e/lib/upgrade-survivor/plugin-registry-redirect.mjs")}`,
});

function npmPack(spec, destination) {
  fs.mkdirSync(destination, { recursive: true });
  const [packed] = JSON.parse(
    execFileSync(
      "npm",
      [
        "pack",
        spec,
        "--registry=https://registry.npmjs.org",
        "--pack-destination",
        destination,
        "--ignore-scripts",
        "--json",
      ],
      { encoding: "utf8", env: { ...process.env, ...env } },
    ),
  );
  return path.join(destination, packed.filename);
}

function futurePlugin(sourceTgz, output) {
  execFileSync(process.execPath, [
    path.join(root, "scripts/e2e/lib/update-first-hop-package-fixtures.mjs"),
    "future-plugin-tarball",
    sourceTgz,
    output,
    "0",
  ]);
  return output;
}

/** What the update left: core, plugin records against their packages, history and serving. */
async function observe(label, port, token, commandEnv) {
  const records = readPluginInstallRecords();
  const facts = {
    coreVersion: readJson(path.join(packageRoot, "package.json")).version,
    plugins: Object.fromEntries(
      Object.entries(records).map(([id, record]) => [
        id,
        {
          version: record.resolvedVersion ?? record.version,
          diskVersion: readJson(path.join(record.installPath, "package.json")).version,
        },
      ]),
    ),
  };
  await run(`${label}-update-status`, "openclaw", ["update", "status", "--json"], commandEnv);
  facts.updateStatus = parseJsonOutput(`${label}-update-status`);
  const readyz = path.join(artifacts, `${label}-readyz.json`);
  await run(
    `${label}-readyz`,
    process.execPath,
    [
      "scripts/e2e/lib/upgrade-survivor/probe-gateway.mjs",
      "--base-url",
      `http://127.0.0.1:${port}`,
      "--path",
      "/readyz",
      "--expect",
      "ready",
      "--timeout-ms",
      "45000",
      "--attempt-timeout-ms",
      "1000",
      "--out",
      readyz,
    ],
    commandEnv,
  );
  facts.readyz = readJson(readyz).status;
  await run(
    `${label}-probe`,
    "openclaw",
    ["gateway", "probe", "--url", `ws://127.0.0.1:${port}`, "--token", token, "--json"],
    commandEnv,
  );
  facts.servingVersion = parseJsonOutput(`${label}-probe`)?.targets?.find(
    (target) => target.url === `ws://127.0.0.1:${port}`,
  )?.server?.version;
  await run(`${label}-plugins-list`, "openclaw", ["plugins", "list", "--json"], commandEnv);
  facts.loaded = Object.fromEntries(
    (parseJsonOutput(`${label}-plugins-list`)?.plugins ?? [])
      .filter((plugin) => Object.hasOwn(facts.plugins, plugin.id))
      .map((plugin) => [plugin.id, { version: plugin.version, status: plugin.status }]),
  );
  writeJson(`${label}-facts`, facts);
  return facts;
}

function assertConverged(facts, target, lagging) {
  assert.equal(facts.coreVersion, target);
  assert.equal(facts.servingVersion, target, "Gateway serves the updated core");
  assert.equal(facts.readyz, 200);
  for (const spec of plugins) {
    const id = spec.split("/")[1];
    const expected = spec === lagging ? driverVersion : target;
    assert.deepEqual(facts.plugins[id], { version: expected, diskVersion: expected }, id);
    assert.deepEqual(facts.loaded[id], { version: expected, status: "loaded" }, id);
  }
  assert.notEqual(facts.updateStatus?.lastRun?.status, "failed", "No failed update record");
  assert.deepEqual(facts.updateStatus?.owedSteps ?? [], [], "Nothing is owed");
}

const registries = [];
let failure;
try {
  log(`fault=${fault} driver=${driverVersion}`);
  assert.equal(
    await run("install-driver", "npm", ["install", "-g", `openclaw@${driverVersion}`]),
    0,
  );
  const port = await freePort();
  const token = "plugin-publication-synthetic-token";
  const workspace = path.join(runtime, "workspaces", "main");
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(
    configPath,
    `${JSON.stringify({
      gateway: {
        mode: "local",
        port,
        bind: "loopback",
        auth: { mode: "token", token },
        reload: { mode: "off" },
      },
      agents: { ownership: "explicit", entries: { main: { workspace } } },
    })}\n`,
  );
  assert.equal(
    await run("fixture", "bash", [
      "-c",
      'source "$1"; install_update_restart_systemctl_shim absent',
      "fixture",
      "scripts/e2e/lib/upgrade-survivor/update-restart-auth.sh",
    ]),
    0,
  );
  assert.equal(await run("seed-doctor", "openclaw", ["doctor", "--fix", "--non-interactive"]), 0);
  for (const spec of plugins) {
    const id = spec.split("/")[1];
    assert.equal(
      await run(`plugin-install-${id}`, "openclaw", ["plugins", "install", `npm:${spec}`]),
      0,
    );
  }
  assert.equal(await run("install-service", "openclaw", ["gateway", "install", "--force"]), 0);

  // A future core cut from the candidate, and the same future version of each plugin.
  const fixtures = path.join(runtime, "fixtures");
  fs.mkdirSync(fixtures, { recursive: true });
  const core = path.join(fixtures, "openclaw-core.tgz");
  const target = packFirstHopUpdateFixture(candidate, core, 0).targetVersion;
  const futures = plugins.flatMap((spec) => [
    spec,
    target,
    futurePlugin(
      npmPack(`${spec}@${driverVersion}`, path.join(fixtures, "published")),
      path.join(fixtures, `${spec.split("/")[1]}-future.tgz`),
    ),
  ]);
  // The corrupt fault serves a truncated target for one plugin on the first update only.
  const served = futures.map((entry, index) => {
    if (fault !== "corrupt-plugin" || futures[index - 2] !== corruptPlugin) {
      return entry;
    }
    const bytes = fs.readFileSync(entry);
    const corrupt = path.join(fixtures, "corrupt.tgz");
    fs.writeFileSync(
      corrupt,
      Buffer.concat([bytes.subarray(0, Math.floor(bytes.length / 3)), randomBytes(512)]),
    );
    return corrupt;
  });
  const tags = `latest=${target},beta=${target}`;
  const firstRegistry = await startRegistry("first-hop", served, tags);
  registries.push(firstRegistry);
  const updateEnv = registryEnv(firstRegistry.url);
  const configBefore = fs.readFileSync(configPath, "utf8");
  if (fault === "symlinked-config") {
    // A provisioned config: the update can read it, but cannot replace it.
    fs.mkdirSync(managedConfigDir);
    const managed = path.join(managedConfigDir, "openclaw.json");
    fs.renameSync(configPath, managed);
    fs.symlinkSync(managed, configPath);
    fs.chmodSync(managed, 0o444);
    fs.chmodSync(managedConfigDir, 0o555);
  }
  const firstExit = await run(
    "first-update",
    "openclaw",
    ["update", "--yes", "--json", "--tag", core],
    updateEnv,
    30 * 60_000,
  );
  const first = parseJsonOutput("first-update");
  writeJson("first-update-result", { exitCode: firstExit, result: first });
  // Observe before asserting, so a failed update still records what it left serving.
  const afterFirst = await observe("after-first", port, token, updateEnv);
  assert.equal(firstExit, 0, "The first update succeeds");
  assert.equal(first?.run?.status, "succeeded");
  if (fault === "corrupt-plugin") {
    assert(
      first.postUpdate?.plugins?.warnings?.some((warning) => warning.pluginId === "voice-call"),
      "The corrupt plugin is reported as a plugin warning",
    );
  } else {
    // Plugin convergence changed no config, so the update left the file untouched.
    assert.equal(fs.readFileSync(configPath, "utf8"), configBefore);
  }
  assertConverged(afterFirst, target, fault === "corrupt-plugin" ? corruptPlugin : undefined);
  await firstRegistry.stop();
  registries.pop();

  // The fault is gone and no newer release exists: the next update is clean.
  if (fault === "symlinked-config") {
    fs.chmodSync(managedConfigDir, 0o755);
    fs.rmSync(configPath);
    fs.renameSync(path.join(managedConfigDir, "openclaw.json"), configPath);
    fs.chmodSync(configPath, 0o600);
  }
  const retryRegistry = await startRegistry("retry", [...futures, "openclaw", target, core], tags);
  registries.push(retryRegistry);
  const retryEnv = registryEnv(retryRegistry.url, true);
  const retryExit = await run("retry-update", "openclaw", ["update", "--yes", "--json"], retryEnv);
  writeJson("retry-update-result", {
    exitCode: retryExit,
    result: parseJsonOutput("retry-update"),
  });
  assert.equal(retryExit, 0, "The next update succeeds");
  assertConverged(await observe("after-retry", port, token, retryEnv), target, undefined);
  log("plugin publication cell passed");
} catch (error) {
  failure = error;
  log(`cell failure: ${error?.stack ?? error}`);
} finally {
  for (const registry of registries) {
    await registry.stop();
  }
  await run("stop-service", path.join(bin, "systemctl"), [
    "--user",
    "stop",
    "openclaw-gateway.service",
  ]).catch(() => undefined);
}
if (failure) {
  process.exitCode = 1;
}
