// Real CLI + WebSocket proof; external team-shape fixtures are never regenerated here.
// Source mode: node --import ./scripts/tsx.mjs scripts/perf/gateway-ui-rpc-measure.ts --help
// Tail-RPC proof: --method agents.list.capabilities --method sessions.branches.list
// --method talk.config --method progressCard.get --samples 1000 --no-counters.
// Use --entry dist/entry.js; add --profile --allocations for a separate allocation pass.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, connect as connectTcp, type Socket } from "node:net";
import { availableParallelism, loadavg } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { buildDeviceAuthPayloadV3 } from "../../packages/gateway-client/src/device-auth.ts";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.ts";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import {
  resolveGatewayLaunchAgentLabel,
  resolveGatewaySystemdServiceName,
  resolveGatewayWindowsTaskName,
} from "../../src/daemon/constants.ts";
import {
  publicKeyRawBase64UrlFromEd25519Pem,
  signEd25519Payload,
} from "../../src/infra/ed25519-signature.ts";
import { readBuildIdFromBuildInfoForModuleUrl } from "../../src/version.ts";
import { stopChild, stopGatewayGracefully } from "../lib/gateway-bench-child.ts";
import {
  buildGatewayBenchChildArgs,
  createGatewayBenchEnv,
  parsePositiveInt,
  parseNonNegativeInt,
  summarizeNumbers,
  waitForInitialProbe,
} from "../lib/gateway-bench-runtime.ts";
import { createGatewayWsClient } from "../lib/gateway-ws-client.ts";

