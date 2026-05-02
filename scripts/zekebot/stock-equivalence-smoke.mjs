#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { cp, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";

const REQUIRED_STOCK_TOOLS = [
  "session_status",
  "sessions_list",
  "sessions_history",
  "sessions_spawn",
  "web_search",
];

const REQUIRED_SPROUT_NATIVE_TOOLS = [
  "ask_zeke_context",
  "search_zeke_context",
  "explain_zeke_context_route",
  "read_zeke_source",
  "read_repo_file",
  "grep_repo",
  "glob_repo",
  "propose_signal",
];

const DENIED_STOCK_TOOLS = [
  "sessions_send",
  "memory",
  "web_fetch",
  "browser",
  "x_search",
  "tavily_search",
  "tavily_extract",
  "group:web",
  "group:fs",
  "canvas",
  "read",
  "grep",
  "glob",
  "write",
  "edit",
  "apply_patch",
  "exec",
  "process",
  "package-install",
  "docker",
];

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\b(?:sk|tvly|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_./-]{8,}/i,
  /\b(?:bearer|token|secret|api[_-]?key|password|credential)\s*:\s*[A-Za-z0-9_./:-]{8,}/i,
];

const args = parseArgs(process.argv.slice(2));
const configDir = path.resolve(args.config ?? "test/fixtures/zeke/sprout-openclaw");
const nativeContractPath = path.resolve(
  args.nativeContract ?? "test/fixtures/zeke/native-tool-contract.json",
);
const runtimeCatalogPath = args.runtimeCatalog ? path.resolve(args.runtimeCatalog) : "";
const image = args.image ?? "";
const contractOnly = args.contractOnly === true;

if (!existsSync(path.join(configDir, "openclaw.json"))) {
  throw new Error(`missing openclaw.json in ${configDir}`);
}
if (!existsSync(nativeContractPath)) {
  throw new Error(`missing native contract ${nativeContractPath}`);
}

await scanPathForSecrets(configDir);
await scanPathForSecrets(nativeContractPath);
const config = readJson(path.join(configDir, "openclaw.json"));
const nativeContract = readJson(nativeContractPath);

assertSproutConfig(config);
assertNativeContract(nativeContract, runtimeCatalogPath);
await assertHookHandlers(configDir);

if (!contractOnly) {
  if (!image) {
    throw new Error("--image is required unless --contract-only is set");
  }
  assert.match(
    image,
    /^ghcr\.io\/openzeke\/zekebot(?::zb-[0-9]{4}\.[1-9][0-9]?\.[0-9]{2}-[0-9a-f]{12}|@sha256:[0-9a-f]{64})$/,
  );
  await runContainerSmoke(image, configDir);
}

console.log(
  JSON.stringify({
    ok: true,
    image: image || null,
    contractOnly,
    nativeContractMode: nativeContract.mode,
    requiredStockTools: REQUIRED_STOCK_TOOLS,
  }),
);

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--contract-only") {
      parsed.contractOnly = true;
      continue;
    }
    if (arg === "--image") {
      parsed.image = argv[++index];
      continue;
    }
    if (arg === "--config") {
      parsed.config = argv[++index];
      continue;
    }
    if (arg === "--native-contract") {
      parsed.nativeContract = argv[++index];
      continue;
    }
    if (arg === "--runtime-catalog") {
      parsed.runtimeCatalog = argv[++index];
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return parsed;
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

async function scanPathForSecrets(target) {
  const info = await stat(target);
  const files = info.isDirectory() ? await listFiles(target) : [target];
  for (const file of files) {
    const body = await readFile(file, "utf8");
    for (const pattern of SECRET_PATTERNS) {
      assert.equal(pattern.test(body), false, `fixture contains secret-shaped material: ${file}`);
    }
    assertNoJsonSecretAssignments(body, file);
  }
}

function assertNoJsonSecretAssignments(body, file) {
  const secretAssignment =
    /"([^"]*(?:token|secret|api[_-]?key|password|credential)[^"]*)"\s*:\s*"([^"]*)"/gi;
  for (const match of body.matchAll(secretAssignment)) {
    const value = match[2] ?? "";
    const key = match[1] ?? "";
    if (
      !value ||
      key === "tokenEnv" ||
      value === "not-needed" ||
      value.startsWith("${") ||
      value.startsWith("fixture-")
    ) {
      continue;
    }
    if (value.length >= 8) {
      throw new Error(`fixture contains JSON secret-shaped assignment for ${match[1]} in ${file}`);
    }
  }
}

