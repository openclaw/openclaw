/**
 * Four synthetic nodes, real Gateway/WebSocket admission, real one-minute host-stat cadence.
 * Run after a qaRuntime build:
 * node --import ./scripts/tsx.mjs scripts/perf/node-host-stats-measure.ts \
 *   --out /path/to/fresh-output --observer /path/to/frozen/observer.cjs
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { buildDeviceAuthPayloadV3 } from "../../packages/gateway-client/src/device-auth.ts";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.ts";
import { stopChild, stopGatewayGracefully } from "../lib/gateway-bench-child.ts";
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
assert(!existsSync(output), "use a fresh output directory");
mkdirSync(output, { recursive: true });
const fixture = path.join(output, "fixture");
mkdirSync(path.join(fixture, "workspace"), { recursive: true });
const port = await getFreePort();
const config = writeGatewayBenchConfig(
  fixture,
  {
    ...structuredClone(BASE_GATEWAY_BENCH_CONFIG),
    agents: {
      defaults: { skipBootstrap: true },
      entries: { main: { workspace: path.join(fixture, "workspace") } },
    },
    cron: { enabled: false },
  },
  { agentList: [{ id: "main", workspace: path.join(fixture, "workspace") }] },
);
let phase = "boot";
const phases: { phase: string; time: number }[] = [];
function setPhase(next: string) {
  phase = next;
  phases.push({ phase, time: Date.now() });
  writeFileSync(path.join(output, "phase"), phase);
}
setPhase("boot");
const stopPreload = new URL("../lib/gateway-bench-stop-preload.mjs", import.meta.url);
stopPreload.searchParams.set("parentPid", String(process.pid));
stopPreload.searchParams.set("entry", path.resolve("dist/entry.js"));
const log = createWriteStream(path.join(output, "gateway.log"));
const gateway = spawn(
  process.execPath,
  buildGatewayBenchChildArgs("dist/entry.js", port, [
    ...gatewayBenchCpuProfileArgs(output),
    "--import",
    stopPreload.href,
  ]),
  {
    env: {
      ...createGatewayBenchEnv(fixture, config, { caseEnv: { OPENCLAW_SKIP_CHANNELS: "1" } }),
      SQLMEASURE_OUT: output,
      NODE_OPTIONS: `--require=${JSON.stringify(path.resolve(values.observer))} --enable-source-maps`,
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    detached: true,
  },
);
gateway.stdout?.pipe(log);
gateway.stderr?.pipe(log);
type Peer = ReturnType<typeof createGatewayWsClient>;
const peers: Peer[] = [];
let database: DatabaseSync | undefined;
const broadcasts = new Map<string, { memoryFreeBytes: number; updatedAtMs: number }>();
let broadcastCount = 0;
async function request(peer: Peer, method: string, params = {}) {
  const reply = await peer.request(method, params, 60_000);
  assert(reply.ok, `${method}: ${JSON.stringify(reply.error)}`);
  return reply.payload;
}
const evidence: Record<string, unknown> = {
  sourceHead: process.env.NODESTATS_HEAD,
  nodes: 4,
  cadenceMs: 60_000,
  steadyMs: 900_000,
  load: loadavg(),
  countsOnly: true,
};
try {
  const ready = await waitForInitialProbe({
    port,
    path: "/readyz",
    startAt: performance.now(),
    deadlineAt: performance.now() + 300_000,
    isDone: () => gateway.exitCode !== null || gateway.signalCode !== null,
  });
  assert.equal(ready.status, 200);
  const operator = createGatewayWsClient({
    url: `ws://127.0.0.1:${port}`,
    onEvent(event) {
      if (event.event === "node.hostStats") {
        const payload = event.payload as {
          nodeId: string;
          hostStats: { memoryFreeBytes: number; updatedAtMs: number };
        };
        broadcasts.set(payload.nodeId, payload.hostStats);
        broadcastCount++;
      }
    },
  });
  peers.push(operator);
  await operator.waitOpen();
  await request(operator, "connect", {
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    client: { id: "gateway-client", version: "1.0.0", platform: "linux", mode: "backend" },
    role: "operator",
    scopes: ["operator.admin", "operator.read", "operator.write", "operator.pairing"],
    caps: [],
  });
  setPhase("connect");
  const nodes: { peer: Peer; id: string }[] = [];
  for (let i = 0; i < 4; i++) {
    const keys = generateKeyPairSync("ed25519");
    const rawKey = keys.publicKey.export({ type: "spki", format: "der" }).subarray(-32);
    const id = createHash("sha256").update(rawKey).digest("hex");
    const challenge = Promise.withResolvers<string>();
    const peer = createGatewayWsClient({
      url: `ws://127.0.0.1:${port}`,
      onEvent(event) {
        if (event.event === "connect.challenge") {
          challenge.resolve((event.payload as { nonce: string }).nonce);
        }
      },
    });
    peers.push(peer);
    await peer.waitOpen();
    const nonce = await challenge.promise;
    const signedAtMs = Date.now();
    const payload = buildDeviceAuthPayloadV3({
      deviceId: id,
      clientId: "node-host",
      clientMode: "node",
      role: "node",
      scopes: [],
      signedAtMs,
      nonce,
      platform: "linux",
    });
    await request(peer, "connect", {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: {
        id: "node-host",
        version: "1.0.0",
        platform: "linux",
        mode: "node",
        displayName: `synthetic-node-${i}`,
      },
      role: "node",
      scopes: [],
      caps: [],
      commands: [],
      device: {
        id,
        publicKey: rawKey.toString("base64url"),
        signature: sign(null, Buffer.from(payload), keys.privateKey).toString("base64url"),
        signedAt: signedAtMs,
        nonce,
      },
    });
    nodes.push({ peer, id });
  }
  database = new DatabaseSync(path.join(fixture, "state", "state", "openclaw.sqlite"), {
    readOnly: true,
  });
  const read = () => {
    const rows = database!
      .prepare(
        "SELECT node_surface_json FROM device_pairing_paired WHERE node_surface_json IS NOT NULL",
      )
      .all() as { node_surface_json: string }[];
    const revision = database!
      .prepare(
        "SELECT value_json FROM config_machine_state WHERE state_key = 'devicePairing.revision'",
      )
      .get() as { value_json: string };
    return {
      surfaces: rows.map((row) => JSON.parse(row.node_surface_json)),
      revision: Number(JSON.parse(revision.value_json)),
    };
  };
  async function report(sample: number) {
    for (const { peer } of nodes) {
      await request(peer, "node.event", {
        event: "node.host.stats",
        payloadJSON: JSON.stringify({
          cpuCount: 4,
          memoryTotalBytes: 8192,
          memoryFreeBytes: 4096 - sample,
        }),
      });
    }
    const list = (await request(operator, "node.list")) as {
      nodes: { nodeId: string; connected: boolean; hostStats?: { memoryFreeBytes: number } }[];
    };
    for (const { id } of nodes) {
      const entry = list.nodes.find((node) => node.nodeId === id);
      assert(
        entry?.connected && entry.hostStats?.memoryFreeBytes === 4096 - sample,
        "live catalog must show each latest synthetic sample",
      );
    }
  }
  setPhase("first-sample");
  await report(0);
  const firstDeadline = Date.now() + 30_000;
  while (read().surfaces.some((surface) => !surface.lastHostStats)) {
    assert(Date.now() < firstDeadline, "first sample did not persist");
    await delay(50);
  }
  const initial = read();
  assert.equal(initial.surfaces.length, 4);
  setPhase("steady");
  const start = Date.now();
  const observations = [{ elapsedMs: 0, revision: initial.revision }];
  for (let sample = 1; sample <= 15; sample++) {
    await delay(Math.max(0, start + sample * 60_000 - Date.now()));
    await report(sample);
    observations.push({ elapsedMs: Date.now() - start, revision: read().revision });
    console.log(JSON.stringify({ sample, revisionAdvance: read().revision - initial.revision }));
  }
  await delay(1_000);
  const finalSteady = read();
  evidence.steady = {
    elapsedMs: Date.now() - start,
    revisionAdvance: finalSteady.revision - initial.revision,
    observations,
  };
  evidence.broadcastCount = broadcastCount;
  assert.equal(broadcasts.size, 4);
  setPhase("final-sample");
  await report(16);
  setPhase("disconnect");
  for (const { peer } of nodes.slice(0, 2)) {
    peer.close();
  }
  await delay(1_000);
  const offline = (await request(operator, "node.list")) as {
    nodes: { connected: boolean; hostStats?: { memoryFreeBytes: number } }[];
  };
  assert.equal(offline.nodes.length, 4);
  assert(
    offline.nodes.filter((node) => !node.connected).length === 2 &&
      offline.nodes.every((node) => node.hostStats?.memoryFreeBytes === 4080),
    "offline catalog must retain final sample",
  );
  evidence.offlineLatest = true;
  setPhase("shutdown");
  operator.close();
  database.close();
  database = undefined;
  await stopGatewayGracefully(gateway, 60_000);
  database = new DatabaseSync(path.join(fixture, "state", "state", "openclaw.sqlite"), {
    readOnly: true,
  });
  const saved = read().surfaces;
  assert.equal(saved.length, 4);
  assert(saved.every((surface) => surface.lastHostStats?.memoryFreeBytes === 4080));
  evidence.shutdownLatest = true;
  evidence.ok = true;
} catch (error) {
  evidence.failure = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  for (const peer of peers) {
    peer.close();
  }
  database?.close();
  await stopChild(gateway, { teardownGraceMs: 10_000, killGraceMs: 2_000 });
  writeFileSync(
    path.join(output, "evidence.json"),
    JSON.stringify({ ...evidence, phases }, null, 2),
  );
}