const { values } = parseArgs({
  options: {
    sync: { type: "string" },
    side: { type: "string" },
    cohort: { type: "string" },
    root: { type: "string" },
    output: { type: "string" },
    entry: { type: "string", default: "src/entry.ts" },
    port: { type: "string", default: "41731" },
    samples: { type: "string" },
    warmup: { type: "string", default: "2" },
    "rtt-ms": { type: "string", default: "0" },
    "remote-ingress": { type: "boolean", default: false },
    "no-counters": { type: "boolean", default: false },
    "cron-pages": { type: "boolean", default: false },
    providers: { type: "string", default: "10" },
    models: { type: "string", default: "100" },
    "history-key": { type: "string", default: "agent:main:team-shape-session-0" },
    "history-limit": { type: "string", default: "80" },
    method: { type: "string", multiple: true },
    profile: { type: "boolean", default: false },
    allocations: { type: "boolean", default: false },
    "profile-samples": { type: "string", default: "5" },
    help: { type: "boolean", default: false },
  },
});
if (values.help) {
  console.log(`Usage: node --import ./scripts/tsx.mjs scripts/perf/gateway-ui-rpc-measure.ts \\
  --root <isolated-team-shape-dir> --output <new-output-dir> [options]
  --entry src/entry.ts|dist/entry.js  Real Gateway CLI; source mode uses the repository tsx loader.
  --samples 10 --warmup 2           Serial requests; cold first, warmup and measured kept separate.
  --rtt-ms 0|100                    TCP proxy delays each direction by half the RTT.
  --remote-ingress                 Paired token auth through trusted loopback proxy attribution; asserts compression.
  --no-counters                    Count JSON/socket operations only in separate first/counts samples.
  --cron-pages                     Measure 50-job Cron pages across 1,000 seeded jobs; defaults to and requires >=20 samples.
  --providers 10 --models 100       Synthetic config catalog: models per provider; no credentials.
  --history-key <key> --history-limit 80  Existing 2,000-message fixture; protocol pagination retained.
  --method <case>                  Repeatable case filter (case names appear in result JSON).
  --profile                       Main-isolate CPU profile per selected RPC case, outside timing samples.
  --allocations                   With --profile, sample allocations instead of CPU (separate diagnostic pass).
  --profile-samples 5              Requests per profile; synchronized profiles start after every timed cell.
  --sync <dir> --cohort <nonce> --side base|control|head
                                  Three live Gateways, serial setup and interleaved measured cells.
Seed with team-shape-fixture.ts: --sessions 1000 --runs 0 --cron 1000 --projects 0
  --transcript-mib 0 --long-transcript-entries 2000 --long-transcript-sessions 1.
The Gateway writes only isolated synthetic state. Generate each fixture at its final root;
cron storage keys are absolute, so copying an existing fixture does not preserve its job inventory.
Timing includes ordinary diagnostics observers; JSON and socket-write measurements are synchronous
main-isolate subsets, not disjoint handler phases. CPU profiles attribute residual shaping/framing.`);
  process.exit(0);
}
assert(values.root && values.output, "--root and --output are required");
assert(!values.allocations || values.profile, "--allocations requires --profile");
const root = path.resolve(values.root);
const output = path.resolve(values.output);
const entry = path.resolve(values.entry);
const checkout = path.dirname(path.dirname(entry));
assert(
  existsSync(path.join(checkout, "package.json")),
  "--entry must be a checkout src/entry.ts or dist/entry.js",
);
const port = parsePositiveInt(values.port, 41731, "--port");
assert(port >= 40000 && port < 65535, "isolated ports must be 40000..65534");
const samples = parsePositiveInt(values.samples, values["cron-pages"] ? 20 : 10, "--samples");
assert(!values["cron-pages"] || samples >= 20, "--cron-pages requires at least 20 samples");
const warmup = parseNonNegativeInt(values.warmup, 2, "--warmup");
const rttMs = parseNonNegativeInt(values["rtt-ms"], 0, "--rtt-ms");
const remoteIngress = values["remote-ingress"];
const profileSamples = parsePositiveInt(values["profile-samples"], 5, "--profile-samples");
const providerCount = parseNonNegativeInt(values.providers, 10, "--providers");
const modelsPerProvider = parsePositiveInt(values.models, 100, "--models");
const historyLimit = parsePositiveInt(values["history-limit"], 80, "--history-limit");
assert(
  samples <= 1000 &&
    warmup <= 100 &&
    rttMs <= 1000 &&
    profileSamples <= 1000 &&
    providerCount <= 100 &&
    modelsPerProvider <= 1000,
);
const rawFixture: unknown = JSON.parse(
  readFileSync(path.join(root, "team-shape-summary.json"), "utf8"),
);
assert(
  isRecord(rawFixture) && rawFixture.format === "openclaw-team-shape-v1",
  "team-shape fixture required",
);
const fixture = rawFixture;
const cronJobCount = Number(fixture.cronJobs);
assert(!values["cron-pages"] || cronJobCount >= 1000, "--cron-pages requires at least 1,000 jobs");
assert(existsSync(entry), `Gateway CLI entry missing: ${entry}`);
mkdirSync(output, { recursive: false });
const token = "synthetic-gateway-rpc-benchmark-token";
const cfg = JSON.parse(readFileSync(path.join(root, "openclaw.json"), "utf8"));
const origins = [port, port + 1].map((value) => `http://127.0.0.1:${value}`);
cfg.gateway = {
  ...cfg.gateway,
  port,
  auth: { mode: "token", token },
  controlUi: { enabled: false, allowedOrigins: origins },
  ...(remoteIngress ? { trustedProxies: ["127.0.0.1", "::1"] } : {}),
};
cfg.diagnostics = { ...cfg.diagnostics, enabled: true };
cfg.cron = { ...cfg.cron, enabled: true };
// Fixture copies retain absolute workspace/log paths; keep every writer in this side's copy.
cfg.logging = { ...cfg.logging, file: path.join(output, "gateway-file.log") };
for (const [agentId, agent] of Object.entries(cfg.agents?.entries ?? {})) {
  if (isRecord(agent)) {
    agent.workspace = path.join(root, "workspace", ...(agentId === "main" ? [] : [agentId]));
  }
}
if (cfg.agents?.defaults?.workspace) {
  cfg.agents.defaults.workspace = path.join(root, "workspace");
}
if (providerCount) {
  cfg.models = {
    ...cfg.models,
    mode: "merge",
    providers: {
      ...cfg.models?.providers,
      ...Object.fromEntries(
        Array.from({ length: providerCount }, (_provider, p) => [
          `rpc-bench-${p}`,
          {
            baseUrl: "http://127.0.0.1:1/v1",
            api: "openai-completions",
            models: Array.from({ length: modelsPerProvider }, (_model, m) => ({
              id: `synthetic-${m}`,
              name: `Synthetic model ${p}/${m}`,
              input: ["text"],
              reasoning: false,
              contextWindow: 128000,
              maxTokens: 8192,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            })),
          },
        ]),
      ),
    },
  };
}
const configPath = path.join(output, "openclaw.json");
writeFileSync(configPath, JSON.stringify(cfg), { mode: 0o600 });
const timeoutMs = 120000;
const channelName = "gateway-ui-rpc-measure";
type Event = {
  source: string;
  method?: string;
  phase?: string;
  firstResponse?: boolean;
  [key: string]: unknown;
};
type Metrics = {
  events: Event[];
  jsonStringifyMs?: number;
  jsonStringifyCount?: number;
  socketWriteMs?: number;
  socketWriteCount?: number;
  socketWriteBytes?: number;
  processCpuMs: number;
  mainThreadCpuMs: number;
  windowMs: number;
};
type Sample = {
  case: string;
  phase: string;
  roundTripMs: number;
  ok: boolean;
  payloadBytes: number;
  payloadSha256?: string;
  arrayCounts?: Record<string, number>;
  requestParams?: unknown;
  error?: unknown;
  server: Metrics;
};
type Peer = ReturnType<typeof createGatewayWsClient>;
let child: ChildProcess | undefined;
const peers = new Set<Peer>();
const negotiatedExtensions = new Set<string>();
const records: Sample[] = [];
let proxy: Awaited<ReturnType<typeof startProxy>> | undefined;
const pair = generateKeyPairSync("ed25519");
const publicKey = publicKeyRawBase64UrlFromEd25519Pem(
  pair.publicKey.export({ type: "spki", format: "pem" }),
);
const device = {
  id: createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("hex"),
  publicKey,
  privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }),
};
const buildId = readBuildIdFromBuildInfoForModuleUrl(pathToFileURL(entry).href) ?? "dev";
const rpcCases = [
  { id: "connect", method: "connect" },
  {
    id: "sessions.subscribe",
    method: "sessions.subscribe",
    params: {
      includeMessageBodies: false,
      rowMode: "sidebar",
      source: "sidebar",
      limit: 100,
      configuredAgentsOnly: true,
      excludeDock: true,
      includeGlobal: true,
      includeUnknown: true,
      includeDerivedTitles: true,
      includeLastMessage: true,
    },
  },
  {
    id: "sessions.messages.subscribe.initialHistory",
    method: "sessions.messages.subscribe",
    params: {
      key: values["history-key"],
      agentId: "main",
      initialHistory: { limit: historyLimit },
    },
  },
  {
    id: "sessions.list.sidebar",
    method: "sessions.list",
    params: {
      rowMode: "sidebar",
      source: "sidebar",
      configuredAgentsOnly: true,
      excludeDock: true,
      includeGlobal: true,
      includeUnknown: true,
      includeDerivedTitles: true,
      includeLastMessage: true,
    },
  },
  {
    id: "chat.history.tail",
    method: "chat.history",
    params: { sessionKey: values["history-key"], limit: historyLimit },
  },
  {
    id: "chat.history.older",
    method: "chat.history",
    params: { sessionKey: values["history-key"], limit: historyLimit, offset: historyLimit },
  },
  {
    id: "models.list.configured",
    method: "models.list",
    params: { agentId: "main", view: "configured" },
  },
  {
    id: "models.list.provider-config",
    method: "models.list",
    params: { agentId: "main", view: "provider-config" },
  },
  { id: "config.get", method: "config.get", params: {} },
  { id: "config.schema", method: "config.schema", params: {} },
  { id: "models.authStatus", method: "models.authStatus", params: { agentId: "main" } },
  { id: "system.info", method: "system.info", params: {} },
  { id: "talk.config", method: "talk.config", params: {} },
  {
    id: "sessions.branches.list",
    method: "sessions.branches.list",
    params: { sessionKey: values["history-key"], agentId: "main" },
  },
  {
    id: "progressCard.get",
    method: "progressCard.get",
    params: { sessionKey: values["history-key"], agentId: "main" },
  },
  {
    id: "agents.list.capabilities",
    method: "agents.list",
    params: { includeSessionPlacement: true },
  },
  {
    id: "cron.list.all",
    method: "cron.list",
    params: { includeDisabled: true, compact: true, limit: 50 },
  },
  {
    id: "cron.list.enabled",
    method: "cron.list",
    params: { includeDisabled: false, compact: true, limit: 50 },
  },
  {
    id: "cron.list.reverse",
    method: "cron.list",
    params: { includeDisabled: true, compact: true, limit: 50, sortBy: "name", sortDir: "desc" },
  },
];
const selected = rpcCases.filter(
  (candidate) => !values.method?.length || values.method.includes(candidate.id),
);
assert(
  selected.length &&
    (!values.method ||
      values.method.every((id) => selected.some((candidate) => candidate.id === id))),
  "unknown --method",
);

