#!/usr/bin/env node
// Built-Gateway regression for completed async contexts retaining model stores.
// Run from a built checkout with a NEW root, e.g. .openclaw/tmp/catalog-retention.
// Synthetic model, plugin, credentials, state, and loopback ports only; no live Gateway.
// Acceptance: after eight catalog reloads and 36 completed tool captures, post-quiescence
// ModelRegistry instances must not exceed the warm baseline by more than the live successor.
// Native callbacks deliberately stay cached (bounded to 36); their closed model borrows must not.
// Heap snapshots are private artifacts. Main-heap/RSS and lifetime watchdogs bound this fixture only.
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, openSync, closeSync, readFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/index.ts";
import { applyMockOpenAiModelConfig } from "../e2e/lib/fixtures/mock-openai-config.mjs";
import { stopChild } from "../lib/gateway-bench-child.ts";
import { getFreePort } from "../lib/gateway-bench-probes.ts";
import { readGatewayResources } from "../lib/gateway-bench-profile.ts";
import { createGatewayBenchEnv, BASE_GATEWAY_BENCH_CONFIG } from "../lib/gateway-bench-runtime.ts";
import { createGatewayWsClient } from "../lib/gateway-ws-client.ts";
if (!process.argv[2] || process.argv[2] === "--help") {
  console.log(
    "node --import ./scripts/tsx.mjs scripts/perf/gateway-catalog-context-retention.mjs NEW_SYNTHETIC_ROOT",
  );
  process.exit(process.argv[2] ? 0 : 2);
}
if (process.platform !== "linux" || process.versions.bun) {
  throw new Error("This bounded proof requires Node on Linux for its process RSS watchdog");
}
const root = path.resolve(process.argv[2]);
mkdirSync(root);
const workspace = path.join(root, "workspace");
mkdirSync(workspace);
spawnSync("git", ["init", "--quiet", "--template=", workspace]);
const port = await getFreePort(),
  mockPort = await getFreePort();
const cfg = structuredClone(BASE_GATEWAY_BENCH_CONFIG);
cfg.cron = { enabled: false };
cfg.memory = { search: { enabled: false } };
cfg.plugins.slots = { memory: "none" };
cfg.plugins.entries = {
  ...cfg.plugins.entries,
  "skill-workshop": { config: { autonomous: { mode: "off" } } },
};
cfg.meta = { migrations: { skillWorkshopPlugin: true } };
applyMockOpenAiModelConfig(cfg, { mockPort });
cfg.agents.defaults = {
  ...cfg.agents.defaults,
  skipBootstrap: true,
  skills: [],
  modelPolicy: {},
  systemAgent: { agentId: "main" },
  maxConcurrent: 4,
};
delete cfg.agents.defaults.models;
cfg.agents.ownership = "explicit";
cfg.agents.entries = { main: { workspace } };
const PLUGIN_SOURCE =
  'import { AsyncLocalStorage } from "node:async_hooks";\nimport { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";\nconst frames = [];\nexport default definePluginEntry({id:"lease-retention-capture",name:"Synthetic bounded async-context cache",register(api){\n api.registerTool({name:"capture_context",label:"Capture synthetic context",description:"Retain a bounded native async callback for this synthetic test",parameters:{type:"object",properties:{},additionalProperties:false},async execute(){if(frames.length<36)frames.push(AsyncLocalStorage.snapshot());console.info("SYNTHETIC_CAPTURE_FRAME",frames.length);return {content:[{type:"text",text:"Synthetic context captured"}]};}});\n api.registerService({id:"lease-retention-capture",start(){},stop(){frames.length=0;}});\n}});\n';
// A bounded plugin-owned callback cache models long-lived native async resources.
const pluginDir = path.join(root, "plugins", "lease-retention-capture");
mkdirSync(pluginDir, { recursive: true });
writeFileSync(path.join(pluginDir, "index.mjs"), PLUGIN_SOURCE);
writeFileSync(
  path.join(pluginDir, "package.json"),
  JSON.stringify({
    name: "@openclaw/lease-retention-capture",
    private: true,
    type: "module",
    version: "1.0.0",
    openclaw: { extensions: ["./index.mjs"] },
  }),
);
writeFileSync(
  path.join(pluginDir, "openclaw.plugin.json"),
  JSON.stringify({
    id: "lease-retention-capture",
    contracts: { tools: ["capture_context"] },
    activation: { onStartup: true },
    configSchema: { type: "object", additionalProperties: false },
  }),
);
cfg.plugins.load = { paths: [pluginDir] };
cfg.plugins.entries["lease-retention-capture"] = { enabled: true };

