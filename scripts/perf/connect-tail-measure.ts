// Measure successful connects against a built Gateway and an existing synthetic Team fixture:
// node --import ./scripts/tsx.mjs scripts/perf/connect-tail-measure.ts --state-dir <fixture>
//   --entry <build>/dist/entry.js --output <new-results-dir> --port 41994
//   --auth trusted-proxy --samples 1000 --identities 65
//   --clients 65 --warmup-ms 60000 --poll-ms 25000 --identity-prefix connect-tail
// Repeat against base/candidate with the same fixture; first visits and warm visits are separate.
// First visit means first in this run, not necessarily a newly created durable profile.
// Use separate equivalently seeded fixtures to compare genuinely cold profile creation.
// The child runs built JS directly: do not forward the controller's tsx loader to it.
// Persistent clients poll sidebar lists; connect setup and warmup are excluded from samples.
// --gateway-preload <native.mjs> adds optional native diagnostic instrumentation, never tsx.
// This reports response latency and logged phases. connect-tail-preload.mjs also records full handler time.
// --device-role operator|node signs device challenges; --seed-devices replaces the offline fixture
// pairing records with approved devices whose old token issuer forces fresh issuance.
// --interval-ms spaces reconnects; use >=1000 first/warm samples before interpreting p99.
// --auth cloudflare --identity-delay-ms 250 injects synthetic Access/GitHub responses in the
// child (all other non-loopback fetches fail). Roles force identity preparation before hello.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { once, setMaxListeners } from "node:events";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { availableParallelism, loadavg } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { buildDeviceAuthPayloadV3 } from "../../packages/gateway-client/src/device-auth.ts";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.ts";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import type { OpenClawConfig } from "../../src/config/types.openclaw.ts";
import type { OperatorScope } from "../../src/gateway/operator-scopes.ts";
import {
  publicKeyRawBase64UrlFromEd25519Pem,
  signEd25519Payload,
} from "../../src/infra/ed25519-signature.ts";
import { readBuildIdFromBuildInfoForModuleUrl } from "../../src/version.ts";
import { stopChild, stopGatewayGracefully } from "../lib/gateway-bench-child.ts";
import { createGatewayBenchEnv, waitForInitialProbe } from "../lib/gateway-bench-runtime.ts";
import { createGatewayWsClient } from "../lib/gateway-ws-client.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";
import { TEAM_STRESS_PLUGIN_IDS } from "./team-shape-stress-fixture.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    entry: { type: "string", default: "dist/entry.js" },
    output: { type: "string" },
    port: { type: "string", default: "41994" },
    auth: { type: "string", default: "password" },
    samples: { type: "string", default: "1000" },
    identities: { type: "string", default: "1" },
    "identity-prefix": { type: "string", default: "connect-tail" },
    clients: { type: "string", default: "65" },
    "warmup-ms": { type: "string", default: "60000" },
    "poll-ms": { type: "string", default: "25000" },
    "gateway-preload": { type: "string" },
    "device-role": { type: "string" },
    "interval-ms": { type: "string", default: "0" },
    "seed-devices": { type: "boolean", default: false },
    "identity-delay-ms": { type: "string", default: "0" },
  },
});
assert(values["state-dir"] && values.output, "--state-dir and --output are required");
assert(["password", "trusted-proxy", "cloudflare"].includes(values.auth), "unknown --auth mode");
const cloudflare = values.auth === "cloudflare";
assert(
  !values["device-role"] ||
    (values.auth === "password" && ["operator", "node"].includes(values["device-role"])),
  "--device-role operator|node requires password auth",
);
const integer = (raw: string, label: string, min: number) =>
  parseStrictIntegerOption({ raw, label, min, fallback: min });