async function listFiles(root) {
  const result = [];
  for (const name of await readdir(root)) {
    const full = path.join(root, name);
    const info = await stat(full);
    if (info.isDirectory()) {
      result.push(...(await listFiles(full)));
    } else if (info.isFile()) {
      result.push(full);
    }
  }
  return result;
}

function assertSproutConfig(cfg) {
  const agents = cfg?.agents?.list;
  assert.ok(Array.isArray(agents), "agents.list must be present");
  const sprout = agents.find((agent) => agent.id === "sprout");
  const investigator = agents.find((agent) => agent.id === "sprout-investigator");
  assert.ok(sprout, "sprout agent must be present");
  assert.ok(investigator, "sprout-investigator agent must be present");

  const allow = new Set(sprout.tools?.allow ?? []);
  const deny = new Set(sprout.tools?.deny ?? []);
  for (const tool of REQUIRED_STOCK_TOOLS) {
    assert.ok(allow.has(tool), `sprout stock tool must be allowed: ${tool}`);
  }
  for (const tool of REQUIRED_SPROUT_NATIVE_TOOLS) {
    assert.ok(allow.has(tool), `sprout native Zeke tool must be allowed: ${tool}`);
  }
  for (const tool of DENIED_STOCK_TOOLS) {
    assert.ok(deny.has(tool), `sprout denied tool must remain denied: ${tool}`);
  }
  assert.equal(allow.has("create_signal"), false, "create_signal must not be model-facing");
  assert.equal(cfg.plugins?.entries?.zeke?.enabled, true, "zeke plugin must be enabled");
  assert.equal(cfg.plugins?.entries?.zeke?.config?.profile, "sprout");
  assert.equal(cfg.plugins?.entries?.zeke?.config?.tokenEnv, "ZEKEFLOW_OPENCLAW_SPROUT_TOOL_TOKEN");
  assert.equal(
    cfg.plugins?.entries?.zeke?.config?.operatorSigningKeyEnv,
    "ZEKEFLOW_OPENCLAW_OPERATOR_SIGNING_KEY",
  );
  assert.deepEqual(sprout.subagents ?? cfg.agents?.defaults?.subagents ?? {}, {
    maxConcurrent: 2,
    requireAgentId: true,
    allowAgents: ["sprout-investigator"],
  });
  assert.equal(investigator.tools?.allow?.includes("sessions_spawn"), false);
  assert.equal(investigator.subagents?.allowAgents?.length, 0);
  assert.equal(cfg.gateway?.auth?.mode, "token");
  assert.equal(cfg.gateway?.auth?.token, "${OPENCLAW_GATEWAY_TOKEN}");
  assert.equal(cfg.hooks?.enabled, true);
  assert.equal(cfg.hooks?.token, "${SPROUT_OPENCLAW_HOOK_TOKEN}");
  assert.equal(
    cfg.hooks?.internal?.load?.extraDirs?.includes("/home/node/.openclaw/hooks/sprout-spr-ocl-002"),
    true,
  );
}

function assertNativeContract(contract, catalogPath) {
  assert.equal(contract.schema, "zekebot.native-tool-contract.v1");
  assert.ok(
    ["pending-s9", "required"].includes(contract.mode),
    "native contract mode must be valid",
  );
  assert.deepEqual(contract.initialNativeTools, [
    "ask_zeke_context",
    "search_zeke_context",
    "explain_zeke_context_route",
    "read_zeke_source",
    "read_repo_file",
    "grep_repo",
    "glob_repo",
    "propose_signal",
  ]);
  assert.ok(
    contract.backendOnlyTools?.includes("create_signal"),
    "create_signal must be backend-only",
  );
  for (const profileName of ["sprout", "rambo", "external-client"]) {
    assert.ok(Array.isArray(contract.profileExpectations?.[profileName]));
  }
  assert.ok(contract.profileExpectations.sprout.includes("propose_signal"));
  assert.equal(contract.profileExpectations["external-client"].includes("propose_signal"), false);
  assert.equal(contract.profileExpectations.sprout.includes("create_signal"), false);
  if (contract.mode === "pending-s9") {
    assert.equal(contract.pendingUntilStory, "OCL-FORK-001/S9");
    return;
  }
  if (!catalogPath) {
    throw new Error("native contract mode required needs --runtime-catalog evidence");
  }
  const runtimeCatalog = readJson(catalogPath);
  for (const [profileName, expectedTools] of Object.entries(contract.profileExpectations)) {
    const actualTools = new Set(runtimeCatalog.profiles?.[profileName]?.tools ?? []);
    for (const tool of expectedTools) {
      assert.ok(actualTools.has(tool), `runtime profile ${profileName} missing ${tool}`);
    }
    for (const backendOnly of contract.backendOnlyTools ?? []) {
      assert.equal(
        actualTools.has(backendOnly),
        false,
        `runtime profile ${profileName} exposes ${backendOnly}`,
      );
    }
  }
}

