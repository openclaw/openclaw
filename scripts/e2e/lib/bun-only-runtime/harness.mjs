// Linux Bun-only package smoke. Artifacts deliberately survive failed runs.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertAgentReplyContainsMarker,
  assertOpenAiRequestLogUsed,
} from "../agent-turn-output.mjs";
import { applyMockOpenAiModelConfig } from "../fixtures/mock-openai-config.mjs";
import { attributeSpawns, classifyNodeSpawns, renderMarkdownReport } from "./node-spawn-ledger.mjs";
import { nodeLaunchers, writeNodeSentinels, readSentinelLedger } from "./sentinel.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../../..");
const artifactDir = process.env.OPENCLAW_BUN_ONLY_SMOKE_ARTIFACT_DIR;
const bun = process.execPath;
const tarball = process.env.OPENCLAW_BUN_ONLY_SMOKE_PACKAGE_TGZ;
const sentinelBin = path.join(artifactDir, "sentinel-bin");
const installSentinelBin = path.join(artifactDir, "install-sentinel-bin");
const ledger = path.join(artifactDir, "sentinel-ledger.jsonl");
const trace = path.join(artifactDir, "spawn-trace.jsonl");
const basePath = `${path.dirname(bun)}:/usr/sbin:/usr/bin:/sbin:/bin`;
const token = "bun-only-smoke-token";
const marker = "OPENCLAW_BUN_ONLY_RUNTIME_OK";
const blockers = JSON.parse(
  fs.readFileSync(path.join(here, "expected-node-blockers.json"), "utf8"),
).blockers;
const steps = [];
const processes = [];
let activeStep;
let entry;
/** @type {string | undefined} */
let bunVersion;
/** @type {string | undefined} */
let bunRevision;
/** @type {string | undefined} */
let fatalError;
const runtimeDeadline = Date.now() + 7 * 60_000;
let stopped = false;
fs.mkdirSync(artifactDir, { recursive: true });
fs.writeFileSync(trace, "");
writeNodeSentinels(
  installSentinelBin,
  ledger,
  nodeLaunchers.filter((name) => name !== "node"),
);

const env = {
  HOME: path.join(artifactDir, "home"),
  TMPDIR: process.env.TMPDIR ?? "/tmp",
  LANG: process.env.LANG ?? "C.UTF-8",
  PATH: `${sentinelBin}:${basePath}`,
  OPENCLAW_STATE_DIR: path.join(artifactDir, "state"),
  OPENCLAW_CONFIG_PATH: path.join(artifactDir, "state/openclaw.json"),
  OPENCLAW_GATEWAY_TOKEN: token,
  OPENAI_API_KEY: "bun-only-fake-key",
  OPENCLAW_NO_ONBOARD: "1",
  OPENCLAW_DISABLE_UPDATE_CHECK: "1",
  OPENCLAW_DISABLE_BONJOUR: "1",
  OPENCLAW_SKIP_CHANNELS: "1",
  NO_COLOR: "1",
  CI: "1",
  BUN_OPTIONS: `--preload=${path.join(here, "spawn-trace-preload.mjs")}`,
  OPENCLAW_BUN_ONLY_SPAWN_TRACE: trace,
};
fs.mkdirSync(env.HOME, { recursive: true });
fs.mkdirSync(env.OPENCLAW_STATE_DIR, { recursive: true });