const port = integer(values.port, "--port", 40000);
assert(port <= 65535, "use an isolated port in 40000–65535");
const sampleCount = integer(values.samples, "--samples", 1);
const identityCount = integer(values.identities, "--identities", 1);
const devices = values["device-role"]
  ? Array.from({ length: identityCount }, () => {
      const pair = generateKeyPairSync("ed25519");
      const publicKey = publicKeyRawBase64UrlFromEd25519Pem(
        pair.publicKey.export({ type: "spki", format: "pem" }),
      );
      return {
        publicKey,
        id: createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("hex"),
        privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }),
      };
    })
  : [];
const clientCount = integer(values.clients, "--clients", 0);
const warmupMs = integer(values["warmup-ms"], "--warmup-ms", 0);
const pollMs = integer(values["poll-ms"], "--poll-ms", 1);
const intervalMs = integer(values["interval-ms"], "--interval-ms", 0);
const identityDelayMs = integer(values["identity-delay-ms"], "--identity-delay-ms", 0);
assert(identityDelayMs <= 4_000, "--identity-delay-ms must not exceed 4000");
assert(cloudflare || identityDelayMs === 0, "--identity-delay-ms requires --auth cloudflare");
const identityPrefix = values["identity-prefix"];
assert(
  /^[a-z0-9][a-z0-9-]{0,47}$/iu.test(identityPrefix),
  "use a short alphanumeric --identity-prefix",
);
const stateDir = path.resolve(values["state-dir"]);
const output = path.resolve(values.output);
const entry = path.resolve(values.entry);
assert(existsSync(entry), `Build the Gateway before measuring: ${entry}`);
const fixture: unknown = JSON.parse(
  readFileSync(path.join(stateDir, "team-shape-summary.json"), "utf8"),
);
assert(
  isRecord(fixture) && fixture.format === "openclaw-team-shape-v1",
  "synthetic fixture required",
);
if (values["seed-devices"]) {
  assert(devices.length > 0, "--seed-devices requires --device-role");
  const role = values["device-role"]!;
  const approvedScopes =
    role === "node" ? [] : ["operator.admin", "operator.read", "operator.write"];
  // The caller owns this offline fixture. An old issuer forces fresh issuance after password auth.
  process.env.OPENCLAW_STATE_DIR = stateDir;
  const store = await import("../../src/infra/device-pairing-store.ts");
  const database = await import("../../src/state/openclaw-state-db.ts");
  store.persistDevicePairingStoreState(
    {
      pendingById: {},
      pairedByDeviceId: Object.fromEntries(
        devices.map((device) => [
          device.id,
          {
            deviceId: device.id,
            publicKey: device.publicKey,
            platform: "linux",
            clientId: role === "node" ? "node-host" : "cli",
            clientMode: role === "node" ? "node" : "cli",
            roles: [role],
            scopes: approvedScopes,
            approvedScopes,
            tokens: {
              [role]: {
                token: "synthetic-old-issuer-token",
                role,
                scopes: approvedScopes,
                issuer: {
                  kind: "shared-gateway-auth" as const,
                  generation: "synthetic-old-generation",
                },
                createdAtMs: 1,
              },
            },
            createdAtMs: 1,
            approvedAtMs: 1,
            ...(role === "node"
              ? { nodeSurface: { caps: [], commands: [], createdAtMs: 1, approvedAtMs: 1 } }
              : {}),
          },
        ]),
      ),
    },
    stateDir,
    "both",
  );
  await database.closeOpenClawStateDatabaseAsync();
}
const buildId = readBuildIdFromBuildInfoForModuleUrl(pathToFileURL(entry).href);
assert(buildId, "compiled build identity required");
const reservation = createServer();
await new Promise<void>((resolve, reject) => {
  reservation.once("error", reject);
  reservation.listen(port, "127.0.0.1", resolve);
});
await new Promise<void>((resolve, reject) => {
  reservation.close((error) => (error ? reject(error) : resolve()));
});
mkdirSync(output, { recursive: false });
mkdirSync(path.join(output, "tmp"));
const configPath = path.join(output, "openclaw.json");
const password = "synthetic-connect-tail-password";
const origin = "https://connect-tail.example";
const identities = Array.from(
  { length: identityCount },
  (_, i) => `${identityPrefix}-sample-${i}@example.com`,
);
const residentIdentities = Array.from(
  { length: clientCount },
  (_, i) => `${identityPrefix}-resident-${i}@example.com`,
);
const allowedIdentities = [...identities, ...residentIdentities];
const assertions = new Map(
  allowedIdentities.map((email, index) => [
    email,
    `synthetic.${Buffer.from(
      JSON.stringify({
        iss: "https://connect-profile.cloudflareaccess.com",
        exp: Math.floor(Date.now() / 1_000) + 3_600,
        email,
        accountId: index + 1,
      }),
    ).toString("base64url")}.synthetic`,
  ]),
);
const scopes: OperatorScope[] = ["operator.admin", "operator.read", "operator.write"];
const cfg: OpenClawConfig = JSON.parse(readFileSync(path.join(stateDir, "openclaw.json"), "utf8"));
const agentIds = ["main", "reviewer", "researcher", "planner"];
cfg.agents = {
  ...cfg.agents,
  ownership: "explicit",
  defaults: {
    ...cfg.agents?.defaults,
    systemAgent: { agentId: "main" },
    model: { primary: "openai/gpt-4.1" },
  },
  entries: Object.fromEntries(
    agentIds.map((id) => {
      const workspace = path.join(stateDir, "workspace", ...(id === "main" ? [] : [id]));
      mkdirSync(workspace, { recursive: true });
      return [id, { ...cfg.agents?.entries?.[id], workspace }];
    }),
  ),
};
cfg.plugins = {
  enabled: true,
  allow: [...TEAM_STRESS_PLUGIN_IDS],
  entries: Object.fromEntries(TEAM_STRESS_PLUGIN_IDS.map((id) => [id, { enabled: true }])),
};
// No turns are requested. Any incidental OpenAI discovery uses the synthetic HTTP endpoint.
let providerRequests = 0;
const mockProvider = createHttpServer((_request, response) => {
  providerRequests += 1;
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ object: "list", data: [] }));
});
await new Promise<void>((resolve, reject) => {
  mockProvider.once("error", reject);
  mockProvider.listen(0, "127.0.0.1", resolve);
});
mockProvider.unref();
const mockAddress = mockProvider.address();
assert(mockAddress && typeof mockAddress !== "string");
cfg.models = {
  mode: "merge",
  providers: {
    openai: {
      baseUrl: `http://127.0.0.1:${mockAddress.port}/v1`,
      api: "openai-responses",
      apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
      models: [
        {
          id: "gpt-4.1",
          name: "Synthetic connect fixture",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128_000,
          maxTokens: 4_096,
        },
      ],
    },
  },
};
cfg.gateway = {
  ...cfg.gateway,
  bind: "loopback",
  port,
  tailscale: { mode: "off" },
  trustedProxies: ["127.0.0.1"],
  auth:
    values.auth === "password"
      ? { mode: "password", password }
      : {
          mode: "trusted-proxy",
          identityScopes: Object.fromEntries(
            allowedIdentities.map((identity) => [identity, scopes]),
          ),
          trustedProxy: {
            userHeader: cloudflare ? "cf-access-authenticated-user-email" : "x-forwarded-user",
            requiredHeaders: [
              "x-forwarded-proto",
              "x-forwarded-host",
              ...(cloudflare ? ["cf-access-jwt-assertion"] : []),
            ],
            allowUsers: allowedIdentities,
            allowLoopback: true,
          },
        },
  controlUi: { enabled: false, allowedOrigins: [origin] },
};
if (cloudflare) {
  cfg.gateway.roles = {
    default: "synthetic",
    definitions: { synthetic: { sessions: { others: "view" }, agents: "*", scopes } },
  };
}
cfg.logging = {
  ...cfg.logging,
  file: path.join(output, "gateway-file.log"),
  consoleLevel: "info",
  consoleStyle: "pretty",
};
writeFileSync(configPath, JSON.stringify(cfg));