async function assertHookHandlers(root) {
  const hooksRoot = path.join(root, "hooks");
  const requireHook = createCommonJsFixtureLoader(hooksRoot);
  const memory = requireHook("./sprout-message-memory/handler.js");
  const preTool = requireHook("./sprout-tool-attempt/handler.js");
  const postTool = requireHook("./sprout-tool-complete/handler.js");
  const hookError = requireHook("./sprout-hook-error/handler.js");
  const emitted = [];
  const okFetch = async (_url, init) => {
    emitted.push(JSON.parse(init.body));
    return { status: 202 };
  };
  const env = { SPROUT_OPENCLAW_HOOK_TOKEN: "fixture-hook-token" };

  memory._test.resetPendingMessages();
  await memory({
    type: "message:received",
    sessionKey: "s3-smoke",
    content: "Ross asks for status",
    timestamp: "2026-05-01T00:00:00.000Z",
    env,
    fetch: okFetch,
  });
  await memory({
    type: "message:sent",
    sessionKey: "s3-smoke",
    content: "Sprout responds",
    timestamp: "2026-05-01T00:00:01.000Z",
    env,
    fetch: okFetch,
  });
  assert.equal(emitted.at(-1)?.event_type, "sprout:conversation.message_pair");

  const denied = await preTool({
    toolName: "exec",
    sessionKey: "s3-smoke",
    arguments: { command: "whoami" },
    env,
    fetch: okFetch,
  });
  assert.deepEqual(denied, { allow: false, reason: "blocked_by_sprout_tool_profile" });
  assert.equal(emitted.at(-1)?.event_type, "tool:sprout.call_denied");

  const allowed = await preTool({
    toolName: "web_search",
    sessionKey: "s3-smoke",
    arguments: { query: "OpenClaw release notes" },
    env,
    fetch: okFetch,
  });
  assert.deepEqual(allowed, { allow: true });

  await postTool({
    toolName: "web_search",
    sessionKey: "s3-smoke",
    arguments: { query: "OpenClaw release notes" },
    result: { ok: true },
    env,
    fetch: okFetch,
  });
  assert.equal(emitted.at(-1)?.event_type, "tool:sprout.call_completed");

  await hookError({
    sessionKey: "s3-smoke",
    context: { tool_name: "web_search" },
    error: { message: "schema status 400", stack: "Error: schema status 400" },
    env,
    fetch: okFetch,
  });
  assert.equal(emitted.at(-1)?.event_type, "ops:sprout.hook_error");

  const telemetryErrors = [];
  await postTool({
    toolName: "web_search",
    telemetryErrors,
    env,
    fetch: async () => {
      throw new Error("network down");
    },
  });
  assert.deepEqual(telemetryErrors, ["network down"]);

  const hookErrorTelemetry = [];
  await hookError({
    telemetryErrors: hookErrorTelemetry,
    error: { message: "network down" },
    env,
    fetch: async () => {
      throw new Error("network down");
    },
  });
  assert.deepEqual(hookErrorTelemetry, ["network down"]);
}

function createCommonJsFixtureLoader(root) {
  const nativeRequire = createRequire(import.meta.url);
  const cache = new Map();
  function load(request, parentDir = root) {
    if (!request.startsWith(".") && !path.isAbsolute(request)) {
      return nativeRequire(request);
    }
    const resolved = path.resolve(parentDir, request);
    const file = resolved.endsWith(".js") ? resolved : `${resolved}.js`;
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} };
    cache.set(file, module);
    const dirname = path.dirname(file);
    const localRequire = (nextRequest) => load(nextRequest, dirname);
    const source = readFileSync(file, "utf8");
    const wrapped = `(function (exports, require, module, __filename, __dirname) {\n${source}\n})`;
    const script = new vm.Script(wrapped, { filename: file });
    script.runInThisContext()(module.exports, localRequire, module, file, dirname);
    return module.exports;
  }
  return load;
}

