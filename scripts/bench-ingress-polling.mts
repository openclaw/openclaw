/** Real Gateway + bundled iMessage, synthetic JSON-RPC bridge, frozen SQL observer. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { PROTOCOL_VERSION } from "../packages/gateway-protocol/src/version.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { applyMockOpenAiModelConfig } from "./e2e/lib/fixtures/mock-openai-config.mjs";
import { stopChild } from "./lib/gateway-bench-child.ts";
import { getFreePort } from "./lib/gateway-bench-probes.ts";
import {
  readGatewayCpuUsage,
  measureGatewayCpuUsage,
  readGatewayResources,
} from "./lib/gateway-bench-profile.ts";
import {
  BASE_GATEWAY_BENCH_CONFIG,
  buildGatewayBenchChildArgs,
  createGatewayBenchEnv,
  gatewayBenchCpuProfileArgs,
  waitForInitialProbe,
  writeGatewayBenchConfig,
} from "./lib/gateway-bench-runtime.ts";
import { createGatewayWsClient } from "./lib/gateway-ws-client.ts";
const { values } = parseArgs({
  options: {
    out: { type: "string" },
    observer: { type: "string" },
    "idle-seconds": { type: "string", default: "60" },
    "sparse-events": { type: "string", default: "3" },
    "cpu-profile": { type: "boolean", default: false },
    resources: { type: "boolean", default: false },
    "session-polling": { type: "boolean", default: false },
    sessions: { type: "string", default: "2600" },
    placements: { type: "string", default: "177" },
    bound: { type: "string", default: "46" },
    "settle-seconds": { type: "string" },
  },
});
if (!values.out || !values.observer) {
  throw new Error("--out and --observer required");
}
const output = path.resolve(values.out);
const idleSeconds = Number(values["idle-seconds"]);
const sparseEvents = Number(values["sparse-events"]);
const settleSeconds = Number(values["settle-seconds"] ?? (values["session-polling"] ? 90 : 2));
if (
  !(idleSeconds > 0) ||
  !(settleSeconds >= 0) ||
  !Number.isSafeInteger(sparseEvents) ||
  sparseEvents < 0
) {
  throw new Error("Invalid workload size");
}
mkdirSync(output, { recursive: true });
const fixture = path.join(output, "fixture");
mkdirSync(path.join(fixture, "workspace"), { recursive: true });
const children: ChildProcess[] = [];
const events: object[] = [];
let watches = 0;
let sends = 0;
const evidence = {
  phases: [] as { phase: string; start: number; end: number }[],
  latencyMs: [] as number[],
  resources: [] as unknown[],
  ok: false,
};
let phase = "boot";
let client: ReturnType<typeof createGatewayWsClient> | undefined;
let phaseStart = Date.now();
function setPhase(next: string) {
  evidence.phases.push({ phase, start: phaseStart, end: Date.now() });
  phase = next;
  phaseStart = Date.now();
  writeFileSync(path.join(output, "phase"), phase);
}
writeFileSync(path.join(output, "phase"), phase);
const server = createServer((req, res) => {
  if (req.url === "/watch") {
    watches++;
  }
  if (req.url === "/sent") {
    sends++;
  }
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(req.url === "/next" ? events.splice(0) : {}));
});
await new Promise<void>((resolve) => {
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
if (!address || typeof address === "string") {
  throw new Error("No fixture address");
}
const bridgeUrl = `http://127.0.0.1:${address.port}`;
function launch(args: string[], env: NodeJS.ProcessEnv, name: string) {
  const log = createWriteStream(path.join(output, `${name}.log`));
  const child = spawn(process.execPath, args, {
    env,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    detached: true,
  });
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  children.push(child);
  return child;
}
async function until(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 120_000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`${label} timeout`);
    }
    await delay(25);
  }
}
try {
  const port = await getFreePort();
  const mockPort = await getFreePort();
  const cfg: OpenClawConfig = structuredClone(BASE_GATEWAY_BENCH_CONFIG);
  applyMockOpenAiModelConfig(cfg, { mockPort, modelRef: "openai/gpt-4.1" });
  const agentList = [{ id: "main", workspace: path.join(fixture, "workspace") }];
  if (values["session-polling"]) {
    for (const id of ["second", "third"]) {
      agentList.push({ id, workspace: path.join(fixture, id) });
    }
  }
  cfg.agents = {
    ...cfg.agents,
    defaults: { ...cfg.agents?.defaults, skipBootstrap: true },
    entries: Object.fromEntries(agentList.map(({ id, workspace }) => [id, { workspace }])),
  };
  const bridge = path.join(fixture, "synthetic-imsg");
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  writeFileSync(
    bridge,
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.resolve("scripts/perf/bench-ingress-bridge.mjs"))} "$@"\n`,
    { mode: 0o755 },
  );
  cfg.channels = {
    imessage: {
      enabled: true,
      cliPath: bridge,
      dbPath: path.join(fixture, "synthetic-chat.db"),
      dmPolicy: "open",
      allowFrom: ["*"],
    },
  };
  cfg.messages = { inbound: { debounceMs: 0 } };
  cfg.plugins = {
    ...cfg.plugins,
    entries: {
      ...cfg.plugins?.entries,
      imessage: { enabled: true },
      "memory-core": { config: { dreaming: { enabled: false } } },
    },
  };
  const configPath = writeGatewayBenchConfig(fixture, cfg, {
    agentList,
  });
  if (values["session-polling"]) {
    const seed = launch(
      [
        "--import",
        "./scripts/tsx.mjs",
        "scripts/perf/session-polling-fixture.ts",
        "--sessions",
        values.sessions,
        "--placements",
        values.placements,
        "--bound",
        values.bound,
      ],
      createGatewayBenchEnv(fixture, configPath, { caseEnv: {} }),
      "seed",
    );
    const seedCode = await new Promise<number | null>((resolve, reject) => {
      seed.once("error", reject);
      seed.once("exit", resolve);
    });
    assert.equal(seedCode, 0, "Synthetic fixture generation failed");
  }
  launch(
    ["scripts/e2e/mock-openai-server.mjs"],
    { PATH: process.env.PATH, HOME: fixture, MOCK_PORT: String(mockPort) },
    "mock",
  );
  const mockReady = await waitForInitialProbe({
    port: mockPort,
    path: "/health",
    startAt: performance.now(),
    deadlineAt: performance.now() + 30_000,
  });
  if (mockReady.status !== 200) {
    throw new Error("Mock provider unavailable");
  }
  const gateway = launch(
    buildGatewayBenchChildArgs("dist/entry.js", port, [
      ...(values["cpu-profile"] ? gatewayBenchCpuProfileArgs(output) : []),
      ...(values.resources
        ? [
            "--import",
            "./scripts/tsx.mjs",
            "--import",
            "./scripts/lib/gateway-bench-profile-preload.ts",
          ]
        : []),
    ]),
    {
      ...createGatewayBenchEnv(fixture, configPath, { caseEnv: {} }),
      OPENAI_API_KEY: "synthetic-ingress-fixture",
      INGRESS_BENCH_URL: bridgeUrl,
      SQLMEASURE_OUT: output,
      NODE_OPTIONS: `--require=${path.resolve(values.observer)} --enable-source-maps`,
    },
    "gateway",
  );
  const ready = await waitForInitialProbe({
    port,
    path: "/readyz",
    startAt: performance.now(),
    deadlineAt: performance.now() + 300_000,
    isDone: () => gateway.exitCode !== null || gateway.signalCode !== null,
  });
  if (ready.status !== 200) {
    throw new Error("Gateway unavailable");
  }
  await until(() => watches > 0, "iMessage watch");
  if (values["session-polling"]) {
    client = createGatewayWsClient({ url: `ws://127.0.0.1:${port}` });
    await client.waitOpen();
    assert.equal(
      (
        await client.request("connect", {
          minProtocol: PROTOCOL_VERSION,
          maxProtocol: PROTOCOL_VERSION,
          client: {
            id: "gateway-client",
            version: "1.0.0",
            platform: process.platform,
            mode: "backend",
          },
          role: "operator",
          scopes: ["operator.read", "operator.write"],
          caps: [],
        })
      ).ok,
      true,
      "Synthetic client admission failed",
    );
    assert.equal((await client.request("sessions.subscribe", {})).ok, true);
    setPhase("settle");
  }
  await delay(settleSeconds * 1_000);
  const before = values.resources
    ? await readGatewayCpuUsage(gateway, { includeWorkers: true })
    : undefined;
  if (values.resources) {
    evidence.resources.push(await readGatewayResources(gateway));
  }
  setPhase("idle");
  await delay(idleSeconds * 1_000);
  if (before) {
    evidence.resources.push(
      measureGatewayCpuUsage(before, await readGatewayCpuUsage(gateway, { includeWorkers: true })),
    );
  }
  for (let index = 0; index < sparseEvents; index++) {
    setPhase(`sparse-${index}`);
    const sentBefore = sends;
    const started = Date.now();
    events.push({
      id: index + 1,
      guid: `synthetic-${index}`,
      chat_id: 1,
      sender: "+15555550123",
      text: "Reply with one word.",
      is_from_me: false,
      is_group: false,
      created_at: new Date().toISOString(),
    });
    await until(() => sends > sentBefore, "outbound reply");
    evidence.latencyMs.push(Date.now() - started);
    await delay(2_000);
  }
  if (values.resources) {
    evidence.resources.push(await readGatewayResources(gateway));
  }
  setPhase("shutdown");
  client?.close();
  await stopChild(gateway, { teardownGraceMs: 30_000, killGraceMs: 2_000 });
  evidence.ok = true;
} finally {
  client?.close();
  for (const child of children.toReversed()) {
    await stopChild(child, { teardownGraceMs: 10_000, killGraceMs: 2_000 });
  }
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  setPhase("done");
  writeFileSync(path.join(output, "evidence.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ output, ...evidence }));
}