type Sample = {
  index: number;
  identity: number;
  firstVisit: boolean;
  startedAtMs: number;
  endedAtMs: number;
  requestId: string;
  rpcMs: number;
  socketToHelloMs: number;
  payloadBytes: number;
  normalizedBytes: number;
  normalizedSha256: string;
  grantedScopes: string[];
  phases: Record<string, number>;
  hostLoad: number[];
};
const samples: Sample[] = [];
const phasesByRequest = new Map<string, Record<string, number>>();
const log = createWriteStream(path.join(output, "gateway.log"));
const stopPreload = new URL("../lib/gateway-bench-stop-preload.mjs", import.meta.url);
stopPreload.searchParams.set("parentPid", String(process.pid));
stopPreload.searchParams.set("entry", entry);
const child = spawn(
  process.execPath,
  [
    "--import",
    stopPreload.href,
    ...(cloudflare
      ? ["--import", new URL("./connect-profile-preload.mjs", import.meta.url).href]
      : []),
    ...(values["gateway-preload"]
      ? ["--import", pathToFileURL(path.resolve(values["gateway-preload"])).href]
      : []),
    entry,
    "gateway",
    "run",
    "--port",
    String(port),
    "--bind",
    "loopback",
    "--auth",
    cloudflare ? "trusted-proxy" : values.auth,
    "--tailscale",
    "off",
    "--allow-unconfigured",
    "--verbose",
    "--ws-log",
    "compact",
  ],
  {
    env: createGatewayBenchEnv(path.join(output, "home"), configPath, {
      startupTrace: false,
      caseEnv: {
        OPENCLAW_STATE_DIR: stateDir,
        TMPDIR: path.join(output, "tmp"),
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENAI_API_KEY: "synthetic-local-only",
        ...(cloudflare ? { OPENCLAW_BENCH_IDENTITY_DELAY_MS: String(identityDelayMs) } : {}),
      },
    }),
    detached: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  },
);
let spawnError: Error | undefined;
child.once("error", (error) => {
  spawnError = error;
});
assert(child.stdout && child.stderr, "Gateway stdout and stderr pipes are required");
for (const stream of [child.stdout, child.stderr]) {
  stream.pipe(log, { end: false });
  createInterface({ input: stream }).on("line", (line) => {
    if (!/\bres ✓ connect\b/u.test(line)) {
      return;
    }
    const request = /\bid=(\S+)/u.exec(line)?.[1];
    if (!request) {
      return;
    }
    const phases: Record<string, number> = {};
    for (const match of line.matchAll(/\b([A-Za-z]+Ms)=([\d.]+)/gu)) {
      phases[match[1]!] = Number(match[2]);
    }
    const total = /\bconnect (\d+)ms\b/u.exec(line)?.[1];
    if (total) {
      phases.responseMs = Number(total);
    }
    phasesByRequest.set(request, phases);
  });
}
let interrupted = false;
const pollingAbort = new AbortController();
setMaxListeners(clientCount + 2, pollingAbort.signal);
const interrupt = () => {
  interrupted = true;
  pollingAbort.abort();
  child.kill("SIGTERM");
};
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);