function read(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
}
function ledgerCount() {
  return read(ledger).split("\n").filter(Boolean).length;
}
function signalGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") {
      throw error;
    }
  }
}
function remaining() {
  const value = activeStep.deadline - Date.now();
  if (value <= 0 || stopped) {
    throw new Error(`${activeStep.name} timed out or interrupted`);
  }
  return value;
}
function start(label, args, childEnv = env) {
  const stdoutPath = path.join(artifactDir, `${label}.stdout.log`);
  const stderrPath = path.join(artifactDir, `${label}.stderr.log`);
  const out = fs.openSync(stdoutPath, "w");
  const err = fs.openSync(stderrPath, "w");
  let child;
  try {
    child = spawn(bun, args, {
      env: childEnv,
      cwd: env.HOME,
      detached: true,
      stdio: ["ignore", out, err],
    });
  } finally {
    fs.closeSync(out);
    fs.closeSync(err);
  }
  const done = new Promise((resolve) => {
    child.once("error", (error) => resolve({ exitCode: 1, error: String(error) }));
    child.once("exit", (code, signal) => resolve({ exitCode: code ?? 1, signal }));
  });
  const running = { child, done, stdoutPath, stderrPath, label };
  processes.push(running);
  activeStep.logs.push({ stdoutPath, stderrPath });
  return running;
}
async function run(label, args, childEnv = env) {
  const running = start(label, args, childEnv);
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    signalGroup(running.child, "SIGKILL");
  }, remaining());
  let result;
  try {
    result = await running.done;
  } finally {
    clearTimeout(timeout);
  }
  const output = read(running.stdoutPath) + read(running.stderrPath);
  activeStep.commands.push({ label, args, ...result, timedOut });
  // A hang is never an expected blocker outcome, even after printing the blocker's text.
  if (timedOut) {
    throw new Error(`${label} timed out in step ${activeStep.name}`);
  }
  return { ...result, output, ...running };
}
async function cli(label, args, options = {}) {
  const result = await run(label, [entry, ...args], options.env ?? env);
  if (!options.allowFailure && result.exitCode !== 0) {
    throw new Error(`${label} exited ${result.exitCode}: ${result.output.slice(-6000)}`);
  }
  return result;
}
async function step(name, timeoutMs, action) {
  const item = {
    name,
    timeoutMs,
    startMs: Date.now(),
    sentinelStart: ledgerCount(),
    status: "running",
    logs: [],
    commands: [],
  };
  item.deadline =
    name === "cleanup"
      ? item.startMs + timeoutMs
      : Math.min(item.startMs + timeoutMs, runtimeDeadline);
  activeStep = item;
  steps.push(item);
  console.log(`==> ${name}`);
  try {
    await action();
    item.status = "passed";
  } catch (error) {
    item.status = "failed";
    item.error = String(error);
    throw error;
  } finally {
    item.endMs = Date.now();
    item.durationMs = item.endMs - item.startMs;
    item.sentinelEnd = ledgerCount();
    item.stdout = item.logs.map((log) => read(log.stdoutPath)).join("\n");
    item.stderr = item.logs.map((log) => read(log.stderrPath)).join("\n");
    fs.writeFileSync(path.join(artifactDir, `${name}.stdout.log`), item.stdout);
    fs.writeFileSync(path.join(artifactDir, `${name}.stderr.log`), item.stderr);
    console.log(`    ${item.status} (${item.durationMs} ms)`);
  }
}
async function waitUntil(label, probe, running) {
  while (remaining() > 0) {
    if (running?.child.exitCode !== null && running?.child.exitCode !== undefined) {
      throw new Error(`${label}: process exited: ${read(running.stderrPath).slice(-6000)}`);
    }
    if (await probe()) {
      return;
    }
    await Bun.sleep(Math.min(300, remaining()));
  }
}
async function ready(port) {
  try {
    return (await fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(1000) }))
      .ok;
  } catch {
    return false;
  }
}
function freePort() {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return port;
}
function assertNoNode() {
  const sentinelContent = fs.readFileSync(path.join(sentinelBin, "node"));
  const isSentinel = (candidate) => fs.readFileSync(candidate).equals(sentinelContent);
  for (const dir of basePath.split(":")) {
    for (const name of ["node", "nodejs"]) {
      const candidate = path.join(dir, name);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
      } catch {
        continue;
      }
      assert(isSentinel(candidate), `Real Node remains reachable: ${candidate}`);
    }
  }
  for (const candidate of ["/usr/local/bin/node", "/usr/bin/node"]) {
    assert(
      !fs.existsSync(candidate) || isSentinel(candidate),
      `Real absolute Node fallback remains: ${candidate}`,
    );
  }
}
function installPath() {
  // A masked /usr/bin/node must not prevent Bun from injecting its lifecycle shim.
  const directories = basePath.split(":").map((dir, index) => {
    if (!fs.existsSync(path.join(dir, "node"))) {
      return dir;
    }
    const filtered = path.join(artifactDir, `install-path-${index}`);
    fs.mkdirSync(filtered);
    for (const name of fs.readdirSync(dir)) {
      if (name !== "node") {
        fs.symlinkSync(path.join(dir, name), path.join(filtered, name));
      }
    }
    return filtered;
  });
  return directories.join(":");
}
function prepareInstall(name) {
  const install = path.join(artifactDir, name);
  fs.mkdirSync(path.join(install, "install/global"), { recursive: true });
  const ai = process.env.OPENCLAW_BUN_ONLY_SMOKE_AI_PACKAGE_TGZ;
  fs.writeFileSync(
    path.join(install, "install/global/package.json"),
    JSON.stringify({
      private: true,
      ...(ai ? { overrides: { "@openclaw/ai": `file:${ai}` } } : {}),
    }),
  );
  return install;
}
/**
 * A listed blocker must fail with its recorded text; success is left to the classifier,
 * which reports the entry as stale. Once the entry is deleted, the feature must succeed.
 */
