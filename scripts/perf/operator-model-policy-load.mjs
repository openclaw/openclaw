// Restricted-model-role load against an isolated built Gateway, with synthetic state only.
// Prepare each side with the same seed/time, never reuse a previously measured fixture:
// node --import ./scripts/tsx.mjs scripts/perf/team-shape-fixture.ts --state-dir .local/policy-base \
//   --sessions 10000 --runs 8000 --settled-runs --transcript-mib 8 --approvals 100 --cron 10 \
//   --projects 0 --seed 1716 --now 1791892800000 --port 41736
// Run from the checkout root after pnpm build (or the canonical build:runtime for later sides):
// node --import ./scripts/tsx.mjs scripts/perf/operator-model-policy-load.mjs \
//   --state-dir .local/policy-base --entry dist/entry.js --seconds 600 --port 41736 --clients 64
// Optional --start-file waits after setup; create that task-owned file when other checks finish.
// Shorter --seconds is a setup smoke only. Landing evidence needs >=600s and >=10000 sessions.
// The untraced window reports main-thread CPU, GC seconds/minute and per-kind pause counts,
// event-loop p99/count/max, sessions.list p95/p99/count/max, and per-minute RSS/main heap.
// A separate 30s allocation-sampling pass (including collected objects) and 30s CPU profile
// follow under the same ongoing workload. Use untraced results for latency/GC decisions.
// The role has 64 aliases/3 fallback aliases; 40 plugins, 64 clients, 4 concurrent mock tool turns,
// list/sidebar/search/history reads and label churn prove the real auth/presentation path.
// Only the runner's children, loopback ports, HOME, workspace and fixture state are used.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync, createWriteStream } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.ts";
import { applyMockOpenAiModelConfig } from "../e2e/lib/fixtures/mock-openai-config.mjs";
import { stopChild } from "../lib/gateway-bench-child.ts";
import {
  startGatewayDiagnostics,
  readGatewayResources,
  measureGatewayCpuUsage,
  controlGatewayProfile,
  readGatewayHeapProfile,
} from "../lib/gateway-bench-profile.ts";
import {
  buildGatewayBenchChildArgs,
  createGatewayBenchEnv,
  writePluginFixtures,
  writeGatewayBenchConfig,
} from "../lib/gateway-bench-runtime.ts";
import { createGatewayWsClient } from "../lib/gateway-ws-client.ts";
const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    entry: { type: "string", default: "dist/entry.js" },
    seconds: { type: "string", default: "600" },
    port: { type: "string", default: "41736" },
    clients: { type: "string", default: "64" },
    "allocation-seconds": { type: "string", default: "30" },
    "start-file": { type: "string" },
  },
});
assert(values["state-dir"]);
const root = path.resolve(values["state-dir"]);
const fixture = JSON.parse(readFileSync(path.join(root, "team-shape-summary.json"), "utf8"));
assert.equal(fixture.format, "openclaw-team-shape-v1");
const port = Number(values.port),
  seconds = Number(values.seconds),
  count = Number(values.clients);
assert(Number.isSafeInteger(port) && port >= 40000 && port < 65535);
assert(Number.isSafeInteger(seconds) && seconds > 0);
assert(Number.isSafeInteger(count) && count >= 4 && count <= 70);
for (const reservedPort of [port, port + 1]) {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(reservedPort, "127.0.0.1", resolve);
  });
  await new Promise((resolve, reject) => {
    probe.close((error) => (error ? reject(error) : resolve()));
  });
}
const output = path.join(root, "model-policy-load");
mkdirSync(output); // Refuse previous runs and never reuse their mutated fixture.
const artifactDir = path.dirname(path.resolve(values.entry));
const artifacts = Object.fromEntries(
  readdirSync(artifactDir)
    .filter((file) => /^operator-model-policy-.*\.mjs$/.test(file))
    .map((file) => [
      file,
      createHash("sha256")
        .update(readFileSync(path.join(artifactDir, file)))
        .digest("hex"),
    ]),
);
assert(Object.keys(artifacts).length, "Built model policy artifacts are missing");
const build = JSON.parse(readFileSync(path.join(artifactDir, "build-info.json"), "utf8"));
const identity = "model-policy-load@example.invalid",
  origin = "https://model-policy-load.example.invalid";
