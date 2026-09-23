#!/usr/bin/env node
// Installed-package proof: real Gateway, paired node, npm, and supervisor processes.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { packNodeUpdateFixture } from "./package-fixtures.mjs";
import { createNodeUpdateProofPlugin } from "./proof-plugin.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const [inputTarball, requestedRoot] = process.argv.slice(2);
assert(inputTarball, "usage: scenario.mjs <built-openclaw.tgz> [new-artifact-directory]");
assert.equal(process.platform, "linux", "this Crabbox proof targets Linux");
const tarball = fs.realpathSync(inputTarball);
const root = requestedRoot
  ? path.resolve(requestedRoot)
  : fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-node-auto-update-proof-"));
if (requestedRoot) {
  fs.mkdirSync(root);
}
assert(
  !root.startsWith(`${repository}${path.sep}`),
  "keep proof state outside the synced checkout",
);
const children = new Set();
const servers = new Set();
const observations = [];
const token = `node-auto-update-proof-${randomUUID()}`;
const upstream =
  process.env.NPM_CONFIG_REGISTRY ??
  process.env.npm_config_registry ??
  "https://registry.npmjs.org";
const cleanEnv = Object.fromEntries(
  ["PATH", "TMPDIR", "LANG", "LC_ALL", "USER", "LOGNAME", "SHELL"].flatMap((key) =>
    process.env[key] === undefined ? [] : [[key, process.env[key]]],
  ),
);
Object.assign(cleanEnv, {
  CI: "1",
  NO_COLOR: "1",
  OPENCLAW_DISABLE_BONJOUR: "1",
  OPENCLAW_SKIP_CHANNELS: "1",
  OPENCLAW_SKIP_PROVIDERS: "1",
  OPENCLAW_NO_ONBOARD: "1",
  npm_config_cache: path.join(root, "npm-cache"),
  npm_config_audit: "false",
  npm_config_fund: "false",
  NPM_CONFIG_REGISTRY: upstream,
});

function record(event, facts = {}) {
  const row = { at: new Date().toISOString(), event, ...facts };
  observations.push(row);
  fs.writeFileSync(
    path.join(root, "observations.json"),
    `${JSON.stringify(observations, null, 2)}\n`,
  );
  console.log(JSON.stringify(row));
}

function start(label, executable, args, env, captureOutput = false) {
  const logPath = path.join(root, `${label}.log`);
  const output = fs.openSync(logPath, "a");
  const child = spawn(executable, args, {
    env,
    stdio: ["ignore", captureOutput ? "pipe" : output, output],
    detached: true,
  });
  fs.closeSync(output);
  let stdout = "";
  child.stdout?.on("data", (chunk) => {
    stdout += chunk.toString();
    fs.appendFileSync(logPath, chunk);
  });
  children.add(child);
  record("phase-start", { label, pid: child.pid });
  child.once("exit", (code, signal) => {
    children.delete(child);
    record("phase-exit", { label, code, signal });
  });
  child.once("error", (error) => record("process-error", { label, message: error.message }));
  return { child, logPath, stdout: () => stdout };
}

async function stop(processInfo) {
  if (
    !processInfo ||
    processInfo.child.exitCode !== null ||
    processInfo.child.signalCode !== null
  ) {
    return;
  }
  const child = processInfo.child;
  const exited = once(child, "exit");
  process.kill(-child.pid, "SIGTERM");
  const deadline = setTimeout(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") {
        throw error;
      }
    }
  }, 15_000);
  try {
    await exited;
  } finally {
    clearTimeout(deadline);
  }
}

async function command(label, executable, args, env, timeoutMs = 120_000) {
  const running = start(label, executable, args, env, true);
  const deadline = setTimeout(() => void stop(running), timeoutMs);
  try {
    const [code, signal] = await once(running.child, "exit");
    const output = fs.readFileSync(running.logPath, "utf8");
    assert.equal(code, 0, `${label} failed (${signal ?? code}): ${output.slice(-12_000)}`);
    return running.stdout();
  } finally {
    clearTimeout(deadline);
  }
}