async function runContainerSmoke(candidateImage, sourceConfigDir) {
  const tmpHome = mkdtempSync(path.join(tmpdir(), "zekebot-stock-"));
  const containerName = `zekebot-stock-${randomUUID()}`;
  const hostPort = await choosePort();
  try {
    await cp(sourceConfigDir, tmpHome, { recursive: true });
    await mkdir(path.join(tmpHome, "workspace"), { recursive: true });
    await mkdir(path.join(tmpHome, "hooks", "sprout-spr-ocl-002"), { recursive: true });
    await cp(
      path.join(sourceConfigDir, "hooks"),
      path.join(tmpHome, "hooks", "sprout-spr-ocl-002"),
      {
        recursive: true,
      },
    );
    docker("pull", candidateImage);
    docker(
      "run",
      "-d",
      "--rm",
      "--name",
      containerName,
      "-p",
      `127.0.0.1:${hostPort}:18789`,
      "-v",
      `${tmpHome}:/home/node/.openclaw`,
      "-e",
      "OPENCLAW_GATEWAY_TOKEN=fixture-gateway-token",
      "-e",
      "SPROUT_OPENCLAW_HOOK_TOKEN=fixture-hook-token",
      "-e",
      "SPROUT_MCP_LOOPBACK_TOKEN=fixture-loopback-token",
      "-e",
      "ZEKEFLOW_EVENTS_WRITE_TOKEN=fixture-events-token",
      "-e",
      "ZEKEFLOW_OPENCLAW_SPROUT_TOOL_TOKEN=fixture-sprout-tool-token",
      "-e",
      "ZEKEFLOW_OPENCLAW_OPERATOR_SIGNING_KEY=fixture-operator-signing-key",
      "-e",
      "ANTHROPIC_OAUTH_TOKEN=fixture-anthropic-token",
      "-e",
      "TAVILY_API_KEY=fixture-tavily-token",
      candidateImage,
    );
    try {
      await waitForEndpoint(`http://127.0.0.1:${hostPort}/healthz`, "healthz");
      await waitForEndpoint(`http://127.0.0.1:${hostPort}/readyz`, "readyz", {
        allowUnavailable: true,
      });
    } catch (err) {
      try {
        console.error(docker("logs", "--tail", "120", containerName));
      } catch (_) {}
      throw err;
    }
    const mounts = JSON.parse(docker("inspect", containerName, "--format", "{{json .Mounts}}"));
    assert.deepEqual(
      mounts.map((mount) => mount.Destination).sort(),
      ["/home/node/.openclaw"],
      "stock smoke must mount only OpenClaw home",
    );
    const runtimeCatalog = gatewayCall(containerName, "tools.catalog", { includePlugins: true });
    assertRuntimeCatalogTools(runtimeCatalog, REQUIRED_SPROUT_NATIVE_TOOLS);
    assertRuntimeCatalogTools(runtimeCatalog, REQUIRED_STOCK_TOOLS);
    assertRuntimeCatalogMissing(runtimeCatalog, ["create_signal"]);
  } finally {
    spawnSync("docker", ["rm", "-f", containerName], { stdio: "ignore" });
    rmSync(tmpHome, { recursive: true, force: true });
  }
}

function gatewayCall(containerName, method, params) {
  const raw = docker(
    "exec",
    containerName,
    "openclaw",
    "gateway",
    "call",
    method,
    "--url",
    "ws://127.0.0.1:18789",
    "--token",
    "fixture-gateway-token",
    "--timeout",
    "10000",
    "--json",
    "--params",
    JSON.stringify(params ?? {}),
  );
  const line = raw
    .split(/\r?\n/u)
    .toReversed()
    .find((entry) => entry.trim().startsWith("{"));
  if (!line) {
    throw new Error(`gateway call ${method} returned no JSON payload:\n${raw}`);
  }
  const parsed = JSON.parse(line);
  return parsed?.payload ?? parsed?.result ?? parsed;
}

function catalogToolNames(catalog) {
  const tools = Array.isArray(catalog?.tools) ? catalog.tools : [];
  return new Set(tools.map((tool) => tool?.name).filter(Boolean));
}

function assertRuntimeCatalogTools(catalog, names) {
  const actual = catalogToolNames(catalog);
  for (const name of names) {
    assert.ok(actual.has(name), `runtime tools.catalog missing ${name}`);
  }
}

function assertRuntimeCatalogMissing(catalog, names) {
  const actual = catalogToolNames(catalog);
  for (const name of names) {
    assert.equal(actual.has(name), false, `runtime tools.catalog exposes blocked tool ${name}`);
  }
}

function docker(...dockerArgs) {
  return execFileSync("docker", dockerArgs, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function waitForEndpoint(url, label, options = {}) {
  const deadline = Date.now() + 90_000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2_000);
      const res = await fetch(url, {
        headers: { Authorization: "Bearer fixture-gateway-token" },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (res.ok || (options.allowUnavailable && res.status === 503)) {
        return;
      }
      lastError = new Error(`${label} returned ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`${label} did not become reachable: ${lastError?.message ?? "unknown error"}`);
}

async function choosePort() {
  const { createServer } = await import("node:net");
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}