const scopes = ["operator.admin", "operator.read", "operator.write"];
const cfg = JSON.parse(readFileSync(path.join(root, "openclaw.json"), "utf8"));
// Git discovery must stop at the synthetic workspace instead of ascending into this checkout.
const workspace = cfg.agents.entries.main.workspace;
const initialized = spawnSync(
  "git",
  ["init", "--quiet", "--template=", "--initial-branch=main", workspace],
  { encoding: "utf8" },
);
assert.equal(initialized.status, 0, initialized.stderr || String(initialized.error));
applyMockOpenAiModelConfig(cfg, { mockPort: port + 1, utilityModelRef: "openai/gpt-5.6-sol" });
cfg.tools = { codeMode: false };
cfg.agents.defaults = {
  ...cfg.agents.defaults,
  skipBootstrap: true,
  maxConcurrent: 4,
  skills: [],
  systemAgent: { agentId: "main" },
};
for (let index = 0; index < 64; index++) {
  cfg.agents.defaults.models[`openai/fixture-model-${index}`] = { alias: `fixture-alias-${index}` };
  cfg.models.providers.openai.models.push({
    ...cfg.models.providers.openai.models[0],
    id: `fixture-model-${index}`,
    name: `Synthetic model ${index}`,
  });
}
cfg.agents.defaults.model.fallbacks = ["fixture-alias-0", "fixture-alias-1", "fixture-alias-2"];
cfg.agents.ownership = "explicit";
cfg.skills = { workshop: { autonomous: { mode: "off" } } };
cfg.plugins = {
  enabled: true,
  allow: ["openai"],
  slots: { memory: "none" },
  entries: { browser: { enabled: false } },
};
cfg.gateway = {
  ...cfg.gateway,
  trustedProxies: ["127.0.0.1", "::1"],
  auth: {
    mode: "trusted-proxy",
    identityScopes: { [identity]: scopes },
    trustedProxy: {
      allowLoopback: true,
      userHeader: "x-forwarded-user",
      requiredHeaders: ["x-forwarded-proto"],
      allowUsers: [identity],
    },
  },
  controlUi: { enabled: false, allowedOrigins: [origin] },
  roles: {
    default: "synthetic",
    definitions: {
      synthetic: {
        agents: "*",
        scopes,
        sessions: { others: "write" },
        modelPolicy: { sourceAgent: "main", allow: ["openai/*"] },
      },
    },
  },
};
const plugins = writePluginFixtures(output, { count: 39 });
const configPath = writeGatewayBenchConfig(output, cfg, { pluginFixtures: plugins });
const controlPath = path.join(output, "mock-control.json");
writeFileSync(
  controlPath,
  JSON.stringify({ models: { "gpt-5.6-sol": { text: "Synthetic activity summary." } } }),
);
const env = createGatewayBenchEnv(path.join(root, "home"), configPath, {
  startupTrace: false,
  caseEnv: {
    OPENCLAW_STATE_DIR: root,
    OPENCLAW_SKIP_CHANNELS: "1",
    OPENCLAW_PROFILE: `model-policy-load-${port}`,
    OPENCLAW_SYSTEMD_UNIT: `openclaw-model-policy-load-${port}`,
    OPENCLAW_LAUNCHD_LABEL: `ai.openclaw.model-policy-load-${port}`,
    OPENAI_API_KEY: "synthetic-loopback-only",
    TMPDIR: path.join(root, "tmp"),
  },
});
const children = [],
  clients = [];
let stopping = false,
  phase = "setup",
  active = false;