function expectListedOutcome(result, blockerId) {
  activeStep.exitCode = result.exitCode;
  const blocker = blockers.find((item) => item.id === blockerId);
  if (!blocker) {
    assert.equal(result.exitCode, 0, result.output.slice(-6000));
    return;
  }
  if (result.exitCode !== 0) {
    assert(result.output.includes(blocker.failure), result.output.slice(-6000));
  }
}
function parseJsonOutput(output) {
  const jsonStart = output.search(/^[[{]/m);
  return JSON.parse(output.slice(jsonStart));
}
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    stopped = true;
    for (const running of processes.toReversed()) {
      signalGroup(running.child, "SIGKILL");
    }
  });
}

try {
  await step("preconditions", 10000, async () => {
    assert.equal(process.platform, "linux", "This smoke requires Linux");
    assert.equal(process.arch, "x64", "This smoke requires Linux x64");
    bunVersion = (await run("bun-version", ["--version"])).output.trim();
    bunRevision = (await run("bun-revision", ["--revision"])).output.trim();
    assertNoNode();
  });
  await step("install", 150000, async () => {
    const installBasePath = installPath();
    const install = prepareInstall("bun-install-pure");
    const result = await run(
      "install-pure",
      ["install", "-g", "--trust", tarball, "--no-progress"],
      {
        ...env,
        PATH: `${installSentinelBin}:${installBasePath}`,
        BUN_INSTALL: install,
        OPENCLAW_PACKAGE_BUN_LAUNCHER: bun,
      },
    );
    assert.equal(result.exitCode, 0, result.output.slice(-6000));
    entry = fs.realpathSync(path.join(install, "bin/openclaw"));
    env.BUN_INSTALL = install;
    assert(
      !fs.existsSync(path.join(path.dirname(entry), ".openclaw-lifecycle-pending")),
      "Package lifecycle is incomplete",
    );
    assertNoNode();
  });
  const gatewayPort = freePort();
  const mockPort = freePort();
  const cdpPort = freePort();
  await step("cli", 60000, async () => {
    const version = await cli("cli-version", ["--version"]);
    const manifest = JSON.parse(read(path.join(path.dirname(entry), "package.json")));
    assert(version.output.includes(manifest.version), `Version mismatch: ${version.output}`);
    await cli("cli-help", ["--help"]);
    await cli("cli-status", ["status", "--json"]);
    await cli("cli-plugins", ["plugins", "list", "--json"]);
  });
  await step("gateway", 75000, async () => {
    const config = {
      gateway: {
        mode: "local",
        bind: "loopback",
        port: gatewayPort,
        auth: { mode: "token", token },
        terminal: { enabled: true },
        controlUi: { enabled: false },
        nodes: { pairing: { autoApproveCidrs: ["127.0.0.1/32"] } },
      },
      agents: { defaults: { workspace: path.join(artifactDir, "workspace") } },
      tools: { toolSearch: true },
      browser: {
        enabled: true,
        headless: true,
        noSandbox: true,
        executablePath: "/usr/bin/google-chrome",
        defaultProfile: "bun-cdp",
        profiles: { "bun-cdp": { cdpUrl: `http://127.0.0.1:${cdpPort}` } },
      },
      update: { checkOnStart: false },
    };
    applyMockOpenAiModelConfig(config, { mockPort });
    fs.writeFileSync(env.OPENCLAW_CONFIG_PATH, JSON.stringify(config, null, 2));
    const gateway = start("gateway-process", [
      entry,
      "gateway",
      "run",
      "--port",
      String(gatewayPort),
      "--bind",
      "loopback",
    ]);
    await waitUntil("Gateway ready", () => ready(gatewayPort), gateway);
    await cli("gateway-health", ["gateway", "health", "--json"]);
    await cli("gateway-status", [
      "gateway",
      "call",
      "status",
      "--params",
      '{"includeChannelSummary":false}',
      "--json",
    ]);
  });
  await step("node-host", 90000, async () => {
    const home = path.join(artifactDir, "node-home");
    const state = path.join(home, ".openclaw");
    fs.mkdirSync(state, { recursive: true });
    const nodeEnv = {
      ...env,
      HOME: home,
      OPENCLAW_STATE_DIR: state,
      OPENCLAW_CONFIG_PATH: path.join(state, "openclaw.json"),
    };
    fs.writeFileSync(
      nodeEnv.OPENCLAW_CONFIG_PATH,
      JSON.stringify({
        nodeHost: { browserProxy: { enabled: false }, skills: { enabled: false } },
      }),
    );
    const host = start(
      "node-host-process",
      [
        entry,
        "node",
        "run",
        "--host",
        "127.0.0.1",
        "--port",
        String(gatewayPort),
        "--display-name",
        "bun-only-node",
        "--node-id",
        "bun-only-node",
        "--no-tls",
      ],
      nodeEnv,
    );
    let count = 0;
    await waitUntil(
      "Node paired and connected",
      async () => {
        count++;
        const pending = parseJsonOutput(
          (await cli(`node-pending-${count}`, ["nodes", "pending", "--json"])).output,
        );
        const request = pending.find((item) => item.displayName === "bun-only-node");
        if (request) {
          await cli(`node-approve-${count}`, ["nodes", "approve", request.requestId, "--json"]);
        }
        const result = parseJsonOutput(
          (await cli(`node-status-${count}`, ["nodes", "status", "--json"])).output,
        );
        return result.nodes.some(
          (item) => item.displayName === "bun-only-node" && item.connected && item.paired,
        );
      },
      host,
    );
  });
  await step("agent", 60000, async () => {
    const requestLog = path.join(artifactDir, "mock-requests.jsonl");
    const mock = start("mock-openai", [path.join(root, "scripts/e2e/mock-openai-server.mjs")], {
      ...env,
      MOCK_PORT: String(mockPort),
      SUCCESS_MARKER: marker,
      MOCK_REQUEST_LOG: requestLog,
    });
    await waitUntil(
      "Mock OpenAI listening",
      () => read(mock.stdoutPath).includes("listening"),
      mock,
    );
    const turn = await cli("agent-turn", [
      "agent",
      "--agent",
      "main",
      "--session-id",
      "bun-only-agent",
      "--message",
      `Return marker ${marker}`,
      "--thinking",
      "off",
      "--json",
    ]);
    assertAgentReplyContainsMarker(marker, turn.stdoutPath);
    assertOpenAiRequestLogUsed(requestLog);
  });
  await step("doctor", 45000, async () => {
    const result = await cli("doctor-run", ["doctor", "--non-interactive"], { allowFailure: true });
    activeStep.exitCode = result.exitCode;
    assert.equal(result.exitCode, 0, result.output.slice(-6000));
  });
  await step("terminals", 20000, async () => {
    const result = await cli(
      "terminal-open",
      ["gateway", "call", "terminal.open", "--params", '{"cols":80,"rows":24}', "--json"],
      { allowFailure: true },
    );
    expectListedOutcome(result, "terminal-pty");
  });
  await step("browser", 45000, async () => {
    await cli("browser-open", ["browser", "open", "about:blank"]);
    await cli("browser-snapshot", ["browser", "snapshot"]);
    const result = await cli("browser-user", ["browser", "--browser-profile", "user", "status"], {
      allowFailure: true,
    });
    expectListedOutcome(result, "chrome-mcp-user-profile");
    await cli("browser-stop", ["browser", "stop"]);
  });
} catch (error) {
  fatalError = String(error);
  console.error(fatalError);
} finally {
  await step("cleanup", 10000, async () => {
    for (const running of processes.toReversed()) {
      signalGroup(running.child, "SIGTERM");
    }
    await Bun.sleep(300);
    for (const running of processes.toReversed()) {
      signalGroup(running.child, "SIGKILL");
    }
    await Promise.all(processes.map((running) => running.done));
  }).catch((/** @type {unknown} */ error) => {
    fatalError ??= String(error);
  });
  const traceRecords = read(trace)
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const attempts = attributeSpawns({
    sentinelRecords: readSentinelLedger(ledger),
    traceRecords,
    steps,
  });
  const result = {
    ...classifyNodeSpawns({ attempts, steps, blockers }),
    artifactDir,
    bun,
    bunVersion,
    bunRevision,
    entry,
    fatalError,
    attempts,
  };
  result.ok &&= !fatalError;
  const markdown = renderMarkdownReport(result) + (fatalError ? `\nFailure: ${fatalError}\n` : "");
  fs.writeFileSync(path.join(artifactDir, "report.json"), JSON.stringify(result, null, 2) + "\n");
  fs.writeFileSync(path.join(artifactDir, "report.md"), markdown);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  }
  console.log(`Report: ${path.join(artifactDir, "report.md")}`);
  process.exitCode = result.ok ? 0 : 1;
}
