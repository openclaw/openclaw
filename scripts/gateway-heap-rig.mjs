#!/usr/bin/env node
// Long-running, synthetic-only Gateway retention probe. Run on an isolated host.
import { spawn, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { buildDeviceAuthPayloadV3 } from "../packages/gateway-client/src/device-auth.ts";
import { applyMockOpenAiModelConfig } from "./e2e/lib/fixtures/mock-openai-config.mjs";
import { stopChild } from "./lib/gateway-bench-child.ts";
import { readGatewayMemory } from "./lib/gateway-bench-probes.ts";
import { BASE_GATEWAY_BENCH_CONFIG, createGatewayBenchEnv } from "./lib/gateway-bench-runtime.ts";
import { configureHeapRigCatalog } from "./lib/gateway-heap-rig-catalog.mjs";
import { configureHeapRigTurns } from "./lib/gateway-heap-rig-turns.mjs";
import { createGatewayWsClient } from "./lib/gateway-ws-client.ts";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    minutes: { type: "string", default: "90" },
    sessions: { type: "string", default: "2000" },
    clients: { type: "string", default: "10" },
    port: { type: "string", default: "19548" },
    "rpc-interval-ms": { type: "string", default: "2000" },
    "turn-interval-ms": { type: "string", default: "180000" },
    "snapshot-minutes": { type: "string" },
    help: { type: "boolean" },
  },
});
if (values.help) {
  console.log(
    "node scripts/gateway-heap-rig.mjs --root .rig/node26 --minutes 90 [--sessions 2000 --clients 10 --port 19548 --snapshot-minutes 10,90]",
  );
  process.exit(0);
}
function positiveInteger(value, label) {
  if (!/^[1-9]\d*$/u.test(value ?? "") || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${label} must be a positive integer`);
  }
  return Number(value);
}
const minutes = positiveInteger(values.minutes, "minutes");
const sessionCount = positiveInteger(values.sessions, "sessions");
const clientCount = positiveInteger(values.clients, "clients");
const port = positiveInteger(values.port, "port");
const rpcInterval = positiveInteger(values["rpc-interval-ms"], "rpc-interval-ms");
const turnInterval = positiveInteger(values["turn-interval-ms"], "turn-interval-ms");
if (port < 19500 || port > 19597) {
  throw new Error("port and two adjacent mock ports must fit 19500–19599");
}
if (!values.root) {
  throw new Error("--root is required; it must name a new synthetic state directory");
}
const root = path.resolve(values.root);
const build = JSON.parse(readFileSync("dist/build-info.json", "utf8"));
const snapshotMinutes = (values["snapshot-minutes"] ?? `10,${minutes}`)
  .split(",")
  .map((v) => positiveInteger(v, "snapshot-minutes"));
if (snapshotMinutes.some((v, i) => v > minutes || (i > 0 && v - snapshotMinutes[i - 1] < 2))) {
  throw new Error("snapshot minutes must increase by at least two and fit the duration");
}
mkdirSync(path.dirname(root), { recursive: true });
mkdirSync(root); // Never reuse an operator directory or a previous run's databases.
const eventsPath = path.join(root, "measurements.jsonl");
const record = (event) => {
  const line = JSON.stringify({ time: new Date().toISOString(), ...event });
  appendFileSync(eventsPath, `${line}\n`);
  console.log(line);
};
const config = structuredClone(BASE_GATEWAY_BENCH_CONFIG);
config.cron = { enabled: true };
config.gateway.controlUi.allowedOrigins = [`http://127.0.0.1:${port}`];
config.memory = { search: { enabled: false } };
config.plugins.slots = { memory: "none" };
applyMockOpenAiModelConfig(config, { mockPort: port + 1 });
// Utility summaries must not consume the agent mock's ordered tool-response script.
config.models.providers["heap-rig-utility"] = {
  ...config.models.providers.openai,
  baseUrl: `http://127.0.0.1:${port + 2}/v1`,
};
config.agents.defaults.utilityModel = "heap-rig-utility/gpt-5.6-luna";
config.agents.defaults = {
  ...config.agents.defaults,
  skipBootstrap: true,
  skills: [],
  modelPolicy: {},
  systemAgent: { agentId: "main" },
};
config.agents.ownership = "explicit";
config.agents.entries = Object.fromEntries(
  ["main", "second"].map((id) => {
    const workspace = path.join(root, `workspace-${id}`);
    mkdirSync(workspace);
    // Git baseline discovery must not ascend into a checkout containing the live SQLite state.
    const gitInit = spawnSync(
      "git",
      ["init", "--quiet", "--template=", "--initial-branch=main", workspace],
      { encoding: "utf8" },
    );
    if (gitInit.status !== 0) {
      throw new Error(`Could not isolate synthetic workspace: ${gitInit.error ?? gitInit.stderr}`);
    }
    return [id, { workspace }];
  }),
);
const turnDriver = await configureHeapRigTurns(config, root, port + 1);
await configureHeapRigCatalog(config, root);
const configPath = path.join(root, "openclaw.json");
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
const env = createGatewayBenchEnv(root, configPath, {
  startupTrace: false,
  caseEnv: {
    ...turnDriver.env,
    OPENAI_API_KEY: "synthetic-heap-rig-not-a-real-key",
    PATH: `${path.dirname(process.execPath)}:${process.env.PATH}`,
    TMPDIR: root,
  },
});
const children = [];
const clients = new Set();
const requests = {};
const events = {};
const identities = Array.from({ length: clientCount }, () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const rawKey = publicKey.export({ format: "jwk" }).x;
  return {
    privateKey,
    publicKey: rawKey,
    instanceId: randomUUID(),
    deviceId: createHash("sha256").update(Buffer.from(rawKey, "base64url")).digest("hex"),
  };
});
const inFlight = new Set();
const unpausedWork = Promise.resolve();
let workloadReady = unpausedWork;
/** @type {Error | undefined} */
let failure;
const abort = new AbortController();
function fail(error) {
  failure ??= error instanceof Error ? error : new Error(String(error));
  abort.abort(failure);
}
const onSignal = () => fail(new Error("rig interrupted"));
process.once("SIGINT", onSignal);
process.once("SIGTERM", onSignal);
function start(args, label, extraEnv = {}) {
  const fd = openSync(path.join(root, `${label}.log`), "wx");
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env: { ...env, ...extraEnv },
    detached: true,
    stdio: ["ignore", fd, fd],
  });
  closeSync(fd);
  children.push(child);
  child.once("error", fail);
  child.once("exit", (code, signal) => {
    if (!abort.signal.aborted) {
      fail(new Error(`${label} exited: ${code ?? signal}`));
    }
  });
  record({ kind: "process", label, pid: child.pid, node: process.version, args });
  return child;
}
async function sleep(ms) {
  try {
    await delay(Math.max(0, ms), undefined, { signal: abort.signal });
  } catch (error) {
    if (!abort.signal.aborted) {
      throw error;
    }
  }
}
async function connect(protocol, identity) {
  const controlUi = Boolean(identity);
  const challenge = Promise.withResolvers();
  const client = createGatewayWsClient({
    url: `ws://127.0.0.1:${port}`,
    ...(controlUi ? { origin: `http://127.0.0.1:${port}` } : {}),
    onEvent: ({ event, payload }) => {
      events[event] = (events[event] ?? 0) + 1;
      if (event === "connect.challenge") {
        challenge.resolve(payload);
      }
    },
  });
  clients.add(client);
  const rpc = async (method, params, timeout = 180000) => {
    const work = client.request(method, params, timeout);
    inFlight.add(work);
    try {
      const result = await work;
      if (!result.ok) {
        throw new Error(`${method}: ${JSON.stringify(result.error)}`);
      }
      requests[method] = (requests[method] ?? 0) + 1;
      return result.payload;
    } finally {
      inFlight.delete(work);
    }
  };
  const close = () => {
    client.close();
    clients.delete(client);
  };
  try {
    await client.waitOpen();
    const scopes = ["operator.read", "operator.write", "operator.admin"];
    if (controlUi) {
      scopes.push("operator.approvals", "operator.questions", "operator.pairing");
    }
    const params = {
      minProtocol: protocol,
      maxProtocol: protocol,
      client: {
        id: controlUi ? "openclaw-control-ui" : "gateway-client",
        displayName: "synthetic-heap-rig",
        version: "1",
        ...(controlUi
          ? { buildId: build.buildId, instanceId: identity.instanceId, deviceFamily: "desktop" }
          : {}),
        platform: controlUi ? "web" : process.platform,
        mode: controlUi ? "webchat" : "backend",
      },
      role: "operator",
      scopes,
      caps: controlUi ? ["tool-events", "chat-only-assistant-text", "model-selection-policy"] : [],
    };
    if (identity) {
      const timer = setTimeout(
        () => challenge.reject(new Error("Missing connect challenge")),
        10000,
      );
      let nonce;
      try {
        ({ nonce } = await challenge.promise);
      } finally {
        clearTimeout(timer);
      }
      const signedAt = Date.now();
      const payload = buildDeviceAuthPayloadV3({
        deviceId: identity.deviceId,
        clientId: params.client.id,
        clientMode: params.client.mode,
        role: params.role,
        scopes,
        signedAtMs: signedAt,
        nonce,
        platform: params.client.platform,
        deviceFamily: params.client.deviceFamily,
      });
      params.device = {
        id: identity.deviceId,
        publicKey: identity.publicKey,
        signedAt,
        nonce,
        signature: sign(null, Buffer.from(payload), identity.privateKey).toString("base64url"),
      };
    }
    await rpc("connect", params);
    await rpc("sessions.subscribe", {});
    return { rpc, close };
  } catch (error) {
    close();
    throw error;
  }
}
const sessions = Array.from({ length: sessionCount }, (_, index) => {
  const agentId = index % 2 === 0 ? "main" : "second";
  return { agentId, key: `agent:${agentId}:heap-rig-${index}` };
});
let admin;
const tasks = [];
try {
  const { PROTOCOL_VERSION } = await import(
    pathToFileURL(path.resolve("dist/gateway/protocol/index.js")).href
  );
  start(["scripts/e2e/mock-openai-server.mjs"], "mock", {
    MOCK_PORT: String(port + 1),
    MOCK_BIND_HOST: "127.0.0.1",
  });
  start(["scripts/e2e/mock-openai-server.mjs"], "mock-utility", {
    MOCK_PORT: String(port + 2),
    MOCK_BIND_HOST: "127.0.0.1",
    MOCK_RESPONSE_CONTROL: "",
    MOCK_REQUEST_LOG: path.join(root, "mock-utility-requests.jsonl"),
    SUCCESS_MARKER: "Synthetic activity summary",
  });
  const gateway = start(["dist/index.js", "gateway", "--port", String(port)], "gateway");
  const startupDeadline = Date.now() + 600000;
  while (!admin && !abort.signal.aborted && Date.now() < startupDeadline) {
    try {
      admin = await connect(PROTOCOL_VERSION);
    } catch {
      await sleep(1000);
    }
  }
  if (!admin) {
    throw failure ?? new Error("Gateway readiness deadline exceeded; see gateway.log");
  }
  record({
    kind: "ready",
    pid: gateway.pid,
    node: process.version,
    v8: process.versions.v8,
    build,
    sessionCount,
    clientCount,
  });
  let nextSeed = 0;
  await Promise.all(
    Array.from({ length: Math.min(8, sessionCount) }, async () => {
      for (;;) {
        const index = nextSeed++;
        if (index >= sessions.length || abort.signal.aborted) {
          return;
        }
        const { key, agentId } = sessions[index];
        await admin.rpc("sessions.create", { key, agentId });
        await admin.rpc("chat.inject", {
          sessionKey: key,
          message: `Synthetic history ${index}. `.repeat(2048).slice(0, 32 * 1024),
        });
        if ((index + 1) % 250 === 0) {
          record({ kind: "seed", completed: index + 1 });
        }
      }
    }),
  );
  const inventory = await admin.rpc("sessions.list", { limit: 1, archived: "all" });
  if (inventory.totalCount < sessionCount) {
    throw new Error(`Seed inventory incomplete: ${inventory.totalCount}`);
  }
  record({ kind: "seeded", totalCount: inventory.totalCount, historyBytesPerSession: 32 * 1024 });
  const startedAt = performance.now();
  const deadline = startedAt + minutes * 60000;
  const samples = [];
  const floors = [];
  const snapshots = [];
  /** @type {Promise<unknown>} */
  let currentTurn = Promise.resolve();
  let floor;
  const floorWidthMs = 10 * 60_000;
  function finishFloor() {
    if (floor) {
      floors.push(floor);
      record({ kind: "heap-floor", ...floor, counts: { ...turnDriver.counts } });
      floor = undefined;
    }
  }
  async function sample() {
    const observation = await readGatewayMemory(admin.rpc, startedAt);
    samples.push(observation);
    const window = Math.floor(observation.atMs / floorWidthMs);
    if (floor && floor.window !== window) {
      finishFloor();
    }
    if (!floor) {
      const sampleInventory = await admin.rpc("sessions.list", { limit: 1, archived: "all" });
      floor = {
        window,
        startMinute: window * 10,
        endMinute: (window + 1) * 10,
        samples: 0,
        heapUsedMb: observation.heapUsedMb,
        atMs: observation.atMs,
        sessionCountAtStart: sampleInventory.totalCount,
      };
    }
    floor.samples++;
    if (observation.heapUsedMb < floor.heapUsedMb) {
      floor.heapUsedMb = observation.heapUsedMb;
      floor.atMs = observation.atMs;
    }
    record({
      kind: "sample",
      ...observation,
      requests: { ...requests },
      counts: { ...turnDriver.counts },
    });
  }
  async function snapshot(minute) {
    /** @type {PromiseWithResolvers<void>} */
    const pause = Promise.withResolvers();
    workloadReady = pause.promise;
    try {
      await currentTurn;
      await Promise.allSettled(inFlight);
      const result = await admin.rpc(
        "diagnostics.heapSnapshot",
        { reason: `synthetic retention rig minute ${minute}` },
        300000,
      );
      const entry = {
        kind: "snapshot",
        minute,
        atMs: performance.now() - startedAt,
        connectedClients: clients.size,
        ...result,
      };
      snapshots.push(entry);
      record(entry);
    } finally {
      workloadReady = unpausedWork;
      pause.resolve();
    }
  }
  for (let index = 0; index < clientCount; index++) {
    tasks.push(
      (async () => {
        let client;
        let reconnectAt = 0;
        let round = 0;
        try {
          while (!abort.signal.aborted && performance.now() < deadline) {
            await workloadReady;
            if (abort.signal.aborted || performance.now() >= deadline) {
              break;
            }
            if (!client || performance.now() >= reconnectAt) {
              client?.close();
              client = await connect(PROTOCOL_VERSION, identities[index]);
              reconnectAt = performance.now() + 180000 + index * 11000;
            }
            const selected =
              sessions[(Math.floor(round / 10) * clientCount + index) % sessions.length];
            const { key, agentId } = selected;
            const identity = { sessionKey: key, agentId };
            const calls = [
              [
                "sessions.list",
                {
                  limit: 100,
                  offset: (Math.floor(round / 10) * 100) % sessionCount,
                  archived: "all",
                  includeDerivedTitles: true,
                  includeLastMessage: true,
                  includeActivitySummary: true,
                },
              ],
              [
                "sessions.catalog.list",
                { agentId, limitPerHost: 100, progressId: randomUUID(), allowPartialResults: true },
              ],
              ["chat.history", { ...identity, limit: 100, maxBytes: 200000 }],
              ["chat.metadata", identity],
              ["models.list", { ...identity, includeDetails: true }],
              ["sessions.messages.subscribe", { key, agentId, subscriptionId: "rig-active" }],
              ["agent.identity.get", identity],
              ["cron.list", { includeDisabled: true, limit: 50, compact: true }],
              ["cron.status", {}],
              ["sessions.messages.unsubscribe", { key, agentId, subscriptionId: "rig-active" }],
            ];
            const [method, params] = calls[round++ % calls.length];
            const result = await client.rpc(method, params);
            if (method === "sessions.catalog.list") {
              const fixture = result.catalogs?.find((catalog) => catalog.id === "heap-rig-catalog");
              if (!fixture?.hosts?.some((host) => host.sessions.length > 0)) {
                throw new Error(
                  `Synthetic catalog returned no sessions: ${JSON.stringify(result)}`,
                );
              }
            }
            await sleep(rpcInterval);
          }
        } catch (error) {
          client?.close();
          throw error;
        }
        // Global cleanup closes successful clients after the final snapshot,
        // keeping the connection population equal in both heap captures.
      })().catch(fail),
    );
  }
  tasks.push(
    (async () => {
      for (let index = 0; !abort.signal.aborted && performance.now() < deadline; index++) {
        await workloadReady;
        if (abort.signal.aborted || performance.now() >= deadline) {
          break;
        }
        const turnWork = turnDriver.runTurn(admin.rpc, index, {
          agentId: index % 2 === 0 ? "main" : "second",
          canStart: () => !abort.signal.aborted && performance.now() < deadline,
        });
        currentTurn = turnWork;
        const turn = await turnWork;
        if (turn === null) {
          record({ kind: "turn-not-started", index, reason: "workload-ended" });
          break;
        }
        record({ ...turn, kind: "turn", turnKind: turn.kind, atMs: performance.now() - startedAt });
        await sleep(Math.min(turnInterval, deadline - performance.now()));
      }
    })().catch(fail),
  );
  await sample();
  let nextSnapshot = 0;
  for (let tick = 1; tick <= minutes * 6 && !abort.signal.aborted; tick++) {
    await sleep(startedAt + tick * 10_000 - performance.now());
    if (abort.signal.aborted) {
      break;
    }
    if (performance.now() < deadline) {
      await sample();
    }
    while (
      nextSnapshot < snapshotMinutes.length &&
      Math.max(tick * 10_000, performance.now() - startedAt) >=
        snapshotMinutes[nextSnapshot] * 60_000
    ) {
      await snapshot(snapshotMinutes[nextSnapshot++]);
    }
    // Snapshot writing can span several ticks; do not replay missed samples.
    tick = Math.max(tick, Math.floor((performance.now() - startedAt) / 10_000));
  }
  await currentTurn;
  finishFloor();
  if (failure) {
    throw failure;
  }
  record({
    kind: "complete",
    node: process.version,
    requests,
    events,
    counts: { ...turnDriver.counts },
    floors,
    snapshots: snapshots.map(({ path: file, heapUsedAfter, atMs }) => ({
      path: file,
      heapUsedAfter,
      atMs,
    })),
  });
  writeFileSync(
    path.join(root, "result.json"),
    `${JSON.stringify({ node: process.version, v8: process.versions.v8, build, pid: gateway.pid, minutes, sessionCount, clientCount, requests, events, samples, floors, snapshots, turns: turnDriver.evidence, counts: turnDriver.counts }, null, 2)}\n`,
  );
} catch (error) {
  record({ kind: "failed", error: String(error) });
  process.exitCode = 1;
} finally {
  abort.abort();
  for (const client of clients) {
    client.close();
  }
  await Promise.allSettled(tasks);
  for (const child of children.toReversed()) {
    record({
      kind: "cleanup",
      pid: child.pid,
      ...(await stopChild(child, { teardownGraceMs: 30000 })),
    });
  }
  process.removeListener("SIGINT", onSignal);
  process.removeListener("SIGTERM", onSignal);
}