/** @type {Error | undefined} */
let failure;
const events = {},
  methods = {},
  latencies = [],
  outcomes = { turns: 0, tools: 0, mutations: 0 };
const record = (value) => {
  console.log(JSON.stringify({ at: new Date().toISOString(), ...value }));
};
let cleanupPromise;
function cleanup() {
  return (cleanupPromise ??= (async () => {
    active = false;
    stopping = true;
    for (const client of clients) {
      client.close();
    }
    const cleanupErrors = [];
    for (const child of children.toReversed()) {
      try {
        await stopChild(child, { teardownGraceMs: 10000 });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length) {
      throw new AggregateError(cleanupErrors, "Synthetic child cleanup failed");
    }
  })());
}
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    failure ??= new Error(`Interrupted: ${signal}`);
    void cleanup();
  });
}
function start(args, label, childEnv, ipc = false) {
  const log = createWriteStream(path.join(output, `${label}.log`));
  const child = spawn(process.execPath, args, {
    env: childEnv,
    detached: true,
    stdio: ["ignore", "pipe", "pipe", ...(ipc ? ["ipc"] : [])],
  });
  child.stdout.pipe(log);
  child.stderr.pipe(log);
  children.push(child);
  child.on("error", (error) => (failure ??= error));
  child.on("exit", (code, signal) => {
    if (!stopping) {
      failure ??= new Error(`${label} exited ${code ?? signal}`);
    }
  });
  return child;
}
async function rpc(client, method, params, timeout = 60000) {
  const began = performance.now();
  const result = await client.request(method, params, timeout);
  assert(result.ok, `${method}: ${JSON.stringify(result.error)}`);
  if (phase === "untraced") {
    methods[method] = (methods[method] ?? 0) + 1;
    if (method === "sessions.list") {
      latencies.push(performance.now() - began);
    }
  }
  return result.payload;
}
async function connect() {
  const client = createGatewayWsClient({
    url: `ws://127.0.0.1:${port}`,
    origin,
    headers: {
      "x-forwarded-for": "203.0.113.171",
      "x-forwarded-proto": "https",
      "x-forwarded-host": "model-policy-load.example.invalid",
      "x-forwarded-user": identity,
    },
    onEvent: (event) => {
      if (phase === "untraced") {
        events[event.event] = (events[event.event] ?? 0) + 1;
      }
    },
  });
  clients.push(client);
  await client.waitOpen();
  const hello = await rpc(client, "connect", {
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    client: {
      id: "openclaw-control-ui",
      displayName: "Synthetic model-policy load",
      version: "1",
      platform: process.platform,
      mode: "ui",
    },
    role: "operator",
    scopes,
    caps: ["model-selection-policy", "tool-events"],
  });
  assert.equal(hello.auth.method, "trusted-proxy");
  await rpc(client, "sessions.subscribe", { rowMode: "sidebar", source: "sidebar", limit: 100 });
  return client;
}
const summarize = (numbers) => {
  const sorted = numbers.toSorted((a, b) => a - b);
  return {
    count: sorted.length,
    mean: sorted.reduce((a, b) => a + b, 0) / sorted.length,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    p99: sorted[Math.ceil(sorted.length * 0.99) - 1],
    max: sorted.at(-1),
  };
};
async function runTurn(client, worker, index) {
  const key = `agent:main:dashboard:model-policy-load-turn-${worker}`,
    runId = randomUUID();
  const accepted = await rpc(client, "agent", {
    sessionKey: key,
    message: `OPENCLAW_E2E_DRAFTPROOF synthetic turn ${index}.`,
    deliver: false,
    idempotencyKey: runId,
  });
  assert.equal(accepted.runId, runId);
  const completed = await rpc(client, "agent.wait", { runId, timeoutMs: 120000 }, 125000);
  assert.equal(completed.status, "ok");
  assert.equal(completed.terminalReceipt?.effective?.provider, "openai");
  assert.equal(completed.terminalReply?.text, "OPENCLAW_E2E_DRAFTPROOF");
  assert(completed.terminalReceipt?.successfulToolNames?.includes("exec"));
  if (phase === "untraced") {
    outcomes.turns++;
    outcomes.tools++;
  }
}
try {
  start(["scripts/e2e/mock-openai-server.mjs"], "mock", {
    ...env,
    MOCK_PORT: String(port + 1),
    MOCK_BIND_HOST: "127.0.0.1",
    MOCK_RESPONSE_CONTROL: controlPath,
    MOCK_RESPONSE_CHUNK_DELAY_MS: "100",
    MOCK_REQUEST_LOG: path.join(output, "mock-requests.jsonl"),
    SUCCESS_MARKER: "Synthetic model-policy text.",
  });
  const gateway = start(
    buildGatewayBenchChildArgs(
      path.resolve(values.entry),
      port,
      // Native type stripping keeps built package imports out of tsconfig source aliases.
      ["--import", path.resolve("scripts/lib/gateway-bench-profile-preload.ts")],
      "trusted-proxy",
    ),
    "gateway",
    env,
    true,
  );
  const deadline = Date.now() + 600000;
  while (
    !(await fetch(`http://127.0.0.1:${port}/readyz`).then(
      (r) => r.ok,
      () => false,
    ))
  ) {
    if (failure) {
      throw failure;
    }
    assert(Date.now() < deadline, "Gateway readiness timed out");
    await delay(500);
  }
  const startupLog = readFileSync(path.join(output, "gateway.log"), "utf8");
  const pluginInventory = /http server listening \((\d+) plugins?: ([^;)]+)/u.exec(startupLog);
  assert(pluginInventory, "Gateway did not publish its loaded plugin inventory");
  const loadedPlugins = new Set(pluginInventory[2].split(", "));
  for (const id of ["openai", ...plugins.pluginIds]) {
    assert(loadedPlugins.has(id), `Plugin not loaded: ${id}`);
  }
  for (let index = 0; index < count; index++) {
    await connect();
  }
  const self = await rpc(clients[0], "users.self", {});
  assert(self.profile.id && self.profile.id !== "gateway-owner");
  const listed = await rpc(clients[0], "sessions.list", { limit: 100, archived: "all" });
  assert(fixture.sessionCount >= (seconds >= 600 ? 10000 : 1));
  assert(listed.totalCount >= (seconds >= 600 ? 10000 : 1));
  const models = await rpc(clients[0], "models.list", {});
  assert.equal(models.modelSelectionPolicy?.restricted, true);
  for (let worker = 0; worker < 4; worker++) {
    await rpc(clients[worker], "sessions.create", {
      key: `agent:main:dashboard:model-policy-load-turn-${worker}`,
      visibility: "shared",
    });
  }
  await runTurn(clients[0], 0, 0);
  await delay(10000);
  record({
    ready: true,
    profileId: self.profile.id,
    sessions: listed.totalCount,
    clients: count,
    loadedPlugins: [...loadedPlugins],
    fixture,
    output,
  });
  if (values["start-file"]) {
    while (true) {
      if (failure) {
        throw failure;
      }
      try {
        readFileSync(values["start-file"]);
        break;
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error;
        }
      }
      await delay(250);
    }
  }
  active = true;
  const guarded = (job) =>
    job.catch((error) => {
      failure ??= error instanceof Error ? error : new Error(String(error));
      active = false;
    });
  const repeat = async (interval, fn) => {
    let index = 0;
    // The duration and failure handlers stop this workload while it awaits RPCs.
    for (;;) {
      if (!active) {
        break;
      }
      const at = performance.now();
      await fn(index++);
      if (active) {
        await delay(Math.max(0, interval - performance.now() + at));
      }
    }
  };
  const jobs = clients.map((client, index) =>
    guarded(
      repeat(5000, async (round) => {
        const variant = (round + index) % 3;
        await rpc(client, "sessions.list", {
          limit: 100,
          archived: variant === 2 ? "all" : false,
          rowMode: variant === 1 ? "compact" : "sidebar",
          source: variant === 1 ? "agent-roster" : "sidebar",
          ...(variant === 2 ? { search: "Team fixture" } : {}),
        });
        if (index % 8 === 0) {
          await rpc(client, "chat.history", {
            sessionKey: `agent:main:dashboard:model-policy-load-turn-${index % 4}`,
            limit: 10,
          });
        }
      }),
    ),
  );
  for (let worker = 0; worker < 4; worker++) {
    jobs.push(guarded(repeat(10000, (index) => runTurn(clients[worker], worker, index + 1))));
  }
  jobs.push(
    guarded(
      repeat(2000, async (index) => {
        await rpc(clients[0], "sessions.patch", {
          key: `agent:main:dashboard:model-policy-load-turn-${index % 4}`,
          label: `Synthetic load ${index}`,
        });
        if (phase === "untraced") {
          outcomes.mutations++;
        }
      }),
    ),
  );
  const before = await readGatewayResources(gateway);
  const memorySamples = [{ elapsedSeconds: 0, ...before.memory }];
  const finishDiagnostics = await startGatewayDiagnostics(gateway);
  phase = "untraced";
  for (let elapsed = 0; elapsed < seconds; elapsed += 10) {
    await delay(Math.min(10, seconds - elapsed) * 1000);
    if (failure) {
      throw failure;
    }
    if (elapsed % 60 === 50) {
      const sample = await readGatewayResources(gateway);
      memorySamples.push({ elapsedSeconds: elapsed + 10, ...sample.memory });
      record({ progressSeconds: elapsed + 10, methods, outcomes, memory: sample.memory });
    }
  }
  phase = "allocation";
  const diagnostics = await finishDiagnostics(),
    after = await readGatewayResources(gateway);
  const cpu = measureGatewayCpuUsage(before, after);
  const untraced = {
    cpu,
    mainThreadCpuPercent: (cpu.mainThread.totalMs / cpu.wallMs) * 100,
    diagnostics,
    gcSecondsPerMinute: ((diagnostics.gc.durationMs?.total ?? 0) / diagnostics.durationMs) * 60,
    sessionsList: summarize(latencies),
    memory: { before: before.memory, after: after.memory, samples: memorySamples },
    methods,
    outcomes,
    events,
  };
  writeFileSync(path.join(output, "untraced.json"), JSON.stringify(untraced, null, 2));
  const heapPath = path.join(output, "allocation.heapprofile"),
    allocationSeconds = Number(values["allocation-seconds"]);
  await controlGatewayProfile(gateway, "heap", "start", heapPath);
  const allocationAt = performance.now();
  await delay(allocationSeconds * 1000);
  await controlGatewayProfile(gateway, "heap", "stop", heapPath);
  const allocationDurationMs = performance.now() - allocationAt;
  const heap = readGatewayHeapProfile(heapPath);
  const cpuPath = path.join(output, "attribution.cpuprofile");
  await controlGatewayProfile(gateway, "cpu", "start", cpuPath);
  await delay(30000);
  await controlGatewayProfile(gateway, "cpu", "stop", cpuPath);
  active = false;
  await Promise.all(jobs);
  if (failure) {
    throw failure;
  }
  const result = {
    build,
    artifacts,
    fixture,
    workload: {
      clients: count,
      plugins: [...loadedPlugins],
      configuredAliases: 64,
      turnWorkers: 4,
      listIntervalMs: 5000,
      turnIntervalMs: 10000,
      mutationIntervalMs: 2000,
      seconds,
    },
    ...untraced,
    allocation: {
      durationMs: allocationDurationMs,
      sampledBytes: heap.sampledAllocatedBytes,
      bytesPerSecond: heap.sampledAllocatedBytes / (allocationDurationMs / 1000),
    },
  };
  writeFileSync(path.join(output, "result.json"), JSON.stringify(result, null, 2));
  record(result);
} finally {
  await cleanup();
}
