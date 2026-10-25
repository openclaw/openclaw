/** Real Gateway/node host and synthetic iMessage transport; aggregate pairing evidence only. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.js";
import { stopChild } from "../lib/gateway-bench-child.ts";
import { getFreePort } from "../lib/gateway-bench-probes.ts";
import {
  BASE_GATEWAY_BENCH_CONFIG,
  buildGatewayBenchChildArgs,
  createGatewayBenchEnv,
  gatewayBenchCpuProfileArgs,
  waitForInitialProbe,
  writeGatewayBenchConfig,
} from "../lib/gateway-bench-runtime.ts";
import { createGatewayWsClient } from "../lib/gateway-ws-client.ts";

const { values } = parseArgs({
  options: { out: { type: "string" }, observer: { type: "string" } },
});
assert(values.out && values.observer, "--out and --observer required");
const output = path.resolve(values.out);
const fixture = path.join(output, "fixture");
mkdirSync(path.join(fixture, "workspace"), { recursive: true });
const children: ChildProcess[] = [];
const events: object[] = [];
let watches = 0;
let sends = 0;
let delivered = 0;
let phase = "boot";
let phaseStart = Date.now();
const evidence = {
  harnessVersion: "3.1.4",
  turns: [],
  children: [] as { name: string; pid: number }[],
  phases: [] as { phase: string; start: number; end: number }[],
  hostSurfaceChanges: 0,
  heartbeatRevisionChanges: 0,
  ok: false,
};
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
  if (req.url === "/next") {
    delivered += events.length;
    res.end(JSON.stringify(events.splice(0)));
  } else {
    res.end("{}");
  }
});
await new Promise<void>((resolve) => {
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
assert(address && typeof address !== "string");
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
  assert(child.pid, `${name} failed to spawn`);
  evidence.children.push({ name, pid: child.pid });
  return child;
}
async function until(predicate: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 180_000;
  while (!(await predicate())) {
    assert(Date.now() < deadline, `${label} timeout`);
    await delay(250);
  }
}
let client: ReturnType<typeof createGatewayWsClient> | undefined;
try {
  const port = await getFreePort();
  const bridge = path.join(fixture, "synthetic-imsg");
  const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  writeFileSync(
    bridge,
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.resolve("scripts/perf/bench-ingress-bridge.mjs"))} "$@"\n`,
    { mode: 0o755 },
  );
  const cfg = {
    ...structuredClone(BASE_GATEWAY_BENCH_CONFIG),
    agents: {
      defaults: { skipBootstrap: true },
      entries: { main: { workspace: path.join(fixture, "workspace") } },
    },
    channels: {
      imessage: {
        enabled: true,
        cliPath: bridge,
        dbPath: path.join(fixture, "synthetic-chat.db"),
        dmPolicy: "allowlist" as const,
        allowFrom: ["+15555550100"],
      },
    },
    plugins: {
      entries: {
        imessage: { enabled: true },
        "memory-core": { config: { dreaming: { enabled: false } } },
      },
    },
  };
  const configPath = writeGatewayBenchConfig(fixture, cfg, {
    agentList: [{ id: "main", workspace: path.join(fixture, "workspace") }],
  });
  const gateway = launch(
    buildGatewayBenchChildArgs("dist/entry.js", port, gatewayBenchCpuProfileArgs(output)),
    {
      ...createGatewayBenchEnv(fixture, configPath, { caseEnv: {} }),
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
  assert.equal(ready.status, 200, "Gateway unavailable");
  await until(() => watches > 0, "iMessage watch");
  client = createGatewayWsClient({ url: `ws://127.0.0.1:${port}` });
  await client.waitOpen();
  const call = async (method: string, params = {}) => {
    const result = await client!.request(method, params);
    assert.equal(result.ok, true, `${method} failed: ${JSON.stringify(result.error)}`);
    return result.payload;
  };
  await call("connect", {
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    client: { id: "gateway-client", version: "1.0.0", platform: process.platform, mode: "backend" },
    role: "operator",
    scopes: ["operator.admin", "operator.read", "operator.write", "operator.pairing"],
    caps: [],
  });
  const nodeRoot = path.join(output, "node-fixture");
  mkdirSync(nodeRoot, { recursive: true });
  const nodeConfig = writeGatewayBenchConfig(nodeRoot, BASE_GATEWAY_BENCH_CONFIG, {});
  const node = launch(
    [
      ...gatewayBenchCpuProfileArgs(output),
      "dist/entry.js",
      "node",
      "run",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--display-name",
      "synthetic-livepair-node",
      "--all-commands",
      "--no-share-installed-apps",
      "--no-desktop-sharing",
    ],
    createGatewayBenchEnv(nodeRoot, nodeConfig, { caseEnv: {} }),
    "node",
  );
  await until(async () => {
    assert(node.exitCode === null && node.signalCode === null, "node host exited");
    for (const kind of ["device", "node"]) {
      const list = (await call(`${kind}.pair.list`)) as { pending: { requestId: string }[] };
      for (const entry of list.pending) {
        await call(`${kind}.pair.approve`, { requestId: entry.requestId });
      }
    }
    const list = (await call("node.list")) as { nodes: { connected: boolean }[] };
    return list.nodes.some((entry) => entry.connected);
  }, "paired node connection");
  await delay(3_000);
  const db = new DatabaseSync(path.join(fixture, "state", "state", "openclaw.sqlite"), {
    readOnly: true,
  });
  try {
    const read = () => {
      const row = db
        .prepare(
          "SELECT node_surface_json FROM device_pairing_paired WHERE node_surface_json IS NOT NULL",
        )
        .get() as { node_surface_json: string };
      const revision = db
        .prepare(
          "SELECT value_json FROM config_machine_state WHERE state_key = 'devicePairing.revision'",
        )
        .get() as { value_json: string };
      return { surface: row.node_surface_json, revision: revision.value_json };
    };
    await until(() => {
      const surface = JSON.parse(read().surface) as { lastHostStats?: unknown };
      return surface.lastHostStats !== undefined;
    }, "initial persisted host stats");
    let previous = read();
    setPhase("warm");
    const started = Date.now();
    let nextMessage = 0;
    while (Date.now() - started < 130_000) {
      const elapsed = Date.now() - started;
      if (nextMessage < 8 && elapsed >= nextMessage * 15_000) {
        events.push({
          id: nextMessage + 1,
          guid: `synthetic-${nextMessage}`,
          chat_id: 1,
          sender: "+15555550123",
          text: "Synthetic denied message.",
          is_from_me: false,
          is_group: false,
          created_at: new Date().toISOString(),
        });
        nextMessage++;
      }
      const current = read();
      if (current.surface !== previous.surface) {
        evidence.hostSurfaceChanges++;
      }
      if (current.revision !== previous.revision) {
        evidence.heartbeatRevisionChanges++;
      }
      previous = current;
      await delay(250);
    }
    assert.equal(delivered, 8);
    assert.equal(sends, 0, "allowlist denial must not send");
    assert(evidence.hostSurfaceChanges >= 2, "two node heartbeat changes required");
    assert(evidence.heartbeatRevisionChanges >= 2, "heartbeat must update pairing revision");
  } finally {
    db.close();
  }
  setPhase("shutdown");
  client.close();
  await stopChild(node, { teardownGraceMs: 10_000, killGraceMs: 2_000 });
  await stopChild(gateway, { teardownGraceMs: 30_000, killGraceMs: 2_000 });
  evidence.ok = true;
} finally {
  if (phase !== "shutdown") {
    setPhase("shutdown");
  }
  client?.close();
  for (const child of children.toReversed()) {
    await stopChild(child, { teardownGraceMs: 10_000, killGraceMs: 2_000 });
  }
  server.closeAllConnections();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  setPhase("done");
  writeFileSync(
    path.join(output, "evidence.json"),
    JSON.stringify({ ...evidence, delivered, sends }, null, 2),
  );
  console.log(JSON.stringify({ ...evidence, delivered, sends }));
}