/** @param {() => Error | undefined} [failure] */
async function waitFor(label, observe, timeoutMs = 120_000, failure = () => undefined) {
  const until = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < until) {
    const fatal = failure();
    if (fatal) {
      throw fatal;
    }
    try {
      const result = await observe();
      if (result) {
        return result;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
}

function readNodeUpdateFailure(logPath) {
  const log = fs.readFileSync(logPath, "utf8");
  const failure = log.match(
    /^(?:\w*Error:|node auto-update stopped:|\[openclaw\] Reason:|openclaw: (?:staged node runtime changed|updated node (?:did not reconnect|failed to reconnect)|could not record the updated node runtime)).*$/mu,
  );
  return failure
    ? new Error(`Node auto-update failed:\n${log.slice(failure.index).trim()}`)
    : undefined;
}

function jsonOutput(output) {
  const startIndex = output.search(/^[\x5b{]/m);
  assert(startIndex >= 0, `missing JSON output: ${output.slice(-2_000)}`);
  return JSON.parse(output.slice(startIndex));
}

function fileHash(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function processChildren(pid) {
  return fs
    .readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(Number);
}

async function listen(server) {
  servers.add(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

let selectedVersion;
let metadataReleased = false;
let metadataRequests = 0;
const registryRequests = [];
const servedMetadata = [];
let cliEntry;
let gatewayEnv;
let gatewayPort;
let proofPlugin;

async function cli(label, args, env = gatewayEnv, timeoutMs = 120_000) {
  return jsonOutput(
    await command(label, process.execPath, [cliEntry, ...args, "--json"], env, timeoutMs),
  );
}

async function nodes() {
  return (await cli(`nodes-${Date.now()}`, ["nodes", "status"])).nodes;
}

async function nodeRow(name) {
  return (await nodes()).find((row) => row.displayName === name && row.connected && row.paired);
}

async function invoke(nodeId, action = "ping") {
  return await cli(
    `workload-${action}-${Date.now()}`,
    [
      "nodes",
      "invoke",
      "--node",
      nodeId,
      "--command",
      proofPlugin.command,
      "--params",
      JSON.stringify({ action }),
      "--invoke-timeout",
      action === "hold" ? "900000" : "15000",
    ],
    gatewayEnv,
    action === "hold" ? 930_000 : 45_000,
  );
}

function writeConfig(name, value) {
  const home = path.join(root, name);
  const state = path.join(home, ".openclaw");
  fs.mkdirSync(state, { recursive: true });
  const config = path.join(state, "openclaw.json");
  fs.writeFileSync(config, `${JSON.stringify(value, null, 2)}\n`);
  return {
    ...cleanEnv,
    OPENCLAW_DEBUG: "1",
    HOME: home,
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: config,
  };
}

async function startNode(name, registryUrl, options = {}) {
  const plugin = options.plugin ?? proofPlugin;
  const env = options.sharedEnv
    ? { ...options.sharedEnv }
    : writeConfig(name, {
        nodeHost: {
          autoUpdate: { enabled: options.enabled !== false },
          browserProxy: { enabled: false },
          skills: { enabled: false },
        },
        plugins: plugin.plugins,
        tools: { exec: { mode: "full" } },
        update: { channel: "stable", checkOnStart: options.checkOnStart !== false },
      });
  delete env.OPENCLAW_NO_AUTO_UPDATE;
  Object.assign(env, { OPENCLAW_GATEWAY_TOKEN: token, NPM_CONFIG_REGISTRY: registryUrl });
  if (options.noAutoEnv) {
    env.OPENCLAW_NO_AUTO_UPDATE = "1";
  }
  const commands = [plugin.command, "system.which"].toSorted((left, right) =>
    left.localeCompare(right),
  );
  const args = [
    "node",
    "run",
    "--host",
    "127.0.0.1",
    "--port",
    String(gatewayPort),
    "--display-name",
    name,
    "--node-id",
    `${name}-instance`,
    "--commands",
    commands.join(","),
    "--no-tls",
    "--no-share-installed-apps",
  ];
  const running = start(name, process.execPath, [cliEntry, ...args], env);
  const row = await waitFor(`${name} paired with its approved command manifest`, async () => {
    assert.equal(
      running.child.exitCode,
      null,
      `${name} exited: ${fs.readFileSync(running.logPath, "utf8")}`,
    );
    const pending = await cli(`${name}-pending-${Date.now()}`, ["nodes", "pending"]);
    const request = pending.find((entry) => entry.displayName === name);
    if (request) {
      await cli(`${name}-approve`, ["nodes", "approve", request.requestId]);
    }
    const connected = await nodeRow(name);
    assert(connected, `${name} is not paired and connected yet`);
    assert.deepEqual(
      connected.commands.toSorted((left, right) => left.localeCompare(right)),
      commands,
    );
    return connected;
  });
  const identity = await cli(`${name}-identity`, ["node", "identity"], env);
  return { ...running, env, name, row, identity, commands, args };
}

async function startGateway(name, sharedNodeState = false) {
  const portProbe = http.createServer();
  gatewayPort = await listen(portProbe);
  await new Promise((resolve) => {
    portProbe.close(resolve);
  });
  gatewayEnv = writeConfig(name, {
    gateway: {
      mode: "local",
      port: gatewayPort,
      bind: "loopback",
      auth: { mode: "token", token },
      controlUi: { enabled: false },
      nodes: {
        pairing: { autoApproveCidrs: ["127.0.0.1/32"], sshVerify: false },
        commands: { allow: [proofPlugin.command] },
      },
    },
    agents: {
      defaults: {
        workspace: path.join(root, `${name}-workspace`),
        model: { primary: "openai/gpt-5.6-sol" },
      },
    },
    tools: { exec: { mode: "full" } },
    plugins: proofPlugin.plugins,
    browser: { enabled: false },
    nodeHost: {
      autoUpdate: { enabled: true },
      browserProxy: { enabled: false },
      skills: { enabled: false },
    },
    update: { channel: "stable", checkOnStart: sharedNodeState },
  });
  gatewayEnv.OPENCLAW_GATEWAY_TOKEN = token;
  gatewayEnv.OPENCLAW_NO_AUTO_UPDATE = "1";
  const gateway = start(
    name,
    process.execPath,
    [cliEntry, "gateway", "run", "--port", String(gatewayPort)],
    gatewayEnv,
  );
  await waitFor(
    `${name} health`,
    async () => (await fetch(`http://127.0.0.1:${gatewayPort}/healthz`)).ok,
  );
  return gateway;
}

try {
  record("proof-started", { root, sourceTarball: tarball, sourceSha256: fileHash(tarball) });
  proofPlugin = createNodeUpdateProofPlugin(root);
  const manifest = JSON.parse(
    execFileSync("tar", ["-xOf", tarball, "package/package.json"], { encoding: "utf8" }),
  );
  const [year, month] = manifest.version.split(".").map(Number);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const versions = [1, 2, 3].map((day) => `${nextYear}.${nextMonth}.${day}`);
  const variants = versions.map((version, index) => {
    const fixture = packNodeUpdateFixture({
      tarball,
      root,
      repository,
      env: cleanEnv,
      version,
      malformed: index === 2,
    });
    record("fixture-packed", fixture);
    return fixture.output;
  });
  selectedVersion = versions[0];
  const portFile = path.join(root, "registry.port");
  const registry = start(
    "registry",
    process.execPath,
    [
      path.join(repository, "scripts/e2e/lib/plugins/npm-registry-server.mjs"),
      portFile,
      ...versions.flatMap((version, index) => ["openclaw", version, variants[index]]),
    ],
    { ...cleanEnv, OPENCLAW_NPM_REGISTRY_UPSTREAM: upstream },
  );
  await waitFor("fixture registry", () => fs.existsSync(portFile));
  const registryUrl = `http://127.0.0.1:${fs.readFileSync(portFile, "utf8").trim()}`;
  const proxy = http.createServer((request, response) => {
    void (async () => {
      const isCoreMetadata = request.url === "/openclaw";
      registryRequests.push({ at: Date.now(), url: request.url });
      if (isCoreMetadata) {
        metadataRequests += 1;
        await waitFor("release metadata barrier", () => metadataReleased, 180_000);
      }
      const fetched = await fetch(`${registryUrl}${request.url}`, {
        headers: { host: request.headers.host },
        signal: AbortSignal.timeout(180_000),
      });
      if (isCoreMetadata) {
        const value = await fetched.json();
        value["dist-tags"] = { latest: selectedVersion };
        servedMetadata.push({ at: Date.now(), version: selectedVersion });
        response.writeHead(fetched.status, { "content-type": "application/json" });
        response.end(JSON.stringify(value));
      } else {
        response.writeHead(fetched.status, {
          "content-type": fetched.headers.get("content-type") ?? "application/octet-stream",
        });
        await pipeline(Readable.fromWeb(fetched.body), response);
      }
    })().catch((/** @type {unknown} */ error) => {
      const failure = error instanceof Error ? error : new Error(String(error));
      if (response.headersSent) {
        response.destroy(failure);
      } else {
        response.writeHead(500);
        response.end(failure.message);
      }
    });
  });
  const proxyUrl = `http://127.0.0.1:${await listen(proxy)}`;
  const installEnv = writeConfig("installer", {});
  const prefix = path.join(root, "global-prefix");
  await command(
    "install",
    "npm",
    ["install", "--global", "--prefix", prefix, tarball, "--no-audit", "--no-fund"],
    installEnv,
    900_000,
  );
  cliEntry = path.join(prefix, "lib/node_modules/openclaw/openclaw.mjs");
  const globalManifest = path.join(prefix, "lib/node_modules/openclaw/package.json");
  const globalHash = fileHash(globalManifest);
  const gateway = await startGateway("gateway");
  const positive = await startNode("node-positive", proxyUrl);
  const stockCommand = await cli(
    "node-stock-command-preflight",
    [
      "nodes",
      "invoke",
      "--node",
      positive.row.nodeId,
      "--command",
      "system.which",
      "--params",
      JSON.stringify({ bins: ["node"] }),
      "--invoke-timeout",
      "15000",
    ],
    gatewayEnv,
    45_000,
  );
  assert.equal(stockCommand.ok, true);
  assert.equal(typeof stockCommand.payload?.bins?.node, "string");
  assert(JSON.stringify(await invoke(positive.row.nodeId)).includes("NODE_UPDATE_PING_OK"));
  record("node-workload-preflight-passed", {
    stockCommand: "system.which",
    fixedChildExecuted: true,
  });
  const { busyPath, releasePath } = proofPlugin;
  /** @type {Error | undefined} */
  let workloadFailure;
  let workloadCompleted = false;
  const busy = invoke(positive.row.nodeId, "hold")
    .then((result) => {
      workloadCompleted = true;
      return result;
    })
    .catch((/** @type {unknown} */ error) => {
      workloadFailure = error instanceof Error ? error : new Error(String(error));
      record("workload-rejected", { message: workloadFailure.message });
    });
  const requireHolding = () =>
    workloadFailure ??
    (workloadCompleted ? new Error("Fixed workload completed before release") : undefined) ??
    readNodeUpdateFailure(positive.logPath);
  await waitFor(
    "real fixed node child workload",
    () => fs.existsSync(busyPath),
    120_000,
    requireHolding,
  );
  metadataReleased = true;
  record("busy-command-running", {
    nodeId: positive.row.nodeId,
    version: positive.row.version,
    pid: Number(fs.readFileSync(busyPath, "utf8")),
  });
  await waitFor(
    "prepared update defers while busy",
    () =>
      /ready; waiting for active work to finish/i.test(fs.readFileSync(positive.logPath, "utf8")),
    900_000,
    requireHolding,
  );
  assert.equal((await nodeRow(positive.name)).version, manifest.version);
  assert(!fs.existsSync(path.join(positive.env.OPENCLAW_STATE_DIR, "node-runtime/current")));
  record("busy-update-deferred", { metadataRequests, originalVersion: manifest.version });
  selectedVersion = versions[1];
  fs.writeFileSync(releasePath, "release\n");
  const completed = await busy;
  if (workloadFailure) {
    throw workloadFailure;
  }
  assert(JSON.stringify(completed).includes("NODE_UPDATE_HOLD_COMPLETED"));
  const updated = await waitFor(
    "automatic version activation",
    async () => {
      const row = await nodeRow(positive.name);
      return row?.version === versions[0] ? row : null;
    },
    180_000,
    () => readNodeUpdateFailure(positive.logPath),
  );
  assert.equal(updated.nodeId, positive.row.nodeId);
  assert.deepEqual(
    updated.commands.toSorted((left, right) => left.localeCompare(right)),
    positive.commands,
  );
  assert.deepEqual(
    await cli("identity-after-update", ["node", "identity"], positive.env),
    positive.identity,
  );
  const healthy = await invoke(updated.nodeId);
  assert(JSON.stringify(healthy).includes("NODE_UPDATE_PING_OK"));
  const { hostPid, hostArgv: updatedArguments } = healthy.payload;
  assert(Number.isSafeInteger(hostPid) && hostPid > 0);
  assert(Array.isArray(updatedArguments));
  assert(
    processChildren(positive.child.pid).includes(hostPid),
    "updated runtime is not owned by the original supervisor",
  );
  assert(
    updatedArguments.some(
      (arg) =>
        typeof arg === "string" && arg.includes(`${versions[0]}-`) && arg.endsWith("/openclaw.mjs"),
    ),
    "supervisor did not run the private package entrypoint",
  );
  for (const flag of ["--host", "--port", "--node-id", "--display-name", "--commands"]) {
    assert.equal(
      updatedArguments[updatedArguments.indexOf(flag) + 1],
      positive.args[positive.args.indexOf(flag) + 1],
      `restart changed ${flag}`,
    );
  }
  assert(updatedArguments.includes("--no-tls"));
  assert(updatedArguments.includes("--no-share-installed-apps"));
  record("automatic-update-reconnected", {
    before: manifest.version,
    after: updated.version,
    sameNodeId: true,
    sameIdentity: true,
    sameCommands: true,
    sameLaunchOptions: true,
    runtimePid: hostPid,
    sameSupervisor: true,
  });
  await waitFor("updated child discovers a second release", () =>
    servedMetadata.some((entry) => entry.version === versions[1]),
  );
  await delay(2_000);
  assert.equal((await nodeRow(positive.name)).version, versions[0]);
  const currentPath = path.join(positive.env.OPENCLAW_STATE_DIR, "node-runtime/current");
  assert(fs.readlinkSync(currentPath).includes(`${versions[0]}-`));
  assert(
    !fs
      .readdirSync(path.join(positive.env.OPENCLAW_STATE_DIR, "node-runtime/releases"))
      .some((entry) => entry.startsWith(`${versions[1]}-`)),
  );
  assert.equal(fileHash(globalManifest), globalHash);
  assert.equal(gateway.child.exitCode, null);
  assert((await fetch(`http://127.0.0.1:${gatewayPort}/healthz`)).ok);
  record("cooldown-and-global-isolation", {
    retainedVersion: versions[0],
    gatewayPid: gateway.child.pid,
    globalVersion: manifest.version,
  });
  await stop(positive);

  const legacyRoot = path.join(root, "legacy-plugin");
  fs.mkdirSync(legacyRoot);
  const legacyPlugin = createNodeUpdateProofPlugin(legacyRoot, { legacy: true });
  selectedVersion = versions[0];
  metadataReleased = false;
  const legacy = await startNode("node-legacy-plugin", proxyUrl, { plugin: legacyPlugin });
  const retained = await invoke(legacy.row.nodeId, "hold");
  assert.equal(retained.ok, true);
  assert.equal(retained.payload.marker, "NODE_UPDATE_HOLD_STARTED");
  const { pid: retainedPid, hostPid: legacyHostPid, hostArgv: legacyArguments } = retained.payload;
  assert(Number.isSafeInteger(retainedPid) && retainedPid > 0);
  assert(Number.isSafeInteger(legacyHostPid) && legacyHostPid > 0);
  const requireLegacyRuntime = () => {
    if (!fs.existsSync(`/proc/${legacyHostPid}`)) {
      return new Error("Legacy plugin runtime restarted without an idle declaration");
    }
    return readNodeUpdateFailure(legacy.logPath);
  };
  const requireLegacyHolding = () =>
    requireLegacyRuntime() ??
    (!fs.existsSync(`/proc/${retainedPid}`)
      ? new Error("Legacy plugin child exited before release")
      : undefined);
  await waitFor(
    "legacy command returns with a retained child",
    () =>
      fs.existsSync(legacyPlugin.busyPath) &&
      Number(fs.readFileSync(legacyPlugin.busyPath, "utf8")) === retainedPid,
    120_000,
    requireLegacyHolding,
  );
  assert(processChildren(legacy.child.pid).includes(legacyHostPid));
  assert(processChildren(legacyHostPid).includes(retainedPid));
  metadataReleased = true;
  await waitFor(
    "legacy plugin defers the prepared update after its command returns",
    () => /ready; waiting for active work to finish/i.test(fs.readFileSync(legacy.logPath, "utf8")),
    900_000,
    requireLegacyHolding,
  );
  const assertLegacyRetained = async () => {
    assert.equal(legacy.child.exitCode, null);
    assert.equal(legacy.child.signalCode, null);
    assert(processChildren(legacy.child.pid).includes(legacyHostPid));
    const row = await nodeRow(legacy.name);
    assert.equal(row.nodeId, legacy.row.nodeId);
    assert.equal(row.version, manifest.version);
    const ping = await invoke(legacy.row.nodeId);
    assert.equal(ping.payload.marker, "NODE_UPDATE_PING_OK");
    assert.equal(ping.payload.hostPid, legacyHostPid);
    assert.deepEqual(ping.payload.hostArgv, legacyArguments);
    assert(!fs.existsSync(path.join(legacy.env.OPENCLAW_STATE_DIR, "node-runtime/current")));
  };
  await assertLegacyRetained();
  assert(processChildren(legacyHostPid).includes(retainedPid));
  assert.deepEqual(
    await cli("legacy-identity-after-deferral", ["node", "identity"], legacy.env),
    legacy.identity,
  );
  record("legacy-plugin-retained-work-deferred", {
    nodeId: legacy.row.nodeId,
    retainedChildPid: retainedPid,
    runtimePid: legacyHostPid,
    supervisorPid: legacy.child.pid,
    connectedVersion: manifest.version,
    sameIdentity: true,
    commandReturned: true,
  });
  fs.writeFileSync(legacyPlugin.releasePath, "release\n");
  await waitFor(
    "legacy retained child completes and is reaped",
    () =>
      !fs.existsSync(`/proc/${retainedPid}`) &&
      fs.readFileSync(legacy.logPath, "utf8").includes("child-exit action=hold code=0 signal=null"),
    120_000,
    requireLegacyRuntime,
  );
  // Cross the next idle retry with no command or child work left to mask the missing hook.
  await delay(35_000);
  await assertLegacyRetained();
  record("legacy-plugin-missing-idle-hook-stays-deferred", {
    connectedVersion: manifest.version,
    runtimePid: legacyHostPid,
    childReaped: true,
  });
  await stop(legacy);
  assert(!fs.existsSync(`/proc/${legacyHostPid}`));
  assert(!fs.existsSync(`/proc/${retainedPid}`));

  for (const { name, options } of [
    { name: "node-optout", options: { enabled: false } },
    { name: "node-startup-optout", options: { checkOnStart: false } },
    { name: "node-env-optout", options: { noAutoEnv: true } },
  ]) {
    const requestsBefore = metadataRequests;
    const optedOut = await startNode(name, proxyUrl, options);
    assert(JSON.stringify(await invoke(optedOut.row.nodeId)).includes("NODE_UPDATE_PING_OK"));
    await delay(2_000);
    assert.equal(metadataRequests, requestsBefore, `${name} queried release metadata`);
    assert.equal((await nodeRow(name)).version, manifest.version);
    record("optout-respected", { name, registryRequests: 0, connectedVersion: manifest.version });
    await stop(optedOut);
  }

  selectedVersion = versions[2];
  const negative = await startNode("node-malformed-candidate", proxyUrl);
  await waitFor(
    "malformed candidate rejection",
    () =>
      /missing.*node-host-launcher|ENOENT.*node-host-launcher/i.test(
        fs.readFileSync(negative.logPath, "utf8"),
      ),
    900_000,
  );
  assert.equal((await nodeRow(negative.name)).version, manifest.version);
  assert(JSON.stringify(await invoke(negative.row.nodeId)).includes("NODE_UPDATE_PING_OK"));
  assert(!fs.existsSync(path.join(negative.env.OPENCLAW_STATE_DIR, "node-runtime/current")));
  assert.equal(fileHash(globalManifest), globalHash);
  record("malformed-candidate-kept-old-node", {
    connectedVersion: manifest.version,
    commandSucceeded: true,
  });
  await stop(negative);

  const primaryGateway = { env: gatewayEnv, port: gatewayPort };
  selectedVersion = versions[0];
  metadataReleased = false;
  const sharedGateway = await startGateway("gateway-shared-state", true);
  const sharedNode = await startNode("node-shared-state", proxyUrl, { sharedEnv: gatewayEnv });
  assert.equal(sharedNode.row.gatewayLocal, true);
  assert.equal(sharedNode.row.version, manifest.version);
  const sharedGatewayBefore = await cli("shared-gateway-info-before", [
    "gateway",
    "call",
    "system.info",
  ]);
  const sharedPresenceBefore = await cli("shared-presence-before", [
    "gateway",
    "call",
    "system-presence",
  ]);
  const sharedGatewayVersion = sharedPresenceBefore.find(
    (entry) => entry.mode === "gateway" && entry.reason === "self",
  )?.version;
  assert.equal(sharedGatewayVersion, manifest.version);
  const sharedConfigHash = fileHash(gatewayEnv.OPENCLAW_CONFIG_PATH);
  assert(JSON.stringify(await invoke(sharedNode.row.nodeId)).includes("NODE_UPDATE_PING_OK"));
  metadataReleased = true;
  const sharedUpdated = await waitFor(
    "shared-state node activates independently",
    async () => {
      const row = await nodeRow(sharedNode.name);
      return row?.version === versions[0] ? row : null;
    },
    900_000,
    () => readNodeUpdateFailure(sharedNode.logPath),
  );
  assert.equal(sharedUpdated.nodeId, sharedNode.row.nodeId);
  assert.equal(sharedUpdated.gatewayLocal, true);
  assert.deepEqual(
    await cli("shared-identity-after", ["node", "identity"], sharedNode.env),
    sharedNode.identity,
  );
  assert(JSON.stringify(await invoke(sharedUpdated.nodeId)).includes("NODE_UPDATE_PING_OK"));
  const sharedGatewayAfter = await cli("shared-gateway-info-after", [
    "gateway",
    "call",
    "system.info",
  ]);
  const sharedPresenceAfter = await cli("shared-presence-after", [
    "gateway",
    "call",
    "system-presence",
  ]);
  assert.equal(sharedGatewayAfter.pid, sharedGatewayBefore.pid);
  assert.equal(sharedGatewayAfter.processInstanceId, sharedGatewayBefore.processInstanceId);
  assert.equal(
    sharedPresenceAfter.find((entry) => entry.mode === "gateway" && entry.reason === "self")
      ?.version,
    manifest.version,
  );
  assert.equal(sharedGateway.child.exitCode, null);
  assert.equal(fileHash(gatewayEnv.OPENCLAW_CONFIG_PATH), sharedConfigHash);
  assert.equal(fileHash(globalManifest), globalHash);
  record("shared-state-node-updated-independently", {
    gatewayVersion: manifest.version,
    gatewayPid: sharedGatewayAfter.pid,
    nodeVersion: sharedUpdated.version,
    sameNodeId: true,
    gatewayLocal: true,
    sameGatewayProcess: true,
    sharedConfigUnchanged: true,
  });
  await stop(sharedNode);
  await stop(sharedGateway);
  gatewayEnv = primaryGateway.env;
  gatewayPort = primaryGateway.port;

  const publishedVersion = "2026.9.4";
  const publishedPrefix = path.join(root, "published-driver-prefix");
  const publishedPackage = path.join(publishedPrefix, "lib/node_modules/openclaw");
  const publishedPortProbe = http.createServer();
  const publishedGatewayPort = await listen(publishedPortProbe);
  await new Promise((resolve) => {
    publishedPortProbe.close(resolve);
  });
  const publishedEnv = writeConfig("published-driver", {
    gateway: { mode: "local", port: publishedGatewayPort, auth: { mode: "token", token } },
    agents: { defaults: { model: { primary: "openai/gpt-5.6-sol" } } },
    plugins: { enabled: false },
    update: { checkOnStart: false },
  });
  Object.assign(publishedEnv, {
    NPM_CONFIG_REGISTRY: "https://registry.npmjs.org",
    NPM_CONFIG_PREFIX: publishedPrefix,
    PATH: `${publishedPrefix}/bin:${cleanEnv.PATH}`,
    OPENCLAW_ALLOW_ROOT: "1",
  });
  const publishedIdentity = jsonOutput(
    await command(
      "published-driver-registry-identity",
      "npm",
      ["view", `openclaw@${publishedVersion}`, "version", "dist", "--json"],
      publishedEnv,
    ),
  );
  assert.equal(publishedIdentity.version, publishedVersion);
  assert(publishedIdentity.dist.integrity);
  await command(
    "published-driver-install",
    "npm",
    [
      "install",
      "--global",
      "--prefix",
      publishedPrefix,
      `openclaw@${publishedVersion}`,
      "--no-audit",
      "--no-fund",
    ],
    publishedEnv,
    900_000,
  );
  const publishedEntry = path.join(publishedPackage, "openclaw.mjs");
  assert(
    (
      await command(
        "published-driver-version-before",
        process.execPath,
        [publishedEntry, "--version"],
        publishedEnv,
      )
    ).includes(publishedVersion),
  );
  publishedEnv.NPM_CONFIG_REGISTRY = proxyUrl;
  selectedVersion = versions[0];
  const updatedByPublishedDriver = jsonOutput(
    await command(
      "published-driver-update",
      process.execPath,
      [publishedEntry, "update", "--tag", versions[0], "--yes", "--json", "--no-restart"],
      publishedEnv,
      900_000,
    ),
  );
  assert.equal(updatedByPublishedDriver.status, "ok");
  assert.equal(updatedByPublishedDriver.root, publishedPackage);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(publishedPackage, "package.json"), "utf8")).version,
    versions[0],
  );
  assert.equal(
    fileHash(path.join(publishedPackage, "node-host-launcher.mjs")),
    fileHash(path.join(root, `variant-${versions[0]}`, "package/node-host-launcher.mjs")),
  );
  assert(
    (
      await command(
        "published-driver-version-after",
        process.execPath,
        [publishedEntry, "--version"],
        publishedEnv,
      )
    ).includes(versions[0]),
  );
  assert.equal(fileHash(globalManifest), globalHash);
  assert.equal(gateway.child.exitCode, null);
  record("published-driver-installed-candidate", {
    before: publishedVersion,
    after: versions[0],
    publishedTarball: publishedIdentity.dist.tarball,
    publishedIntegrity: publishedIdentity.dist.integrity,
    launcherVerified: true,
    isolatedPrefix: publishedPrefix,
  });
  await stop(gateway);
  await stop(registry);
  record("proof-passed", {
    checks: [
      "busy-deferral",
      "legacy-plugin-retained-work-deferral",
      "legacy-plugin-missing-idle-hook-deferral",
      "idle-activation",
      "pairing-preserved",
      "launch-surface-preserved",
      "12-hour-cooldown",
      "three-optouts",
      "malformed-candidate",
      "global-and-gateway-isolation",
      "same-state-gateway-and-node",
      "published-driver-to-candidate",
    ],
  });
} catch (error) {
  record("proof-failed", { message: error.message, stack: error.stack });
  process.exitCode = 1;
} finally {
  metadataReleased = true;
  for (const child of children) {
    await stop({ child });
  }
  for (const server of servers) {
    server.closeAllConnections();
    if (server.listening) {
      await new Promise((resolve) => {
        server.close(resolve);
      });
    }
  }
  fs.writeFileSync(
    path.join(root, "registry-requests.json"),
    `${JSON.stringify({ requests: registryRequests, metadata: servedMetadata }, null, 2)}\n`,
  );
  record("cleanup-complete", { remainingChildren: children.size, artifacts: root });
}