const utilityPort = await getFreePort();
cfg.models.providers["fixture-utility"] = {
  ...cfg.models.providers.openai,
  baseUrl: "http://127.0.0.1:" + utilityPort + "/v1",
};
cfg.agents.defaults.utilityModel = "fixture-utility/gpt-5.6-luna";
cfg.tools = { codeMode: false };
const configPath = path.join(root, "openclaw.json");
writeFileSync(configPath, JSON.stringify(cfg));
const control = path.join(root, "control.json");
writeFileSync(control, JSON.stringify({ text: "SYNTHETIC_CONTEXT_CAPTURED" }));
const env = createGatewayBenchEnv(root, configPath, {
  startupTrace: false,
  caseEnv: {
    OPENAI_API_KEY: "synthetic-not-a-key",
    OPENCLAW_PROFILE: "memory-150955",
    OPENCLAW_GATEWAY_PORT: String(port),
    OPENCLAW_SYSTEMD_UNIT: "openclaw-memory-150955",
    TMPDIR: root,
  },
});
const completedSnapshots = [];
const children = [];
let gateway;
const abort = new AbortController();
let phase = "startup";
const resourceLimit = 6 * 1024 * 1024 * 1024;
const stop = () => abort.abort();
const watchdog = setTimeout(stop, 720000);
const sleep = (ms) => delay(ms, undefined, { signal: abort.signal });
process.once("SIGTERM", () => abort.abort(new Error("fixture interrupted")));
process.once("SIGINT", () => abort.abort(new Error("fixture interrupted")));
let probeTimer;
const probes = [];
const memorySamples = [];
const clients = [];
const record = (event) => {
  const line = JSON.stringify({ time: Date.now(), ...event });
  console.log(line);
};
function start(args, label, extra = {}) {
  const fd = openSync(path.join(root, label + ".log"), "wx");
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: { ...env, ...extra },
    detached: true,
    stdio: ["ignore", fd, fd, ...(label === "gateway" ? ["ipc"] : [])],
  });
  closeSync(fd);
  children.push(child);
  return child;
}
async function connect() {
  const c = createGatewayWsClient({ url: "ws://127.0.0.1:" + port });
  clients.push(c);
  await c.waitOpen();
  const res = await c.request("connect", {
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    client: {
      id: "gateway-client",
      displayName: "synthetic failure probe",
      version: "1",
      platform: process.platform,
      mode: "backend",
    },
    role: "operator",
    scopes: ["operator.read", "operator.write", "operator.admin"],
  });
  if (!res.ok) {
    c.close();
    throw new Error(JSON.stringify(res.error));
  }
  return c;
}
let c;
const rpc = async (method, params = {}, timeout = 120000) => {
  const r = await c.request(method, params, timeout, { retryStartup: true });
  if (!r.ok) {
    throw new Error(method + ": " + JSON.stringify(r.error));
  }
  return r.payload;
};
try {
  start(["scripts/e2e/mock-openai-server.mjs"], "mock", {
    MOCK_PORT: String(mockPort),
    MOCK_BIND_HOST: "127.0.0.1",
    MOCK_RESPONSE_CONTROL: control,
    MOCK_REQUEST_LOG: path.join(root, "mock-requests.jsonl"),
  });
  start(["scripts/e2e/mock-openai-server.mjs"], "mock-utility", {
    MOCK_PORT: String(utilityPort),
    MOCK_BIND_HOST: "127.0.0.1",
    MOCK_RESPONSE_CONTROL: "",
    SUCCESS_MARKER: "SYNTHETIC_UTILITY",
  });
  gateway = start(
    [
      "--max-old-space-size=2048",
      "--import",
      path.resolve("scripts/tsx.mjs"),
      "--import",
      path.resolve("scripts/lib/gateway-bench-profile-preload.ts"),
      "dist/index.js",
      "gateway",
      "--port",
      String(port),
    ],
    "gateway",
  );
  const deadline = Date.now() + 180000;
  while (!c && !abort.signal.aborted && Date.now() < deadline) {
    try {
      c = await connect();
    } catch {
      if (gateway.exitCode !== null) {
        throw new Error("gateway exited " + gateway.exitCode);
      }
      await sleep(500);
    }
  }
  if (!c) {
    throw new Error("readiness timeout");
  }
  record({
    kind: "ready",
    pid: gateway.pid,
    port,
    node: process.version,
    build: JSON.parse(readFileSync("dist/build-info.json", "utf8")),
  });
  const keys = Array.from({ length: 4 }, (_, i) => "agent:main:catalog-context-" + i);
  for (const key of keys) {
    await rpc("sessions.create", { key, agentId: "main" });
  }
  const snapshot = async (label) => {
    phase = "snapshot";
    const r = await rpc("diagnostics.heapSnapshot", { reason: "steady-window " + label }, 180000);
    completedSnapshots.push({ label, ...r });
    record({ kind: "snapshot", label, ...r });
    return r;
  };
  const sample = async (label) => {
    const resources = await readGatewayResources(gateway, { collectGarbage: true });
    const resourceSample = { label, heap: resources.memory.heapUsed, rss: resources.memory.rss };
    record({ kind: "resources", ...resourceSample });
    memorySamples.push(resourceSample);
  };
  const pollHealth = async () => {
    try {
      const phaseAtStart = phase;
      const startedAt = Date.now();
      const t = performance.now();
      const result = await c.request("health", {}, 15000);
      const ms = performance.now() - t;
      probes.push({ phase: phaseAtStart, startedAt, finishedAt: Date.now(), ms, ok: result.ok });
      const status = readFileSync("/proc/" + gateway.pid + "/status", "utf8");
      const rss = Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1]) * 1024;
      if (rss > resourceLimit) {
        abort.abort(new Error("owned fixture RSS cap reached"));
      }
    } catch (e) {
      probes.push({ phase, error: String(e), ok: false });
      if (phase !== "snapshot") {
        abort.abort(e);
      }
    }
    if (!abort.signal.aborted) {
      probeTimer = setTimeout(() => {
        void pollHealth();
      }, 2000);
    }
  };
  await pollHealth();

  let expectedCaptures = 0;
  const makeToolEvents = (name, args, id) => {
    const item = {
      type: "function_call",
      id: "fc_" + id,
      call_id: id,
      name,
      arguments: JSON.stringify(args),
    };
    return [
      { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
      {
        type: "response.function_call_arguments.delta",
        item_id: item.id,
        output_index: 0,
        delta: item.arguments,
      },
      { type: "response.output_item.done", output_index: 0, item },
      {
        type: "response.completed",
        response: {
          id: "resp_" + id,
          status: "completed",
          output: [item],
          usage: { input_tokens: 64, output_tokens: 16, total_tokens: 80 },
        },
      },
    ];
  };
  const runOne = async (sessionKey) => {
    if (abort.signal.aborted) {
      throw new Error("fixture interrupted");
    }
    const runId = randomUUID();
    writeFileSync(
      control,
      JSON.stringify({
        scriptVersion: runId,
        responses: [
          {
            events: makeToolEvents("tool_search", { query: "capture_context" }, runId + "-search"),
          },
          {
            events: makeToolEvents("tool_describe", { id: "capture_context" }, runId + "-describe"),
          },
          {
            events: makeToolEvents(
              "dispatch_action",
              { id: "capture_context", args: {} },
              runId + "-capture",
            ),
          },
        ],
        default: { text: "SYNTHETIC_CONTEXT_CAPTURED" },
      }),
    );
    await rpc("chat.send", {
      sessionKey,
      agentId: "main",
      message:
        "Synthetic native context capture. Discover and describe capture_context, invoke it through dispatch_action, then finish.",
      deliver: false,
      idempotencyKey: runId,
    });
    const terminal = await rpc("agent.wait", { runId, timeoutMs: 60000 }, 70000);
    if (terminal.status !== "ok" || terminal.terminalReply?.text !== "SYNTHETIC_CONTEXT_CAPTURED") {
      throw new Error("Native tool flow did not complete: " + JSON.stringify(terminal));
    }
    expectedCaptures++;
    if (
      !readFileSync(path.join(root, "gateway.log"), "utf8").includes(
        "SYNTHETIC_CAPTURE_FRAME " + expectedCaptures,
      )
    ) {
      throw new Error("Native context tool was not executed " + expectedCaptures);
    }
    record({
      kind: "captured-tool",
      runId,
      sessionKey,
      count: expectedCaptures,
      tools: terminal.terminalReceipt.successfulToolNames,
    });
  };
  for (const key of keys) {
    await runOne(key);
  }
  phase = "quiet";
  await sleep(65000);
  await sample("baseline-quiet");
  await snapshot("baseline");
  for (let revision = 1; revision <= 8; revision++) {
    phase = "reload-" + revision;
    const before = await rpc("config.get");
    const models = cfg.models.providers.openai.models;
    for (const model of models) {
      model.name = "Synthetic catalog revision " + revision;
    }
    const patch = await rpc("config.patch", {
      baseHash: before.hash,
      raw: JSON.stringify({ models: { providers: { openai: { models } } } }),
    });
    if (patch.sentinel?.payload?.stats?.requiresRestart) {
      throw new Error("The retention workload must hot-apply without restarting");
    }
    record({ kind: "reload", revision, pid: gateway.pid });
    const listed = await rpc("models.list", { agentId: "main" });
    const row = listed.models?.find((m) => m.id === "gpt-5.6-luna" && m.provider === "openai");
    record({ kind: "catalog", revision, name: row?.name, count: listed.models?.length });
    if (!row?.name?.includes(String(revision))) {
      throw new Error("Catalog publication did not expose the new revision");
    }
    for (const key of keys) {
      await runOne(key);
    }
  }
  phase = "quiet";
  await sleep(65000);
  await sample("reloads-quiet-65s");
  await snapshot("reloads");
  record({
    kind: "complete",
    revisions: 8,
    turns: 36,
    probes,
    memorySamples,
  });
} catch (e) {
  record({ kind: "failed", error: String(e) });
  process.exitCode = 1;
} finally {
  abort.abort();
  clearTimeout(watchdog);
  clearTimeout(probeTimer);
  for (const cl of clients) {
    cl.close();
  }
  for (const child of children.toReversed()) {
    record({
      kind: "cleanup",
      pid: child.pid,
      ...(await stopChild(child, { teardownGraceMs: 10000 })),
    });
  }
}