const sides = ["base", "control", "head"];
const sideIndex = sides.indexOf(values.side ?? "");
let syncRoot: string | undefined;
if (values.sync) {
  assert(
    sideIndex >= 0 && values.cohort && /^[a-zA-Z0-9_-]{1,80}$/.test(values.cohort),
    "--sync requires --side base|control|head and a fresh --cohort nonce",
  );
  syncRoot = path.join(path.resolve(values.sync), values.cohort);
  mkdirSync(syncRoot, { recursive: true });
  writeFileSync(
    path.join(syncRoot, `${values.side}.claim`),
    JSON.stringify({
      output,
      fingerprint: createHash("sha256")
        .update(
          JSON.stringify({
            selected,
            samples,
            warmup,
            rttMs,
            remoteIngress,
            noCounters: values["no-counters"],
            cronPages: values["cron-pages"],
            profile: values.profile,
            profileSamples,
            providerCount,
            modelsPerProvider,
          }),
        )
        .digest("hex"),
    }),
    { flag: "wx" },
  );
}
const marker = (name: string) => {
  if (syncRoot) {
    writeFileSync(path.join(syncRoot, `${values.side}.${name}`), "", { flag: "wx" });
  }
};
async function waitMarker(side: string, name: string) {
  if (!syncRoot) {
    return;
  }
  const deadline = Date.now() + (name === "setup" ? 600000 : 120000);
  const target = path.join(syncRoot, `${side}.${name}`);
  while (!existsSync(target)) {
    assert(
      !sides.some((candidate) => existsSync(path.join(syncRoot!, `${candidate}.failed`))),
      "Another cohort side failed; inspect its results.json",
    );
    assert(Date.now() < deadline, `Timed out awaiting ${side}.${name}`);
    await delay(50);
  }
}
function requestParams(candidate: (typeof rpcCases)[number], phase: string, round: number) {
  if (
    !values["cron-pages"] ||
    candidate.method !== "cron.list" ||
    candidate.id === "cron.list.enabled"
  ) {
    return candidate.params;
  }
  return {
    ...candidate.params,
    limit: phase === "warmup" ? 1 : 50,
    offset:
      phase === "first" ? 1 : phase === "counts" ? 2 : phase === "warmup" ? 0 : 50 * (round % 20),
  };
}
async function measureCase(
  candidate: (typeof rpcCases)[number],
  phase: string,
  peer: Peer,
  round = 0,
) {
  if (candidate.method === "connect") {
    const pending = await connectPeer();
    try {
      await measure(candidate.id, candidate.method, pending.params, pending.peer, phase);
    } finally {
      await closePeer(pending.peer);
    }
  } else {
    await measure(
      candidate.id,
      candidate.method,
      requestParams(candidate, phase, round),
      peer,
      phase,
    );
  }
}
async function control(action: string, extra: Record<string, unknown> = {}): Promise<Metrics> {
  assert(child?.connected, "Gateway IPC unavailable");
  const target = child;
  const id = randomUUID();
  return await new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      target.off("message", receive);
      target.off("exit", exited);
    };
    const exited = () => {
      cleanup();
      reject(new Error(`Gateway exited during ${action}`));
    };
    const receive = (raw: unknown) => {
      if (!isRecord(raw) || raw.channel !== channelName || raw.id !== id) {
        return;
      }
      cleanup();
      if (typeof raw.error === "string") {
        reject(new Error(raw.error));
      } else {
        resolve(raw.result as Metrics);
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`${action} timed out`));
    }, timeoutMs);
    target.on("message", receive);
    target.once("exit", exited);
    target.send({ channel: channelName, id, action, ...extra }, (error) => {
      if (error) {
        cleanup();
        reject(error);
      }
    });
  });
}
async function connectPeer(
  directPairing = false,
): Promise<{ peer: Peer; params: Record<string, unknown> }> {
  const challenge = Promise.withResolvers<{ nonce: string; ts: number }>();
  const clientPort = proxy && !directPairing ? port + 1 : port;
  const peer = createGatewayWsClient({
    url: `ws://127.0.0.1:${clientPort}`,
    origin: origins[proxy ? 1 : 0],
    ...(remoteIngress && !directPairing ? { headers: { "X-Forwarded-For": "203.0.113.1" } } : {}),
    openTimeoutMs: timeoutMs,
    handshakeTimeoutMs: timeoutMs,
    onEvent(event) {
      if (
        event.event === "connect.challenge" &&
        isRecord(event.payload) &&
        typeof event.payload.nonce === "string" &&
        typeof event.payload.ts === "number"
      ) {
        challenge.resolve({ nonce: event.payload.nonce, ts: event.payload.ts });
      }
    },
  });
  peers.add(peer);
  await peer.waitOpen();
  const expectedExtensions = remoteIngress && !directPairing ? "permessage-deflate" : "";
  assert.equal(
    peer.ws.extensions,
    expectedExtensions,
    "unexpected Gateway compression negotiation",
  );
  if (!directPairing) {
    negotiatedExtensions.add(peer.ws.extensions);
  }
  const timer = setTimeout(
    () => challenge.reject(new Error("connect challenge timed out")),
    timeoutMs,
  );
  let signed: Awaited<typeof challenge.promise>;
  try {
    signed = await challenge.promise;
  } finally {
    clearTimeout(timer);
  }
  const scopes = [
    "operator.admin",
    "operator.read",
    "operator.write",
    "operator.approvals",
    "operator.questions",
    "operator.pairing",
  ];
  const client = {
    id: "openclaw-control-ui",
    version: "synthetic",
    buildId,
    platform: "web",
    mode: "webchat",
    instanceId: "synthetic-rpc-bench",
  };
  const payload = buildDeviceAuthPayloadV3({
    deviceId: device.id,
    clientId: client.id,
    clientMode: client.mode,
    platform: client.platform,
    role: "operator",
    scopes,
    signedAtMs: signed.ts,
    token,
    nonce: signed.nonce,
  });
  return {
    peer,
    params: {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client,
      role: "operator",
      scopes,
      auth: { token },
      caps: [
        "hello-health-on-demand",
        "health-summary",
        "hello-presence-self",
        "session-scoped-events",
        "presence-deltas",
        "session-row-deltas",
        "roster-message-bodies-optional",
      ],
      device: {
        id: device.id,
        publicKey,
        signedAt: signed.ts,
        nonce: signed.nonce,
        signature: signEd25519Payload(device.privateKey, payload),
      },
    },
  };
}
async function measure(id: string, method: string, params: unknown, peer: Peer, phase: string) {
  await control("begin", {
    countOps: !values["no-counters"] || phase === "first" || phase === "counts",
  });
  const started = performance.now();
  let response: Awaited<ReturnType<Peer["request"]>>;
  try {
    response = await peer.request(method, params, timeoutMs);
  } catch (error) {
    records.push({
      case: id,
      phase,
      roundTripMs: performance.now() - started,
      ok: false,
      payloadBytes: 0,
      requestParams: method === "cron.list" ? params : undefined,
      error: String(error),
      server: await control("end"),
    });
    throw error;
  }
  const roundTripMs = performance.now() - started;
  const server = await control("end");
  records.push({
    case: id,
    phase,
    roundTripMs,
    ok: response.ok,
    payloadBytes: Buffer.byteLength(JSON.stringify(response.payload ?? null)),
    payloadSha256: createHash("sha256")
      .update(JSON.stringify(response.payload ?? null))
      .digest("hex"),
    requestParams: method === "cron.list" ? params : undefined,
    arrayCounts: isRecord(response.payload)
      ? Object.fromEntries(
          Object.entries(response.payload).flatMap(([key, value]) =>
            Array.isArray(value) ? [[key, value.length]] : [],
          ),
        )
      : {},
    error: response.error,
    server,
  });
  assert(response.ok, `${id}: ${JSON.stringify(response.error)}`);
  if (method === "sessions.subscribe") {
    const list = isRecord(response.payload) ? response.payload.list : undefined;
    assert(
      isRecord(list) && Array.isArray(list.sessions) && list.sessions.length > 0,
      `${id}: initial roster was empty`,
    );
  }
  if (method === "models.list" && providerCount > 0) {
    assert(
      isRecord(response.payload) &&
        Array.isArray(response.payload.models) &&
        response.payload.models.length >= providerCount * modelsPerProvider,
      `${id}: synthetic catalog was not loaded`,
    );
  }
  if (method === "cron.list" && id !== "cron.list.enabled") {
    const jobs = isRecord(response.payload) ? response.payload.jobs : undefined;
    const total = isRecord(response.payload) ? response.payload.total : undefined;
    const expectedLimit = isRecord(params) && typeof params.limit === "number" ? params.limit : 50;
    assert(
      Array.isArray(jobs) &&
        jobs.length === Math.min(expectedLimit, cronJobCount) &&
        typeof total === "number" &&
        (values["cron-pages"] ? total === cronJobCount : total >= cronJobCount),
      `${id}: seeded cron rows missing; generate the fixture at this exact root instead of copying its path-keyed SQLite store`,
    );
  }
  if (method === "sessions.messages.subscribe") {
    const initial = isRecord(response.payload) ? response.payload.initialHistory : undefined;
    assert(
      isRecord(initial) &&
        initial.ok === true &&
        isRecord(initial.payload) &&
        Array.isArray(initial.payload.messages) &&
        initial.payload.messages.length > 0,
      `${id}: initial history did not return messages`,
    );
  }
  if (method === "chat.history") {
    assert(
      isRecord(response.payload) &&
        Array.isArray(response.payload.messages) &&
        response.payload.messages.length > 0,
      `${id}: history fixture returned no messages`,
    );
  }
  assert(
    server.events.some(
      (event) =>
        event.source === "openclaw.gateway.rpc" &&
        event.method === method &&
        event.phase === "response",
    ),
    `${id}: missing response diagnostics`,
  );
}
async function closePeer(peer: Peer) {
  await new Promise<void>((resolve) => {
    if (peer.ws.readyState === peer.ws.CLOSED) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      peer.ws.terminate();
      resolve();
    }, 5000);
    peer.ws.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    peer.close();
  });
  peers.delete(peer);
}
async function startProxy() {
  const sockets = new Set<Socket>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const forward = (from: Socket, to: Socket) => {
    let waitingForDrain = false;
    from.on("data", (data) => {
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (!to.destroyed && !to.write(data) && !waitingForDrain) {
          waitingForDrain = true;
          from.pause();
          to.once("drain", () => {
            waitingForDrain = false;
            from.resume();
          });
        }
      }, rttMs / 2);
      timers.add(timer);
    });
    from.on("error", () => to.destroy());
    from.on("close", () => {
      sockets.delete(from);
      to.destroy();
    });
  };
  const server = createServer((incoming) => {
    const upstream = connectTcp({ host: "127.0.0.1", port });
    sockets.add(incoming);
    sockets.add(upstream);
    forward(incoming, upstream);
    forward(upstream, incoming);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port + 1, "127.0.0.1", () => resolve());
  });
  return {
    close: async () => {
      for (const timer of timers) {
        clearTimeout(timer);
      }
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
function summaries() {
  return Object.fromEntries(
    selected.map(({ id, method }) => {
      const rows = records.filter((row) => row.case === id && row.phase === "measured");
      const metric = (read: (sample: Sample) => number | undefined) => {
        const observations = rows
          .map(read)
          .filter((value): value is number => typeof value === "number");
        return observations.length
          ? {
              observations: observations.length,
              ...summarizeNumbers(observations),
              p99: observations.toSorted((a, b) => a - b)[
                Math.ceil(observations.length * 0.99) - 1
              ],
            }
          : undefined;
      };
      const rpcMetric = (phase: string, key: string) =>
        metric((sample) => {
          const value = sample.server.events.find(
            (event) =>
              event.method === method &&
              event.phase === phase &&
              (phase !== "response" || event.firstResponse !== false),
          )?.[key];
          return typeof value === "number" ? value : undefined;
        });
      return [
        id,
        {
          samples: rows.length,
          failures: rows.filter((row) => !row.ok).length,
          roundTripMs: metric((s) => s.roundTripMs),
          receiveToResponseMs: rpcMetric("response", "durationMs"),
          handlerMs: rpcMetric("handler", "durationMs"),
          admissionMs: rpcMetric("handler", "admissionMs"),
          queueWaitMs: rpcMetric("dispatch", "queueWaitMs"),
          responseBytes: rpcMetric("response", "responseBytes"),
          workerTasks: metric(
            (sample) =>
              sample.server.events.filter((event) => event.source === "openclaw.worker.task")
                .length,
          ),
          workerThreadCpuMs: metric((sample) => {
            const cpu = sample.server.events
              .filter((event) => event.source === "openclaw.worker.task")
              .map((event) => event.threadCpuMs);
            if (!cpu.every((value): value is number => typeof value === "number")) {
              return undefined;
            }
            return cpu.reduce((sum, value) => sum + value, 0);
          }),
          workerRunMs: metric((sample) =>
            sample.server.events.reduce(
              (sum, event) =>
                sum +
                (event.source === "openclaw.worker.task" && typeof event.runMs === "number"
                  ? event.runMs
                  : 0),
              0,
            ),
          ),
          ...Object.fromEntries(
            [
              "processCpuMs",
              "mainThreadCpuMs",
              "jsonStringifyMs",
              "jsonStringifyCount",
              "socketWriteMs",
              "socketWriteCount",
              "socketWriteBytes",
            ].map((key) => [
              key,
              metric((sample) => sample.server[key as keyof Metrics] as number),
            ]),
          ),
        },
      ];
    }),
  );
}
function assertWatcherHealthy() {
  const setupLog = readFileSync(path.join(output, "gateway.log"), "utf8");
  assert(
    !setupLog.includes("config hot-reload disabled") &&
      !setupLog.includes("watch observation worker stopped"),
    "Config watcher failed during setup; timing this Gateway would bypass live snapshot invalidation",
  );
}
let failure: Error | undefined;
let shutdown: Record<string, unknown> | undefined;
try {
  if (syncRoot && sideIndex > 0) {
    await waitMarker(sides[sideIndex - 1]!, "setup");
  }
  const stopPreload = new URL("../lib/gateway-bench-stop-preload.mjs", import.meta.url);
  stopPreload.searchParams.set("parentPid", String(process.pid));
  stopPreload.searchParams.set("entry", entry);
  const loader = path.join(checkout, "scripts", "tsx.mjs");
  const preload = fileURLToPath(new URL("./gateway-ui-rpc-preload.mjs", import.meta.url));
  const nodeArgs = ["--import", loader, "--import", preload, "--import", stopPreload.href];
  const log = createWriteStream(path.join(output, "gateway.log"));
  child = spawn(process.execPath, buildGatewayBenchChildArgs(entry, port, nodeArgs, "token"), {
    detached: true,
    cwd: checkout,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: createGatewayBenchEnv(path.join(root, "home"), configPath, {
      startupTrace: false,
      caseEnv: {
        OPENCLAW_STATE_DIR: root,
        TMPDIR: path.join(root, "tmp"),
        OPENCLAW_SKIP_CHANNELS: "1",
        NODE_DISABLE_COMPILE_CACHE: "1",
        TSX_TSCONFIG_PATH: path.join(checkout, "tsconfig.json"),
        OPENCLAW_PROFILE: `rpc-bench-${port}`,
        OPENCLAW_LAUNCHD_LABEL: resolveGatewayLaunchAgentLabel(`rpc-bench-${port}`),
        OPENCLAW_SYSTEMD_UNIT: resolveGatewaySystemdServiceName(`rpc-bench-${port}`),
        OPENCLAW_WINDOWS_TASK_NAME: resolveGatewayWindowsTaskName(`rpc-bench-${port}`),
        OPENCLAW_BENCH_RPC_PORT: String(port),
        OPENCLAW_BENCH_RPC_PARENT: String(process.pid),
        OPENCLAW_BENCH_RPC_ENTRY: entry,
      },
    }),
  });
  child.stdout?.pipe(log);
  child.stderr?.pipe(log);
  child.once("close", () => log.end());
  const ready = await waitForInitialProbe({
    port,
    path: "/readyz",
    startAt: performance.now(),
    deadlineAt: performance.now() + 600000,
    isDone: () => child?.exitCode !== null,
  });
  assert(
    ready.status === 200,
    `Gateway did not become ready; inspect ${path.join(output, "gateway.log")}`,
  );
  if (rttMs) {
    proxy = await startProxy();
  }
  // Auto-pair and warm authentication once, outside all measured requests.
  const setup = await connectPeer(true);
  const paired = await setup.peer.request("connect", setup.params, timeoutMs);
  assert(paired.ok, `synthetic device pairing failed: ${JSON.stringify(paired.error)}`);
  await closePeer(setup.peer);
  const connected = await connectPeer();
  const hello = await connected.peer.request("connect", connected.params, timeoutMs);
  assert(hello.ok, `connect setup failed: ${JSON.stringify(hello.error)}`);
  for (let index = 0; index <= warmup; index++) {
    for (const candidate of selected) {
      await measureCase(candidate, index === 0 ? "first" : "warmup", connected.peer);
    }
  }
  if (values["cron-pages"]) {
    for (const candidate of selected) {
      if (candidate.method === "cron.list" && candidate.id !== "cron.list.enabled") {
        await measureCase(candidate, "counts", connected.peer);
      }
    }
  }
  assertWatcherHealthy();
  marker("setup");
  if (syncRoot) {
    await waitMarker("head", "setup");
    const fingerprints = sides.map(
      (side) => JSON.parse(readFileSync(path.join(syncRoot!, `${side}.claim`), "utf8")).fingerprint,
    );
    assert(
      fingerprints.every((fingerprint) => fingerprint === fingerprints[0]),
      "Cohort workloads differ",
    );
  }
  let cell = 0;
  for (let index = 0; index < samples; index++) {
    for (const candidate of selected) {
      if (syncRoot) {
        if (sideIndex > 0) {
          await waitMarker(sides[sideIndex - 1]!, `cell-${cell}`);
        } else if (cell > 0) {
          await waitMarker("head", `cell-${cell - 1}`);
        }
      }
      await measureCase(candidate, "measured", connected.peer, index);
      marker(`cell-${cell}`);
      cell++;
    }
  }
  if (syncRoot) {
    // No side can start profiling until the head completes the final measured cell.
    await waitMarker("head", `cell-${cell - 1}`);
  }
  assertWatcherHealthy();
  for (const candidate of selected) {
    if (values.profile) {
      await control("profile-start", { allocations: values.allocations });
      try {
        for (let index = 0; index < profileSamples; index++) {
          if (candidate.method === "connect") {
            const pending = await connectPeer();
            try {
              assert((await pending.peer.request("connect", pending.params, timeoutMs)).ok);
            } finally {
              await closePeer(pending.peer);
            }
          } else {
            assert(
              (
                await connected.peer.request(
                  candidate.method,
                  requestParams(candidate, "profile", index),
                  timeoutMs,
                )
              ).ok,
            );
          }
        }
      } finally {
        await control("profile-stop", {
          allocations: values.allocations,
          path: path.join(
            output,
            `${candidate.id}.${values.allocations ? "heapprofile" : "cpuprofile"}`,
          ),
        });
      }
    }
    console.log(`${candidate.id}: ${samples} warm samples complete`);
  }
} catch (error) {
  failure =
    error instanceof Error ? error : new Error("Gateway benchmark failed", { cause: error });
  marker("failed");
} finally {
  for (const peer of peers) {
    await closePeer(peer);
  }
  await proxy?.close();
  if (child) {
    try {
      shutdown = { kind: "graceful", ...(await stopGatewayGracefully(child, 30000)) };
    } catch {
      shutdown = { kind: "process-tree-cleanup", ...(await stopChild(child)) };
    }
  }
  const report = {
    format: "openclaw-gateway-ui-rpc-v1",
    entry,
    checkout,
    cohort: syncRoot ? { nonce: values.cohort, side: values.side, root: syncRoot } : undefined,
    node: process.version,
    shutdown,
    host: {
      platform: process.platform,
      arch: process.arch,
      availableParallelism: availableParallelism(),
      loadavg: loadavg(),
    },
    workload: {
      fixture,
      samples,
      warmup,
      rttMs,
      remoteIngress,
      cronPages: values["cron-pages"],
      operationCounters: values["no-counters"]
        ? values["cron-pages"]
          ? "first-and-counts-only"
          : "first-sample-only"
        : "every-timed-window",
      profileSamples: values.profile ? profileSamples : 0,
      providerCount,
      modelsPerProvider,
      historyKey: values["history-key"],
      historyLimit,
    },
    measurement: {
      transport: "real Gateway CLI and WebSocket",
      ingress: remoteIngress ? "synthetic trusted loopback proxy" : "direct-local",
      negotiatedExtensions: [...negotiatedExtensions],
      serialTimedRequests: true,
      receiveToResponse:
        "existing gateway.rpc response duration: admitted frame receipt through socket acceptance; no TCP delivery wait",
      cpuScope:
        "whole per-request IPC window, including event-loop work and worker CPU; not only the handler",
      jsonScope: values["no-counters"]
        ? "first/counts samples only; native JSON/socket methods in warmup and measured samples"
        : "all synchronous main-isolate JSON.stringify calls in each request window, including shaping",
      framingScope:
        "socketWrite is native enqueue only; use CPU profiles for compression/header/segmentation attribution",
      profile: values.profile
        ? {
            samplesPerCase: profileSamples,
            kind: values.allocations ? "sampled-allocations" : "cpu",
            scope: "unmeasured per-case request loops; main isolate only",
            scheduling: syncRoot
              ? "concurrent across sides after every interleaved timed request completes"
              : "after every timed request completes",
          }
        : { enabled: false },
    },
    summaries: summaries(),
    records,
    ...(failure ? { error: failure.message } : {}),
  };
  writeFileSync(path.join(output, "results.json"), JSON.stringify(report, null, 2), {
    mode: 0o600,
  });
}
if (failure) {
  throw failure;
}
