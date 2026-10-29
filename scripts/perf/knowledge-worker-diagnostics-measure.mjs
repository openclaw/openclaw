// Isolated built-Gateway proof for Knowledge worker attribution and natural heap.
// node --import ./scripts/tsx.mjs scripts/perf/knowledge-worker-diagnostics-measure.mjs \
//   --output .local/knowledge-gateway-base [--root <built-checkout>] [--named]
// Uses two synthetic stores, real plugin actions and the authenticated diagnostics HTTP route.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { StoreRegistry } from "../../extensions/knowledge/src/store-registry.ts";
import { applyMockOpenAiModelConfig } from "../e2e/lib/fixtures/mock-openai-config.mjs";
import { stopChild } from "../lib/gateway-bench-child.ts";
import { getFreePort } from "../lib/gateway-bench-probes.ts";
import { BASE_GATEWAY_BENCH_CONFIG, createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";
import { createGatewayWsClient } from "../lib/gateway-ws-client.ts";

const { values } = parseArgs({
  options: {
    root: { type: "string", default: fileURLToPath(new URL("../../", import.meta.url)) },
    output: { type: "string" },
    named: { type: "boolean" },
  },
});
assert(values.output, "--output must name a new synthetic directory");
const root = path.resolve(values.root);
const output = path.resolve(values.output);
mkdirSync(output);
const state = path.join(output, "state");
mkdirSync(state);
const registry = new StoreRegistry(path.join(state, "knowledge"));
try {
  registry.provision("agent:main");
  registry.provision("agent:second");
} finally {
  registry.close();
}
let port;
do {
  port = await getFreePort();
} while (port < 40000);
const config = structuredClone(BASE_GATEWAY_BENCH_CONFIG);
config.diagnostics = { enabled: true };
config.cron = { enabled: false };
config.logging = { file: path.join(output, "diagnostic.log") };
config.plugins = {
  enabled: true,
  allow: ["knowledge", "diagnostics-prometheus", "openai"],
  slots: { memory: "knowledge" },
  entries: {
    knowledge: { enabled: true },
    "diagnostics-prometheus": { enabled: true },
  },
};
config.agents = {
  ownership: "explicit",
  defaults: { skipBootstrap: true, skills: [] },
  entries: {
    main: { workspace: path.join(output, "workspace-main") },
    second: { workspace: path.join(output, "workspace-second") },
  },
};
for (const entry of Object.values(config.agents.entries)) {
  mkdirSync(entry.workspace);
}
let mockPort;
do {
  mockPort = await getFreePort();
} while (mockPort < 40000 || mockPort === port);
applyMockOpenAiModelConfig(config, { mockPort });
config.agents.defaults.utilityModel = "openai/gpt-5.6-luna";
config.skills = { workshop: { autonomous: { mode: "off" } } };
const report = {
  build: JSON.parse(readFileSync(path.join(root, "dist/build-info.json"), "utf8")),
  port,
  actions: [],
  samples: [],
};
let client;
let mock;
let gateway;
try {
  const mockLog = openSync(path.join(output, "mock.log"), "wx");
  mock = spawn(process.execPath, ["scripts/e2e/mock-openai-server.mjs"], {
    cwd: root,
    detached: true,
    stdio: ["ignore", mockLog, mockLog],
    env: createGatewayBenchEnv(output, path.join(output, "openclaw.json"), {
      caseEnv: {
        MOCK_PORT: String(mockPort),
        MOCK_BIND_HOST: "127.0.0.1",
        SUCCESS_MARKER: "SYNTHETIC_KNOWLEDGE_PROOF",
      },
    }),
  });
  closeSync(mockLog);
  const configPath = path.join(output, "openclaw.json");
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  const log = openSync(path.join(output, "gateway.log"), "wx");
  gateway = spawn(process.execPath, ["dist/index.js", "gateway", "--port", String(port)], {
    cwd: root,
    detached: true,
    stdio: ["ignore", log, log],
    env: createGatewayBenchEnv(output, configPath, {
      startupTrace: false,
      caseEnv: {
        TMPDIR: output,
        OPENAI_API_KEY: "synthetic-knowledge-not-a-real-key",
        OPENCLAW_PROFILE: `knowledge-proof-${port}`,
      },
    }),
  });
  closeSync(log);
  const { PROTOCOL_VERSION } = await import(
    pathToFileURL(path.join(root, "dist/gateway/protocol/index.js")).href
  );
  const deadline = Date.now() + 180000;
  let connectionError;
  while (!client && Date.now() < deadline) {
    if (gateway.exitCode !== null) {
      throw new Error(`Gateway exited ${gateway.exitCode}; inspect gateway.log`);
    }
    const attempt = createGatewayWsClient({ url: `ws://127.0.0.1:${port}`, openTimeoutMs: 1000 });
    try {
      await attempt.waitOpen();
      const connected = await attempt.request("connect", {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: {
          id: "gateway-client",
          displayName: "synthetic-knowledge-proof",
          version: "1",
          platform: process.platform,
          mode: "backend",
        },
        role: "operator",
        scopes: ["operator.read", "operator.write", "operator.admin"],
        caps: [],
      });
      assert(connected.ok, JSON.stringify(connected.error));
      client = attempt;
    } catch (error) {
      connectionError = error;
      attempt.close();
      await delay(500);
    }
  }
  assert(client, `Gateway did not become ready: ${String(connectionError)}`);
  for (const agent of ["main", "second"]) {
    const action = await client.request(
      "plugins.sessionAction",
      {
        pluginId: "knowledge",
        actionId: "agent_query",
        payload: { agent, operation: "status", input: {} },
      },
      60000,
    );
    assert(action.ok, JSON.stringify(action.error));
    assert(action.payload?.ok, JSON.stringify(action.payload));
    assert.equal(action.payload.result.store, "ready");
    report.actions.push({
      agent,
      store: action.payload.result.store,
      records: action.payload.result.records,
    });
  }
  const sessionKey = "agent:main:knowledge-diagnostics-proof";
  const created = await client.request("sessions.create", { key: sessionKey, agentId: "main" });
  assert(created.ok, JSON.stringify(created.error));
  const runId = randomUUID();
  const sent = await client.request(
    "chat.send",
    {
      sessionKey,
      agentId: "main",
      message: "Return a short synthetic diagnostic greeting.",
      deliver: false,
      idempotencyKey: runId,
    },
    120000,
  );
  assert(sent.ok, JSON.stringify(sent.error));
  const completed = await client.request("agent.wait", { runId, timeoutMs: 120000 }, 130000);
  assert(completed.ok, JSON.stringify(completed.error));
  assert.equal(completed.payload.status, "ok");
  report.turn = { runId, status: completed.payload.status };
  for (let index = 0; index < 3; index++) {
    await delay(21000);
    const response = await fetch(`http://127.0.0.1:${port}/api/diagnostics/prometheus`);
    assert(response.ok, `metrics HTTP ${response.status}`);
    const metrics = await response.text();
    writeFileSync(path.join(output, `metrics-${index}.prom`), metrics);
    const status = await client.request("status", { includeChannelSummary: false });
    assert(status.ok, JSON.stringify(status.error));
    const workers = metrics
      .split("\n")
      .filter((line) => /^openclaw_worker_heap_(used|total)_bytes\{/.test(line));
    report.samples.push({ workers, memory: status.payload?.processMemory });
  }
  const last = report.samples.at(-1).workers.join("\n");
  if (values.named) {
    assert(last.includes('script="registry-worker.js"'));
    assert(last.includes('script="storage-worker.js"'));
  } else {
    assert(last.includes('script="other"'));
  }
  writeFileSync(path.join(output, "result.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  client?.close();
  try {
    if (gateway) {
      console.log("Gateway cleanup", await stopChild(gateway, { teardownGraceMs: 15000 }));
    }
  } finally {
    if (mock) {
      console.log("Mock cleanup", await stopChild(mock));
    }
  }
}
