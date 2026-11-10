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
import {
  BASE_GATEWAY_BENCH_CONFIG,
  createGatewayBenchEnv,
  waitForInitialProbe,
} from "./lib/gateway-bench-runtime.ts";
import { configureHeapRigCatalog } from "./lib/gateway-heap-rig-catalog.mjs";
import { prepareHeapRigFixture } from "./lib/gateway-heap-rig-fixture.mjs";
import { captureHeapRigRetention } from "./lib/gateway-heap-rig-retention.mjs";
import { configureHeapRigTurns } from "./lib/gateway-heap-rig-turns.mjs";
import { createGatewayWsClient } from "./lib/gateway-ws-client.ts";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    "runtime-root": { type: "string" },
    "fixture-gib": { type: "string" },
    "legacy-workshop": { type: "boolean" },
    "event-chars": { type: "string", default: "15000" },
    minutes: { type: "string", default: "90" },
    sessions: { type: "string", default: "2000" },
    clients: { type: "string", default: "10" },
    port: { type: "string", default: "41673" },
    "rpc-interval-ms": { type: "string", default: "2000" },
    "turn-interval-ms": { type: "string", default: "180000" },
    "snapshot-minutes": { type: "string" },
    "module-census": { type: "boolean" },
    coverage: { type: "boolean" },
    "lazy-import-trace": { type: "boolean" },
    "turn-count": { type: "string" },
    "fixed-turn-sessions": { type: "string" },
    "new-turn-sessions": { type: "string" },
    "turns-per-new-session": { type: "string", default: "3" },
    "retention-round-size": { type: "string" },
    "retention-snapshots": { type: "boolean" },
    "retention-mode": { type: "string", default: "retained" },
    "short-replies": { type: "boolean" },
    "large-session-events": { type: "string" },
    "restart-after-seed": { type: "boolean" },
    "gateway-preload": { type: "string" },
    "shell-turns": { type: "boolean" },
    "idle-minutes": { type: "string" },
    "ready-file": { type: "string" },
    "start-file": { type: "string" },
    help: { type: "boolean" },
  },
});
if (values.help) {
  console.log(
    "node scripts/gateway-heap-rig.mjs --root .rig/node26 --minutes 90 [--sessions 2000 --clients 10 --port 41673 --snapshot-minutes 10,90 --module-census --coverage --idle-minutes 5]\nFixed-session retention: --fixed-turn-sessions 8 --turn-count 80 --retention-round-size 10 --snapshot-minutes none --short-replies --retention-mode retained|allocation|timing\nNew idle sessions: --new-turn-sessions 1000 --turns-per-new-session 3 --retention-round-size 750 --snapshot-minutes none [--retention-snapshots --fixture-gib 35 (0 generates the small 5000-session fixture)]",
  );
  process.exit(0);
}
function positiveInteger(value, label) {
  if (!/^[1-9]\d*$/u.test(value ?? "") || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${label} must be a positive integer`);
  }
  return Number(value);
}
if (values.coverage && !values["module-census"]) {
  throw new Error("--coverage requires --module-census");
}
if (Boolean(values["ready-file"]) !== Boolean(values["start-file"])) {
  throw new Error("--ready-file and --start-file must be supplied together");
}
const fixtureGib =
  values["fixture-gib"] === undefined
    ? undefined
    : values["fixture-gib"] === "0"
      ? 0
      : positiveInteger(values["fixture-gib"], "fixture-gib");
const minutes = positiveInteger(values.minutes, "minutes");
const idleMinutes = values["idle-minutes"]
  ? positiveInteger(values["idle-minutes"], "idle-minutes")
  : 0;
const sessionCount = positiveInteger(values.sessions, "sessions");
const largeSessionEvents = values["large-session-events"]
  ? positiveInteger(values["large-session-events"], "large-session-events")
  : undefined;
if (largeSessionEvents && sessionCount !== 1) {
  throw new Error("--large-session-events requires --sessions 1");
}
const eventChars = positiveInteger(values["event-chars"], "event-chars");
if (
  largeSessionEvents &&
  (largeSessionEvents > 150000 || eventChars > 65536 || largeSessionEvents * eventChars > 600000000)
) {
  throw new Error("Synthetic fixture exceeds bounded investigation budget");
}
const clientCount = positiveInteger(values.clients, "clients");
const port = positiveInteger(values.port, "port");
const rpcInterval = positiveInteger(values["rpc-interval-ms"], "rpc-interval-ms");
const turnInterval = positiveInteger(values["turn-interval-ms"], "turn-interval-ms");
const newTurnSessions = values["new-turn-sessions"]
  ? positiveInteger(values["new-turn-sessions"], "new-turn-sessions")
  : 0;
const turnsPerNewSession = positiveInteger(
  values["turns-per-new-session"],
  "turns-per-new-session",
);
if (newTurnSessions && (turnsPerNewSession < 2 || turnsPerNewSession > 5 || values["turn-count"])) {
  throw new Error("New-session turns require 2–5 turns per session and determine turn-count");
}
const turnCount = newTurnSessions
  ? newTurnSessions * turnsPerNewSession
  : values["turn-count"]
    ? positiveInteger(values["turn-count"], "turn-count")
    : Infinity;
const fixedTurnSessions = values["fixed-turn-sessions"]
  ? positiveInteger(values["fixed-turn-sessions"], "fixed-turn-sessions")
  : 0;
const retentionRoundSize = values["retention-round-size"]
  ? positiveInteger(values["retention-round-size"], "retention-round-size")
  : 0;
if (newTurnSessions && (fixedTurnSessions || largeSessionEvents || !retentionRoundSize)) {
  throw new Error(
    "New sessions require retention rounds and cannot combine with fixed/large sessions",
  );
}
if (newTurnSessions && retentionRoundSize % turnsPerNewSession !== 0) {
  throw new Error("New-session checkpoints must follow complete session cohorts");
}
if (values["retention-snapshots"] && !retentionRoundSize) {
  throw new Error("retention-snapshots requires retention rounds");
}
if (
  fixedTurnSessions > sessionCount ||
  fixedTurnSessions > 64 ||
  (fixedTurnSessions && largeSessionEvents)
) {
  throw new Error(
    "Fixed turns require 1–64 seeded sessions and cannot combine with large-session-events",
  );
}
if (
  retentionRoundSize &&
  (!(fixedTurnSessions || newTurnSessions) || !Number.isFinite(turnCount) || turnCount > 10000)
) {
  throw new Error("Retention rounds require fixed/new sessions and at most 10000 turns");
}
if (!["retained", "allocation", "timing"].includes(values["retention-mode"])) {
  throw new Error("retention-mode must be retained, allocation, or timing");
}
if (port < 40000 || port > 65533) {
  throw new Error("port and two adjacent mock ports must fit 40000–65535");
}
if (!values.root) {
  throw new Error("--root is required; it must name a new synthetic state directory");
}
const root = path.resolve(values.root);
const runtimeRoot = path.resolve(values["runtime-root"] ?? ".");
const build = JSON.parse(readFileSync(path.join(runtimeRoot, "dist/build-info.json"), "utf8"));
const snapshotMinutes =
  values["snapshot-minutes"] === "none"
    ? []
    : (values["snapshot-minutes"] ?? `10,${minutes}`)
        .split(",")
        .map((v) => positiveInteger(v, "snapshot-minutes"));
if (snapshotMinutes.some((v, i) => v > minutes || (i > 0 && v - snapshotMinutes[i - 1] < 2))) {
  throw new Error("snapshot minutes must increase by at least two and fit the duration");
}
if (retentionRoundSize && snapshotMinutes.length) {
  throw new Error(
    "Retention rounds require --snapshot-minutes none; capture full snapshots separately",
  );
}
mkdirSync(path.dirname(root), { recursive: true });
mkdirSync(root, { mode: 0o700 }); // Never reuse an operator directory or a previous run's databases.
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
// Background reviews share the agent model and would consume its ordered tool fixtures.
if (values["legacy-workshop"]) {
  // The release predates the Workshop plugin cutover. Keep the workload disabled there too.
  config.skills = { ...config.skills, workshop: { autonomous: { mode: "off" } } };
} else {
  config.plugins.entries = {
    ...config.plugins.entries,
    "skill-workshop": { config: { autonomous: { mode: "off" } } },
  };
  config.meta = {
    ...config.meta,
    migrations: { ...config.meta?.migrations, skillWorkshopPlugin: true },
  };
}
applyMockOpenAiModelConfig(config, { mockPort: port + 1 });
if (fixedTurnSessions || newTurnSessions) {
  for (const model of config.models.providers.openai.models) {
    model.compat = { supportsInstructions: true, supportsResponsesContinuation: true };
  }
}
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
if (values["shell-turns"]) {
  config.tools.exec = { security: "full", ask: "off" };
}
await configureHeapRigCatalog(config, root);
const configPath = path.join(root, "openclaw.json");
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
const env = createGatewayBenchEnv(root, configPath, {
  startupTrace: false,
  caseEnv: {
    ...turnDriver.env,
    ...(largeSessionEvents ? { MOCK_REQUEST_LOG: "" } : {}),
    OPENAI_API_KEY: "synthetic-heap-rig-not-a-real-key",
    OPENCLAW_PROFILE: `heap-rig-${port}`,
    OPENCLAW_SYSTEMD_UNIT: `openclaw-heap-rig-${port}`,
    PATH: `${path.dirname(process.execPath)}:${process.env.PATH}`,
    TMPDIR: root,
  },
});
const stateFixture =
  fixtureGib === undefined
    ? undefined
    : await prepareHeapRigFixture({ gib: fixtureGib, port, env, sourceRoot: runtimeRoot });
if (stateFixture) {
  record({ kind: "fixture-seeded", ...stateFixture });
}
const children = [];
const expectedStops = new Set();
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
    stdio: [
      "ignore",
      fd,
      fd,
      ...(label.startsWith("gateway") && (values["module-census"] || retentionRoundSize)
        ? ["ipc"]
        : []),
    ],
  });
  closeSync(fd);
  children.push(child);
  child.once("error", fail);
  child.once("exit", (code, signal) => {
    if (!abort.signal.aborted && !expectedStops.has(child)) {
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
  return { agentId, key: `agent:${agentId}:heap-rig-${index}`, sessionId: undefined };
});
let admin;
const tasks = [];
try {
  const { PROTOCOL_VERSION } = await import(
    pathToFileURL(path.join(runtimeRoot, "dist/gateway/protocol/index.js")).href
  );
  start(["scripts/e2e/mock-openai-server.mjs"], "mock", {
    MOCK_PORT: String(port + 1),
    MOCK_BIND_HOST: "127.0.0.1",
  });
  start(["scripts/e2e/mock-openai-server.mjs"], "mock-utility", {
    MOCK_PORT: String(port + 2),
    MOCK_BIND_HOST: "127.0.0.1",
    MOCK_RESPONSE_CONTROL: "",
    MOCK_REQUEST_LOG: largeSessionEvents ? "" : path.join(root, "mock-utility-requests.jsonl"),
    SUCCESS_MARKER: "Synthetic activity summary",
  });
  const coldStarted = performance.now();
  const gatewayArgs = [
    ...(retentionRoundSize
      ? ["--import", path.resolve("scripts/perf/gateway-retention-round-preload.mjs")]
      : []),
    ...(values["gateway-preload"] ? ["--import", path.resolve(values["gateway-preload"])] : []),
    ...(values["lazy-import-trace"]
      ? ["--import", path.resolve("scripts/perf/lazy-import-trace-preload.mjs")]
      : []),
    ...(values["module-census"]
      ? ["--import", path.resolve("scripts/perf/main-module-census-preload.mjs")]
      : []),
    path.join(runtimeRoot, "dist/index.js"),
    "gateway",
    "--port",
    String(port),
  ];
  const gatewayEnv = values["lazy-import-trace"]
    ? { OPENCLAW_LAZY_IMPORT_TRACE_DIR: path.join(root, "lazy-import-trace") }
    : {};
  let gateway = start(gatewayArgs, "gateway", gatewayEnv);
  async function census(action, label) {
    if (!values["module-census"]) {
      return;
    }
    const id = randomUUID();
    const output = path.join(root, `modules-${label}.json`);
    const reply = Promise.withResolvers();
    const listener = (message) => {
      if (message?.channel === "main-module-census" && message.id === id) {
        if (message.error) {
          reply.reject(new Error(message.error));
        } else {
          reply.resolve(message);
        }
      }
    };
    gateway.on("message", listener);
    const timeout = setTimeout(() => reply.reject(new Error("Module census timed out")), 120000);
    try {
      gateway.send({ channel: "main-module-census", id, action, output });
      record({ kind: "module-census", label, ...(await reply.promise), output });
    } finally {
      clearTimeout(timeout);
      gateway.off("message", listener);
    }
  }
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
  const readiness = await waitForInitialProbe({
    port,
    path: "/startupz",
    startAt: performance.now(),
    deadlineAt: performance.now() + 120000,
  });
  if (readiness.status !== 200) {
    throw new Error("Gateway startup readiness did not complete");
  }
  record({
    kind: "ready",
    coldStartMs: performance.now() - coldStarted,
    pid: gateway.pid,
    node: process.version,
    v8: process.versions.v8,
    build,
    sessionCount,
    clientCount,
  });
  let nextSeed = 0;
  let largeSessionId;
  let completedLargeSessionTurns = 0;
  await Promise.all(
    Array.from({ length: Math.min(8, sessionCount) }, async () => {
      for (;;) {
        const index = nextSeed++;
        if (index >= sessions.length || abort.signal.aborted) {
          return;
        }
        const { key, agentId } = sessions[index];
        const created = await admin.rpc("sessions.create", { key, agentId });
        if (fixedTurnSessions && index < fixedTurnSessions) {
          if (!created.sessionId) {
            throw new Error("Fixed-session seed did not return a session ID");
          }
          sessions[index].sessionId = created.sessionId;
        }
        if (largeSessionEvents) {
          if (!created.sessionId) {
            throw new Error("Large-session seed did not return a session ID");
          }
          largeSessionId = created.sessionId;
        }
        const eventCount = largeSessionEvents ?? 1;
        for (let event = 0; event < eventCount; event++) {
          await admin.rpc("chat.inject", {
            sessionKey: key,
            message: largeSessionEvents
              ? `Synthetic history ${event}. `.padEnd(eventChars, "x")
              : `Synthetic history ${index}. `.repeat(2048).slice(0, 32 * 1024),
          });
          if ((event + 1) % 500 === 0) {
            record({ kind: "large-session-seed", completed: event + 1 });
          }
        }
        if ((index + 1) % 250 === 0) {
          record({ kind: "seed", completed: index + 1 });
        }
      }
    }),
  );
  const inventory = await admin.rpc("sessions.list", { limit: 1, archived: "all" });
  if (inventory.totalCount < sessionCount + (stateFixture?.sessionCount ?? 0)) {
    throw new Error(`Seed inventory incomplete: ${inventory.totalCount}`);
  }
  record({
    kind: "seeded",
    totalCount: inventory.totalCount,
    historyEventsPerSession: largeSessionEvents ?? 1,
    historyBytesPerSession: largeSessionEvents ? largeSessionEvents * eventChars : 32 * 1024,
  });
  if (values["restart-after-seed"]) {
    admin.close();
    admin = undefined;
    expectedStops.add(gateway);
    record({
      kind: "seed-restart",
      pid: gateway.pid,
      ...(await stopChild(gateway, { teardownGraceMs: 30000 })),
    });
    gateway = start(gatewayArgs, "gateway-restarted", gatewayEnv);
    const restartDeadline = Date.now() + 600000;
    while (!admin && !abort.signal.aborted && Date.now() < restartDeadline) {
      try {
        admin = await connect(PROTOCOL_VERSION);
      } catch {
        await sleep(1000);
      }
    }
    if (!admin) {
      throw failure ?? new Error("Seeded Gateway restart failed");
    }
    const restartedReadiness = await waitForInitialProbe({
      port,
      path: "/startupz",
      startAt: performance.now(),
      deadlineAt: performance.now() + 120000,
    });
    if (restartedReadiness.status !== 200) {
      throw new Error("Restarted Gateway startup readiness did not complete");
    }
    record({ kind: "seed-restarted", pid: gateway.pid });
  }
  await census("capture", "seeded");
  if (values["ready-file"]) {
    writeFileSync(
      values["ready-file"],
      JSON.stringify({ pid: process.pid, gatewayPid: gateway.pid }),
    );
    let startAt;
    while (!abort.signal.aborted) {
      try {
        startAt = positiveInteger(readFileSync(values["start-file"], "utf8").trim(), "start-file");
        break;
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error;
        }
        await sleep(100);
      }
    }
    if (abort.signal.aborted || startAt <= Date.now()) {
      throw new Error("Preparation missed the workload start; discard the run");
    }
    await sleep(startAt - Date.now());
  }
  if (values.coverage) {
    await census("coverage-start", "workload");
  }
  const startedAt = performance.now();
  const deadline = startedAt + minutes * 60000;
  const samples = [];
  const floors = [];
  const snapshots = [];
  const retentionRounds = [];
  let completedFixedTurns = 0;
  let fixedWorkComplete = false;
  let promptBytes = 0;
  let replyBytes = 0;
  let idleParents = 0;
  let currentNewSessionId;
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
    await workloadReady;
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
  async function retentionCheckpoint(action) {
    const pause = Promise.withResolvers();
    workloadReady = pause.promise;
    try {
      while (inFlight.size) {
        await Promise.allSettled(inFlight);
      }
      const observation = await captureHeapRigRetention(
        gateway,
        action,
        values["retention-mode"],
        values["retention-snapshots"]
          ? path.join(root, `retention-${retentionRounds.length}.heapsnapshot`)
          : undefined,
      );
      const entry = {
        kind: "retention-round",
        completedTurns: completedFixedTurns,
        fixedTurnSessions,
        idleParents,
        idleChildren: turnDriver.counts.keptChildren,
        codeFailures: turnDriver.counts.codeFailures,
        promptBytes,
        replyBytes,
        historyNote:
          "Canonical history grows by these payload bytes; sampled survivors are not net growth.",
        ...observation,
      };
      retentionRounds.push(entry);
      record(entry);
    } finally {
      workloadReady = unpausedWork;
      pause.resolve();
    }
  }
  if (retentionRoundSize) {
    await retentionCheckpoint("start");
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
            if (abort.signal.aborted || fixedWorkComplete || performance.now() >= deadline) {
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
      for (
        let index = 0;
        index < turnCount && !abort.signal.aborted && performance.now() < deadline;
        index++
      ) {
        await workloadReady;
        if (abort.signal.aborted || performance.now() >= deadline) {
          break;
        }
        const newSessionIndex = Math.floor(index / turnsPerNewSession);
        const newSessionTurn = index % turnsPerNewSession;
        const turnWork = turnDriver.runTurn(admin.rpc, index, {
          agentId: largeSessionEvents ? "main" : index % 2 === 0 ? "main" : "second",
          ...(largeSessionEvents ? { sessionKey: sessions[0].key, kind: "text" } : {}),
          ...(fixedTurnSessions
            ? {
                sessionKey: sessions[index % fixedTurnSessions].key,
                agentId: sessions[index % fixedTurnSessions].agentId,
                kind: "text",
                shortReply: values["short-replies"],
              }
            : {}),
          ...(newTurnSessions
            ? {
                sessionKey: `agent:main:heap-rig-new-${newSessionIndex}`,
                agentId: "main",
                kind: newSessionTurn === 0 ? "subagent" : newSessionTurn === 1 ? "code" : "text",
                codeFailure: newSessionTurn === 1,
                retainSession: true,
                shortReply: true,
              }
            : {}),
          canStart: () => !abort.signal.aborted && performance.now() < deadline,
          shell: values["shell-turns"],
        });
        currentTurn = turnWork;
        const turn = await turnWork;
        if (turn === null) {
          record({ kind: "turn-not-started", index, reason: "workload-ended" });
          break;
        }
        if (largeSessionEvents) {
          if (turn.sessionId !== largeSessionId) {
            throw new Error("Large-session turn replaced the seeded session");
          }
          completedLargeSessionTurns++;
        }
        record({ ...turn, kind: "turn", turnKind: turn.kind, atMs: performance.now() - startedAt });
        if (fixedTurnSessions || newTurnSessions) {
          if (
            fixedTurnSessions &&
            turn.sessionId !== sessions[index % fixedTurnSessions].sessionId
          ) {
            throw new Error("Fixed-session turn replaced the seeded physical session");
          }
          if (newTurnSessions) {
            if (newSessionTurn === 0) {
              currentNewSessionId = turn.sessionId;
            } else if (turn.sessionId !== currentNewSessionId) {
              throw new Error("New-session cohort replaced its physical session between turns");
            }
          }
          if (newTurnSessions && newSessionTurn === turnsPerNewSession - 1) {
            idleParents++;
          }
          completedFixedTurns++;
          promptBytes += turn.promptBytes;
          replyBytes += turn.replyBytes;
          if (
            retentionRoundSize &&
            (completedFixedTurns % retentionRoundSize === 0 || completedFixedTurns === turnCount)
          ) {
            await retentionCheckpoint("capture");
          }
          if (completedFixedTurns === turnCount) {
            fixedWorkComplete = true;
            break;
          }
        }
        await sleep(Math.min(turnInterval, deadline - performance.now()));
      }
    })().catch(fail),
  );
  await sample();
  let nextSnapshot = 0;
  for (let tick = 1; tick <= minutes * 6 && !abort.signal.aborted; tick++) {
    await sleep(startedAt + tick * 10_000 - performance.now());
    if (abort.signal.aborted || fixedWorkComplete) {
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
  if (fixedTurnSessions || newTurnSessions) {
    await Promise.all(tasks);
  }
  finishFloor();
  if (failure) {
    throw failure;
  }
  if ((fixedTurnSessions || newTurnSessions) && completedFixedTurns !== turnCount) {
    throw new Error(`Session workload completed ${completedFixedTurns}/${turnCount} turns`);
  }
  if (
    newTurnSessions &&
    (idleParents !== newTurnSessions ||
      turnDriver.counts.keptChildren !== newTurnSessions ||
      turnDriver.counts.codeFailures !== newTurnSessions ||
      turnDriver.counts.deleted !== 0 ||
      turnDriver.counts.archived !== 0)
  ) {
    throw new Error(
      "New-session workload did not preserve every parent, child and Code Mode failure",
    );
  }
  if (largeSessionEvents && completedLargeSessionTurns === 0) {
    throw new Error("Large-session run completed no turns");
  }
  if (
    largeSessionEvents &&
    Number.isFinite(turnCount) &&
    completedLargeSessionTurns !== turnCount
  ) {
    throw new Error(`Large-session run completed ${completedLargeSessionTurns}/${turnCount} turns`);
  }
  await census("capture", "complete");
  if (idleMinutes) {
    await Promise.all(tasks);
    for (let minute = 1; minute <= idleMinutes; minute++) {
      await sleep(60000);
      if (failure) {
        throw new Error("Idle observation interrupted", { cause: failure });
      }
      await census("stats", `idle-${minute}`);
      if (retentionRoundSize) {
        await retentionCheckpoint("capture");
      }
    }
    if (snapshotMinutes.length > 0) {
      await snapshot(minutes + idleMinutes);
    }
    await census("capture", "idle");
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
    `${JSON.stringify({ node: process.version, v8: process.versions.v8, build, pid: gateway.pid, minutes, sessionCount, clientCount, requests, events, samples, floors, snapshots, retentionRounds, turns: turnDriver.evidence, counts: turnDriver.counts }, null, 2)}\n`,
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