if (!process.exitCode) {
  const labels = path.join(root, "retention-labels.txt");
  writeFileSync(labels, "ModelRegistry" + String.fromCharCode(10), { mode: 0o600 });
  const counts = [];
  for (const snapshot of [completedSnapshots[0], completedSnapshots.at(-1)]) {
    if (!snapshot) {
      throw new Error("Missing completed snapshot");
    }
    const result = spawnSync(
      process.execPath,
      [
        "--max-old-space-size=2048",
        "scripts/heap-snapshot-diff.mjs",
        "--summary",
        snapshot.path,
        "--labels",
        labels,
        "--top",
        "100",
        "--json",
      ],
      { encoding: "utf8", timeout: 120000, maxBuffer: 10 * 1024 * 1024 },
    );
    if (result.status !== 0) {
      throw new Error("Snapshot analysis failed: " + result.stderr);
    }
    const report = JSON.parse(result.stdout);
    const count = report.classes.find((row) => row.label === "object: ModelRegistry")?.count;
    if (!Number.isSafeInteger(count)) {
      throw new Error("ModelRegistry census missing");
    }
    counts.push({ label: snapshot.label, count, heapUsedAfter: snapshot.heapUsedAfter });
  }
  const passed = counts[1].count <= counts[0].count + 1;
  record({ kind: "retention-verdict", counts, passed });
  if (!passed) {
    process.exitCode = 1;
  }
}