// Only per-run clocks, random connection/installation tokens, paths and provenance vary.
// Every other field, including scopes, capabilities and plugin descriptors, stays in the hash.
const normalizedPaths = new Set([
  "server.connId",
  "server.bootId",
  "server.buildId",
  "snapshot.uptimeMs",
  "snapshot.appliedConfigHash",
  "snapshot.configPath",
  "snapshot.stateDir",
  "snapshot.stateVersion.presence",
  "snapshot.stateVersion.health",
  "auth.recoveryScope",
  "auth.deviceToken",
  "auth.issuedAtMs",
  "snapshot.presence.*.ts",
  "snapshot.presence.*.connectionId",
  "snapshot.presence.*.user.updatedAt",
]);
function normalize(value: unknown, location = ""): unknown {
  if (normalizedPaths.has(location)) {
    return "<per-run>";
  }
  if (location === "pluginSurfaceUrls.canvas" && typeof value === "string") {
    return value.replace(/(\/__openclaw__\/cap\/)[A-Za-z0-9_-]{24}$/u, "$1<per-run>");
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalize(item, `${location}.*`));
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      normalize(item, location ? `${location}.${key}` : key),
    ]),
  );
}
function stats(numbers: number[]) {
  const sorted = numbers.toSorted((a, b) => a - b);
  const percentile = (p: number) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? null;
  return {
    count: sorted.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: sorted.at(-1) ?? null,
  };
}
function summarize(rows: Sample[]) {
  const keys = new Set(rows.flatMap((sample) => Object.keys(sample.phases)));
  return {
    rpcMs: stats(rows.map((sample) => sample.rpcMs)),
    socketToHelloMs: stats(rows.map((sample) => sample.socketToHelloMs)),
    payloadBytes: stats(rows.map((sample) => sample.payloadBytes)),
    phases: Object.fromEntries(
      [...keys].map((key) => [
        key,
        stats(
          rows.flatMap((sample) => (sample.phases[key] === undefined ? [] : [sample.phases[key]])),
        ),
      ]),
    ),
  };
}
type Peer = ReturnType<typeof createGatewayWsClient>;
const peers = new Set<Peer>();
async function closePeer(client: Peer) {
  peers.delete(client);
  if (client.ws.readyState === client.ws.CLOSED) {
    return;
  }
  const closed = once(client.ws, "close");
  client.close();
  const timer = setTimeout(() => client.ws.terminate(), 1_000);
  await closed.finally(() => clearTimeout(timer));
}
async function connect(identityEmail: string, deviceIndex?: number) {
  const started = performance.now();
  const startedAtMs = Date.now();
  const proxy = values.auth !== "password";
  const device = deviceIndex === undefined ? undefined : devices[deviceIndex];
  const role = device ? values["device-role"]! : "operator";
  const requestedScopes = role === "node" ? [] : proxy ? ["operator.read"] : scopes;
  const clientInfo = {
    id: role === "node" ? "node-host" : proxy ? "openclaw-control-ui" : "cli",
    mode: role === "node" ? "node" : proxy ? "webchat" : "cli",
    version: "1.0.0",
    platform: "linux",
    instanceId: identityEmail,
  };
  const challenge = Promise.withResolvers<{ nonce: string; ts: number }>();
  const client = createGatewayWsClient({
    url: `ws://127.0.0.1:${port}`,
    openTimeoutMs: 30_000,
    handshakeTimeoutMs: 30_000,
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
    ...(proxy
      ? {
          origin,
          headers: {
            ...(cloudflare
              ? {
                  "cf-access-authenticated-user-email": identityEmail,
                  "cf-access-jwt-assertion": assertions.get(identityEmail)!,
                }
              : { "x-forwarded-user": identityEmail }),
            "x-forwarded-for": "192.0.2.10",
            "x-forwarded-proto": "https",
            "x-forwarded-host": "connect-tail.example",
          },
        }
      : {}),
  });
  peers.add(client);
  try {
    await client.waitOpen();
    let signedDevice;
    if (device) {
      const timer = setTimeout(
        () => challenge.reject(new Error("Device challenge timed out")),
        30_000,
      );
      try {
        const { nonce, ts } = await challenge.promise;
        signedDevice = {
          id: device.id,
          publicKey: device.publicKey,
          nonce,
          signedAt: ts,
          signature: signEd25519Payload(
            device.privateKey,
            buildDeviceAuthPayloadV3({
              deviceId: device.id,
              clientId: clientInfo.id,
              clientMode: clientInfo.mode,
              platform: clientInfo.platform,
              role,
              scopes: requestedScopes,
              signedAtMs: ts,
              nonce,
            }),
          ),
        };
      } finally {
        clearTimeout(timer);
      }
    }
    const rpcStarted = performance.now();
    const reply = await client.request(
      "connect",
      {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: clientInfo,
        role,
        scopes: requestedScopes,
        ...(signedDevice ? { device: signedDevice } : {}),
        ...(role === "node" ? { commands: [] } : {}),
        caps: ["hello-health-on-demand", "hello-presence-self"],
        ...(proxy ? {} : { auth: { password } }),
      },
      30_000,
    );
    const ended = performance.now();
    const endedAtMs = Date.now();
    assert(reply.ok, `Connect failed: ${JSON.stringify(reply.error)}`);
    assert(isRecord(reply.payload) && reply.payload.type === "hello-ok", "hello payload required");
    const auth = reply.payload.auth;
    assert(
      isRecord(auth) &&
        Array.isArray(auth.scopes) &&
        auth.scopes.every((scope) => typeof scope === "string"),
    );
    const grantedScopes: string[] = auth.scopes;
    assert.deepEqual(
      grantedScopes.toSorted(),
      role === "node" ? [] : scopes.toSorted(),
      "negotiated scopes changed",
    );
    const normalized = JSON.stringify(normalize(reply.payload));
    const request = `${reply.id.slice(0, 8)}…${reply.id.slice(-4)}`;
    const deadline = performance.now() + 5_000;
    while (!phasesByRequest.has(request) && performance.now() < deadline) {
      await delay(5);
    }
    const phases = phasesByRequest.get(request);
    assert(phases, "Successful connect phase log missing; inspect gateway.log");
    phasesByRequest.delete(request);
    return {
      client,
      normalized,
      metrics: {
        startedAtMs,
        endedAtMs,
        requestId: reply.id,
        rpcMs: ended - rpcStarted,
        socketToHelloMs: ended - started,
        payloadBytes: Buffer.byteLength(JSON.stringify(reply.payload)),
        normalizedBytes: Buffer.byteLength(normalized),
        normalizedSha256: createHash("sha256").update(normalized).digest("hex"),
        grantedScopes,
        phases,
        hostLoad: loadavg(),
      },
    };
  } catch (error) {
    await closePeer(client);
    throw error;
  }
}
const background = {
  setupCompleted: 0,
  completed: 0,
  errors: 0,
  measuredCompleted: 0,
  measuredErrors: 0,
  errorMessages: [] as string[],
  measuredMs: [] as number[],
  returnedRows: [] as number[],
};
let measuring = false;
const pollers: Promise<void>[] = [];
async function poll(client: Peer, index: number) {
  const { signal } = pollingAbort;
  try {
    await delay(Math.floor((index * pollMs) / Math.max(1, clientCount)), undefined, { signal });
    while (!signal.aborted) {
      const measured = measuring;
      const started = performance.now();
      try {
        const reply = await client.request(
          "sessions.list",
          {
            rowMode: "sidebar",
            limit: 200,
            source: "sidebar",
          },
          30_000,
        );
        assert(reply.ok, `sessions.list: ${JSON.stringify(reply.error)}`);
        assert(
          isRecord(reply.payload) && Array.isArray(reply.payload.sessions),
          "sessions.list rows missing",
        );
        background.returnedRows.push(reply.payload.sessions.length);
        assert(reply.payload.sessions.length > 0, "sessions.list returned no synthetic rows");
        background.completed += 1;
        if (measured) {
          background.measuredCompleted += 1;
          background.measuredMs.push(performance.now() - started);
        }
      } catch (error) {
        background.errors += 1;
        if (measured) {
          background.measuredErrors += 1;
        }
        if (background.errorMessages.length < 10) {
          background.errorMessages.push(String(error));
        }
      }
      await delay(pollMs, undefined, { signal });
    }
  } catch (error) {
    if (!signal.aborted) {
      throw error;
    }
  }
}
async function drainPeers() {
  pollingAbort.abort();
  await Promise.all(pollers);
  await Promise.all([...peers].map(closePeer));
}
let teardown: unknown;
try {
  const startAt = performance.now();
  const ready = await waitForInitialProbe({
    startAt,
    deadlineAt: startAt + 180_000,
    path: "/readyz",
    port,
    isDone: () =>
      interrupted || Boolean(spawnError) || child.exitCode !== null || child.signalCode !== null,
  });
  assert(
    ready.status === 200,
    `Gateway failed readiness: ${spawnError?.message ?? JSON.stringify(ready)}`,
  );
  for (const identity of residentIdentities) {
    assert(!interrupted, "measurement interrupted");
    await connect(identity);
    background.setupCompleted += 1;
  }
  for (const [index, client] of [...peers].entries()) {
    pollers.push(poll(client, index));
  }
  await delay(warmupMs, undefined, { signal: pollingAbort.signal });
  measuring = true;
  for (let index = 0; index < sampleCount; index++) {
    assert(!interrupted, "measurement interrupted");
    const identity = index % identityCount;
    const connection = await connect(
      identities[identity]!,
      values["device-role"] ? identity : undefined,
    );
    try {
      if (index === 0) {
        writeFileSync(path.join(output, "hello-normalized.json"), connection.normalized);
      }
      samples.push({ index, identity, firstVisit: index < identityCount, ...connection.metrics });
    } finally {
      await closePeer(connection.client);
    }
    if (intervalMs > 0) {
      await delay(intervalMs);
    }
  }
  measuring = false;
  await drainPeers();
  teardown = await stopGatewayGracefully(child, 30_000);
} finally {
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
  measuring = false;
  await drainPeers();
  const cleanup = await stopChild(child);
  mockProvider.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    mockProvider.close((error) => (error ? reject(error) : resolve()));
  });
  log.end();
  const report = {
    buildId,
    entry,
    auth: values.auth,
    identityDelayMs,
    identityDependency:
      cloudflare && existsSync(path.join(output, "identity-dependency.json"))
        ? JSON.parse(readFileSync(path.join(output, "identity-dependency.json"), "utf8"))
        : undefined,
    deviceRole: values["device-role"],
    seededDevices: values["seed-devices"],
    fixture,
    sampleCount,
    identityCount,
    identityPrefix,
    warmupMs,
    pollMs,
    intervalMs,
    gatewayPreload: values["gateway-preload"] ? path.resolve(values["gateway-preload"]) : undefined,
    background: {
      ...background,
      measuredMs: stats(background.measuredMs),
      returnedRows: stats(background.returnedRows),
    },
    shape: {
      configuredPlugins: [...TEAM_STRESS_PLUGIN_IDS],
      configuredAgents: agentIds,
      persistentClients: clientCount,
      concurrentClients: clientCount + 1,
      providerRequests,
    },
    host: {
      node: process.version,
      availableParallelism: availableParallelism(),
      loadavg: loadavg(),
    },
    normalization: [...normalizedPaths],
    canvasCapabilityNormalization: "Replace only the terminal 24-character capability token",
    firstVisits: summarize(samples.filter((sample) => sample.firstVisit)),
    warmVisits: summarize(samples.filter((sample) => !sample.firstVisit)),
    all: summarize(samples),
    samples,
    teardown,
    cleanup,
  };
  writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, completed: samples.length, all: report.all }));
}
assert.equal(background.errors, 0, "Background sessions.list load failed; see report.json");
assert(clientCount === 0 || background.completed > 0, "No background sessions.list work completed");
