// Synthetic viewer lifecycle and mixed presence workloads through the real Gateway transport.
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, type KeyObject } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { buildDeviceAuthPayloadV3 } from "../../packages/gateway-client/src/device-auth.ts";
import type { HelloOk } from "../../packages/gateway-protocol/src/index.js";
import type { PresenceReset } from "../../packages/gateway-protocol/src/presence-deltas.js";
import type { PresenceEntry } from "../../packages/gateway-protocol/src/schema/snapshot.js";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.ts";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import {
  publicKeyRawBase64UrlFromEd25519Pem,
  signEd25519Payload,
} from "../../src/infra/ed25519-signature.ts";
import { createGatewayPresenceObserver } from "../../ui/src/app/gateway-store.presence.ts";
import { BASE_GATEWAY_BENCH_CONFIG } from "../lib/gateway-bench-runtime.ts";
import { createGatewayWsClient } from "../lib/gateway-ws-client.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    port: { type: "string", default: "41466" },
    clients: { type: "string" },
    agents: { type: "string", default: "24" },
    "compact-payloads": { type: "boolean", default: false },
    "legacy-clients": { type: "string", default: "2" },
    "client-profile": { type: "string", default: "web" },
    rounds: { type: "string", default: "20" },
    "interval-ms": { type: "string", default: "1000" },
    "start-at": { type: "string" },
    "viewer-owner": { type: "string", default: "ui/src/lib/session-viewer-presence.ts" },
    "presence-owner": { type: "string" },
    scenario: { type: "string", default: "churn" },
    output: { type: "string" },
  },
});
const integer = (raw: string, label: string, min: number) =>
  parseStrictIntegerOption({ raw, label, min, fallback: min });
if (!values["state-dir"] || !values.output) {
  throw new Error("--state-dir (new synthetic directory) and --output are required");
}
const port = integer(values.port, "--port", 40000);
assert(port <= 65535);
const payloadScenario = values.scenario === "payloads";
const clients = integer(values.clients ?? (payloadScenario ? "40" : "42"), "--clients", 3);
const agentCount = payloadScenario ? integer(values.agents, "--agents", 1) : 1;
const legacyClients = integer(values["legacy-clients"], "--legacy-clients", 0);
assert(legacyClients <= clients, "--legacy-clients must not exceed --clients");
assert(
  ["web", "native"].includes(values["client-profile"]),
  "--client-profile must be web or native",
);
assert(
  values["client-profile"] !== "native" || legacyClients >= 2,
  "the native profile keeps two legacy CLI controls",
);
const rounds = integer(values.rounds, "--rounds", 1);
const interval = integer(values["interval-ms"], "--interval-ms", 250);
assert(
  ["churn", "traffic", "payloads"].includes(values.scenario),
  "--scenario must be churn, traffic, or payloads",
);
let baselineOwnerLoads = 0;
if (values["presence-owner"]) {
  const original = new URL("../../src/infra/system-presence.ts", import.meta.url).href;
  const replacement = pathToFileURL(path.resolve(values["presence-owner"])).href;
  assert.notEqual(original, replacement, "--presence-owner must select a baseline sibling file");
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context);
      if (resolved.url === original) {
        baselineOwnerLoads++;
        return { ...resolved, url: replacement };
      }
      return resolved;
    },
  });
}
const root = path.resolve(values["state-dir"]);
mkdirSync(root); // Refuse to reuse any existing state.
mkdirSync(path.join(root, "tmp"));
const configPath = path.join(root, "openclaw.json");
writeFileSync(
  configPath,
  JSON.stringify({
    ...BASE_GATEWAY_BENCH_CONFIG,
    gateway: {
      ...BASE_GATEWAY_BENCH_CONFIG.gateway,
      controlUi: { enabled: false, allowedOrigins: [`http://127.0.0.1:${port}`] },
    },
    agents: payloadScenario
      ? {
          ownership: "explicit",
          defaults: { heartbeat: { every: "0m" } },
          entries: Object.fromEntries(
            Array.from({ length: agentCount }, (_, index) => {
              const id = index === 0 ? "main" : `synthetic-${index}`;
              return [id, { name: `Synthetic agent ${index}`, workspace: path.join(root, id) }];
            }),
          ),
        }
      : { entries: { main: { workspace: path.join(root, "workspace") } } },
    plugins: { enabled: false },
    cron: { enabled: false },
  }),
);
Object.assign(process.env, {
  OPENCLAW_HOME: root,
  OPENCLAW_STATE_DIR: path.join(root, "state"),
  OPENCLAW_CONFIG_PATH: configPath,
  TMPDIR: path.join(root, "tmp"),
});
const { startGatewayServer } = await import("../../src/gateway/server.js");
const server = await startGatewayServer(port, { bind: "loopback", controlUiEnabled: false });
const peers: ReturnType<typeof createGatewayWsClient>[] = [];
const traffic = { delta: { frames: 0, bytes: 0 }, legacy: { frames: 0, bytes: 0 } };
const makeCounts = () => ({
  frames: 0,
  bytes: 0,
  orderBytes: 0,
  upsertBytes: 0,
  removeBytes: 0,
  presenceBytes: 0,
  keysBytes: 0,
  changedFields: {} as Record<string, { changes: number; bytes: number }>,
});
const makeModes = () => ({ delta: makeCounts(), reset: makeCounts(), legacy: makeCounts() });
const wire = makeModes();
const phases: Record<
  string,
  { elapsedMs: number; requests: number; wire: ReturnType<typeof makeModes> }
> = {};
let phase: (typeof phases)[string] | undefined;
const received = new Map<number, PresenceEntry[]>();
const observers: ReturnType<typeof createGatewayPresenceObserver>[] = [];
const cohorts = new Map<
  string,
  { clientKind: string; version: string; capability: string; count: number }
>();
const socketTraffic = Array.from({ length: clients }, () => ({ frames: 0, bytes: 0 }));
const firstPresenceModes = new Map<number, string>();
let recoveryRequests = 0;
let measured = false;
let requests = 0;
const failures: string[] = [];
async function rpc(peer: (typeof peers)[number], method: string, params: unknown) {
  const result = await peer.request(method, params, 60_000);
  assert(result.ok, `${method}: ${JSON.stringify(result.error)}`);
  return result.payload;
}
async function runTraffic(actor: (typeof peers)[number], keys: string[], sessionId: string) {
  const typing = { broadcast: 0, suppressed: 0 };
  const beacon = (index: number, round: number) =>
    rpc(actor, "system-event", {
      text: `Node: Synthetic compute ${index} · app dev · last input ${round % 30}s ago · mode node · reason heartbeat`,
      instanceId: `presence-node-${index}`,
      host: `Synthetic compute ${index}`,
      platform: "linux 6.8",
      deviceFamily: "Linux",
      modelIdentifier: "Synthetic server",
      version: "dev",
      mode: "node",
      roles: ["node"],
      reason: "heartbeat",
      lastInputSeconds: round % 30,
    });
  const call = async (peer: (typeof peers)[number], method: string, params: unknown) => {
    requests++;
    if (phase) {
      phase.requests++;
    }
    return rpc(peer, method, params);
  };
  for (let index = 0; index < 4; index++) {
    await beacon(index, 0);
  }
  for (const peer of peers.slice(2)) {
    await rpc(peer, "sessions.viewers.set", { sessionKeys: [keys[0]!] });
  }
  await delay(1000);
  if (values["start-at"]) {
    const startAt = integer(values["start-at"], "--start-at", 1);
    assert(startAt > Date.now(), "pair start deadline must follow Gateway preparation");
    await delay(startAt - Date.now());
  }
  const started = performance.now();
  const cpu = process.cpuUsage();
  measured = true;
  const runPhase = async (name: string, operation: (round: number) => Promise<unknown>) => {
    phase = phases[name] = { elapsedMs: 0, requests: 0, wire: makeModes() };
    const phaseStarted = performance.now();
    for (let round = 0; round < rounds; round++) {
      await operation(round);
      await delay(interval);
    }
    phase.elapsedMs = performance.now() - phaseStarted;
    phase = undefined;
  };
  await runPhase("viewer-switch-and-leave", async (round) => {
    const peer = peers[2 + (round % (clients - 2))]!;
    await call(peer, "sessions.viewers.set", { sessionKeys: [keys[1]!] });
    await delay(25);
    await call(peer, "sessions.viewers.set", { sessionKeys: round % 2 ? [] : [keys[0]!] });
  });
  await runPhase("activity", (round) =>
    call(peers[2 + (round % (clients - 2))]!, "presence.activity", {}),
  );
  await runPhase("typing", async (round) => {
    const result = await call(actor, "session.typing", {
      sessionKey: keys[0]!,
      sessionId,
      typing: round % 2 === 0,
    });
    assert(isRecord(result) && typeof result.broadcast === "boolean");
    typing[result.broadcast ? "broadcast" : "suppressed"]++;
  });
  await runPhase("node-heartbeat", async (round) => {
    requests++;
    phase!.requests++;
    await beacon(round % 4, round + 1);
  });
  await runPhase("mixed-burst", async (round) => {
    const peer = peers[2 + (round % (clients - 2))]!;
    await call(peer, "sessions.viewers.set", { sessionKeys: [keys[round % 2]!] });
    await call(peer, "presence.activity", {});
    requests++;
    phase!.requests++;
    await beacon(round % 4, round + 1);
  });
  measured = false;
  const elapsedMs = performance.now() - started;
  const used = process.cpuUsage(cpu);
  // Flush precise activity facts and a final departure before comparing the real UI reducer.
  await rpc(actor, "sessions.viewers.set", { sessionKeys: [] });
  await beacon(0, rounds + 1);
  const comparable = (rows: PresenceEntry[]) =>
    rows.map((row) => (row.mode === "gateway" ? { ...row, ts: 0 } : row));
  let authoritative: PresenceEntry[] = [];
  const deadline = Date.now() + 15_000;
  do {
    await delay(250);
    authoritative = (await rpc(actor, "system-presence", {})) as PresenceEntry[];
    if (
      peers.every(
        (_, index) =>
          received.has(index) &&
          isDeepStrictEqual(comparable(received.get(index)!), comparable(authoritative)),
      )
    ) {
      break;
    }
  } while (Date.now() < deadline);
  for (let index = 0; index < clients; index++) {
    assert(received.has(index), `socket ${index} did not receive presence`);
    assert.deepEqual(
      comparable(received.get(index)!),
      comparable(authoritative),
      `socket ${index} reconstructed roster differs from system-presence`,
    );
  }
  const departed = authoritative.find((row) => row.instanceId === `presence-bench-${clients - 1}`);
  assert(departed, "final actor must remain online");
  assert.equal(departed.watchedSessions?.length ?? 0, 0, "final actor must leave every session");
  assert.equal(recoveryRequests, 0, "the UI reducer must accept every delta without recovery");
  assert.equal(
    firstPresenceModes.size,
    clients,
    "every handshake must negotiate its presence format",
  );
  assert.equal(failures.length, 0, failures.join("\n"));
  const frames = Object.values(wire).reduce((sum, counts) => sum + counts.frames, 0);
  const bytes = Object.values(wire).reduce((sum, counts) => sum + counts.bytes, 0);
  const report = {
    scenario: "traffic",
    clients,
    legacyClients,
    rounds,
    intervalMs: interval,
    elapsedMs,
    requests,
    typing,
    wire,
    rates: Object.fromEntries(
      Object.entries(wire).map(([mode, counts]) => [
        mode,
        {
          framesPerMinute: (counts.frames * 60_000) / elapsedMs,
          bytesPerFrame: counts.bytes / Math.max(1, counts.frames),
          bytesPerSocket:
            counts.bytes / Math.max(1, mode === "legacy" ? legacyClients : clients - legacyClients),
        },
      ]),
    ),
    phases,
    framesPerMinute: (frames * 60_000) / elapsedMs,
    bytesPerFrame: bytes / Math.max(1, frames),
    bytesPerSocket: bytes / clients,
    bytesPerSocketPerMinute: (bytes * 60_000) / elapsedMs / clients,
    clientCohorts: [...cohorts.values()],
    ...(values["client-profile"] === "native"
      ? {
          nativeSockets: clients - 2,
          nativeBytesPerSocket:
            socketTraffic.slice(2).reduce((sum, counts) => sum + counts.bytes, 0) / (clients - 2),
          nativeFramesPerSocket:
            socketTraffic.slice(2).reduce((sum, counts) => sum + counts.frames, 0) / (clients - 2),
        }
      : {}),
    correctness: {
      checkedSockets: clients,
      reducerSockets: observers.length,
      recoveryRequests,
      finalDeparture: true,
      negotiatedSockets: firstPresenceModes.size,
    },
    baselineOwnerLoads,
    cpuMs: (used.user + used.system) / 1000,
    rssBytes: process.memoryUsage().rss,
    limitations: [
      "Synthetic shared-owner clients; no external profile/avatar provider.",
      "Node heartbeat uses the operator system-event contract; node.hostStats is a separate event and is not replayed.",
      "Setup and final correctness flush are outside the measurement window.",
      "Client kinds and versions are synthetic handshake metadata, not a production client inventory.",
    ],
  };
  writeFileSync(values.output!, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
}
const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const distribution = (samples: number[]) => {
  const sorted = samples.toSorted((a, b) => a - b);
  const percentile = (fraction: number) =>
    sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
  return {
    count: samples.length,
    total: samples.reduce((sum, value) => sum + value, 0),
    p50: percentile(0.5),
    p99: percentile(0.99),
  };
};
const makePayloadCounts = () => ({
  frames: 0,
  bytes: 0,
  samples: [] as number[],
  fieldBytes: {} as Record<string, number>,
});
function countPayload(counts: ReturnType<typeof makePayloadCounts>, value: unknown) {
  const bytes = jsonBytes(value);
  counts.frames++;
  counts.bytes += bytes;
  counts.samples.push(bytes);
  const visit = (item: unknown, prefix: string, depth: number) => {
    if (depth > 3) {
      return;
    }
    if (Array.isArray(item)) {
      for (const child of item) {
        visit(child, `${prefix}[]`, depth);
      }
      return;
    }
    if (!isRecord(item)) {
      return;
    }
    for (const [key, child] of Object.entries(item)) {
      const field = prefix ? `${prefix}.${key}` : key;
      counts.fieldBytes[field] = (counts.fieldBytes[field] ?? 0) + jsonBytes(child);
      visit(child, field, depth + 1);
    }
  };
  visit(value, "", 0);
}
const payloadWaves: Array<{
  kind: "cold" | "reconnect";
  elapsedMs: number;
  hello: ReturnType<typeof makePayloadCounts>;
  health: ReturnType<typeof makePayloadCounts>;
  presence: ReturnType<typeof makePayloadCounts>;
  connectMs: number[];
  readyMs: number[];
  healthSockets: Set<number>;
}> = [];
let payloadWave: (typeof payloadWaves)[number] | undefined;
const deviceKeys = new Map<number, { publicKey: KeyObject; privateKey: KeyObject }>();
const pairedDevices = new Set<number>();
const maintenanceTick = Promise.withResolvers<void>();
try {
  if (values["presence-owner"]) {
    assert(baselineOwnerLoads > 0, "baseline owner redirect was not used");
  }
  let actorHello: HelloOk | undefined;
  const connectPeer = async (index: number, scopeOverride?: string[]) => {
    const mode =
      payloadScenario && values["client-profile"] === "web"
        ? "delta"
        : index < legacyClients
          ? "legacy"
          : "delta";
    const activeWave = payloadWave;
    const started = performance.now();
    const initialPresence = Promise.withResolvers<void>();
    received.delete(index);
    const observer =
      mode === "delta" && (values.scenario === "traffic" || payloadScenario)
        ? createGatewayPresenceObserver({
            requestSnapshot: async () => {
              recoveryRequests++;
              console.error("Presence recovery", {
                socket: index,
                measured,
                phase: Object.keys(phases).at(-1) ?? "setup",
              });
              return (await rpc(peers[index]!, "system-presence", {
                snapshot: true,
              })) as PresenceReset;
            },
            publish: (event) =>
              received.set(index, (event.payload as { presence: PresenceEntry[] }).presence),
            onError: (error) => failures.push(String(error)),
          })
        : undefined;
    if (observer && !payloadScenario) {
      observers.push(observer);
    }
    const challenge = Promise.withResolvers<{ nonce: string; ts: number }>();
    const peer = createGatewayWsClient({
      url: `ws://127.0.0.1:${port}`,
      origin: `http://127.0.0.1:${port}`,
      onEvent: (event) => {
        if (payloadScenario && index === clients && event.event === "tick") {
          maintenanceTick.resolve();
        }
        if (
          payloadWave &&
          index < clients &&
          (event.event === "health" || event.event === "presence")
        ) {
          countPayload(payloadWave[event.event], event);
          if (event.event === "health") {
            payloadWave.healthSockets.add(index);
          }
        }
        if (
          event.event === "connect.challenge" &&
          isRecord(event.payload) &&
          typeof event.payload.nonce === "string" &&
          typeof event.payload.ts === "number"
        ) {
          challenge.resolve({ nonce: event.payload.nonce, ts: event.payload.ts });
        }
        if (event.event === "presence") {
          assert(isRecord(event.payload), "presence must carry an object payload");
          const observedMode = "version" in event.payload ? "presence-deltas" : "legacy";
          assert.equal(observedMode, mode === "delta" ? "presence-deltas" : "legacy");
          firstPresenceModes.set(index, observedMode);
          const normalized = observer?.receive(event);
          if (normalized) {
            received.set(index, (normalized.payload as { presence: PresenceEntry[] }).presence);
            initialPresence.resolve();
          } else if (mode === "legacy") {
            received.set(index, (event.payload as { presence: PresenceEntry[] }).presence);
            initialPresence.resolve();
          }
          if (measured) {
            const bytes = Buffer.byteLength(JSON.stringify(event));
            traffic[mode].frames++;
            traffic[mode].bytes += bytes;
            socketTraffic[index]!.frames++;
            socketTraffic[index]!.bytes += bytes;
            if (values.scenario === "traffic" && isRecord(event.payload)) {
              const payload = event.payload;
              const wireMode =
                mode === "legacy" ? "legacy" : payload.reset === true ? "reset" : "delta";
              for (const counts of [wire[wireMode], ...(phase ? [phase.wire[wireMode]] : [])]) {
                counts.frames++;
                counts.bytes += bytes;
                for (const field of ["order", "upsert", "remove", "presence", "keys"] as const) {
                  if (payload[field] !== undefined) {
                    counts[`${field}Bytes`] += Buffer.byteLength(JSON.stringify(payload[field]));
                  }
                }
                if (Array.isArray(payload.upsert)) {
                  for (const row of payload.upsert) {
                    if (!isRecord(row) || !isRecord(row.set)) {
                      continue;
                    }
                    for (const [field, value] of Object.entries(row.set)) {
                      const count = (counts.changedFields[field] ??= { changes: 0, bytes: 0 });
                      count.changes++;
                      count.bytes += Buffer.byteLength(JSON.stringify(value));
                    }
                  }
                }
              }
            }
          }
        }
      },
    });
    peers[index] = peer;
    // Node ws can deliver hello and the first reset in one synchronous receive batch.
    observer?.synchronize(peer);
    peer.ws.once("close", () => observer?.synchronize(null));
    await peer.waitOpen();
    const timeout = setTimeout(
      () => challenge.reject(new Error("connect challenge timed out")),
      12_000,
    );
    const { nonce, ts } = await challenge.promise.finally(() => clearTimeout(timeout));
    const keys = deviceKeys.get(index) ?? generateKeyPairSync("ed25519");
    deviceKeys.set(index, keys);
    const publicKey = publicKeyRawBase64UrlFromEd25519Pem(
      keys.publicKey.export({ type: "spki", format: "pem" }),
    );
    const deviceId = createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("hex");
    const nativeIdentity =
      values["client-profile"] === "native"
        ? index < 2
          ? {
              id: "cli",
              platform: "darwin",
              mode: "cli",
              deviceFamily: "Mac",
              modelIdentifier: "Synthetic CLI",
            }
          : [
              {
                id: "openclaw-macos",
                platform: "darwin",
                mode: "ui",
                deviceFamily: "Mac",
                modelIdentifier: "Mac16,9",
              },
              {
                id: "openclaw-ios",
                platform: "ios",
                mode: "ui",
                deviceFamily: "iPhone",
                modelIdentifier: "iPhone17,1",
              },
              {
                id: "openclaw-android",
                platform: "android",
                mode: "ui",
                deviceFamily: "Android",
                modelIdentifier: "Synthetic phone",
              },
            ][(index - 2) % 3]
        : undefined;
    const identity = {
      id: "openclaw-control-ui",
      version: "dev",
      platform: "web",
      mode: "webchat",
      instanceId: `presence-bench-${index}`,
      displayName: `Synthetic workstation ${index}`,
      ...(values.scenario === "traffic"
        ? { deviceFamily: "Mac", modelIdentifier: "Mac16,9", timeZone: "America/Los_Angeles" }
        : {}),
      ...nativeIdentity,
    };
    const scopes =
      scopeOverride ??
      (values.scenario === "traffic"
        ? [
            "operator.admin",
            "operator.read",
            "operator.write",
            "operator.approvals",
            "operator.questions",
            "operator.pairing",
          ]
        : ["operator.admin"]);
    if (nativeIdentity && !pairedDevices.has(index)) {
      // Synthetic native fixtures still pass the normal signed-device admission boundary.
      const { requestDevicePairing } = await import("../../src/infra/device-pairing.js");
      const { approveDevicePairing } = await import("../../src/infra/device-pairing-approval.js");
      const pairing = await requestDevicePairing({
        deviceId,
        publicKey,
        role: "operator",
        scopes,
        clientId: identity.id,
        clientMode: identity.mode,
        browserOrigin: `http://127.0.0.1:${port}`,
        platform: identity.platform,
        deviceFamily: identity.deviceFamily,
        silent: false,
      });
      const approved = await approveDevicePairing(pairing.request.requestId, {
        callerScopes: scopes,
      });
      assert.equal(approved?.status, "approved", "synthetic device pairing must be approved");
      pairedDevices.add(index);
    }
    const signed = buildDeviceAuthPayloadV3({
      deviceId,
      clientId: identity.id,
      clientMode: identity.mode,
      platform: identity.platform,
      deviceFamily: identity.deviceFamily,
      role: "operator",
      scopes,
      signedAtMs: ts,
      nonce,
    });
    const caps = payloadScenario
      ? values["client-profile"] === "web"
        ? [
            "presence-deltas",
            "hello-health-on-demand",
            ...(values["compact-payloads"] ? ["health-summary", "hello-presence-self"] : []),
          ]
        : [
            ...(mode === "delta" ? ["presence-deltas"] : []),
            ...(values["compact-payloads"] ? ["health-summary"] : []),
          ]
      : mode === "delta"
        ? ["presence-deltas"]
        : [];
    const connectStarted = performance.now();
    const response = await peer.request(
      "connect",
      {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: identity,
        role: "operator",
        scopes,
        device: {
          id: deviceId,
          publicKey,
          signedAt: ts,
          nonce,
          signature: signEd25519Payload(
            keys.privateKey.export({ type: "pkcs8", format: "pem" }),
            signed,
          ),
        },
        caps,
      },
      60_000,
    );
    assert(response.ok, `connect: ${JSON.stringify(response.error)}`);
    const hello = response.payload as HelloOk;
    if (scopeOverride) {
      assert.deepEqual(
        hello.auth?.scopes,
        scopeOverride,
        "public health control must retain read-only scopes",
      );
    }
    if (activeWave && index < clients) {
      activeWave.connectMs.push(performance.now() - connectStarted);
      countPayload(activeWave.hello, response);
      const presenceTimeout = setTimeout(
        () => initialPresence.reject(new Error("initial presence timed out")),
        60_000,
      );
      await initialPresence.promise.finally(() => clearTimeout(presenceTimeout));
      activeWave.readyMs.push(performance.now() - started);
    }
    if (payloadScenario && identity.mode !== "cli") {
      const self = hello.snapshot.presence.find((row) => row.connectionId === hello.server.connId);
      assert(self, `socket ${index} hello must include its own presence row`);
      assert.equal(self.clientId, identity.id, "hello self row must retain client identity");
      assert.equal(
        self.instanceId,
        identity.instanceId,
        "hello self row must retain instance identity",
      );
    }
    const capability = mode === "delta" ? "presence-deltas" : "legacy";
    const cohortKey = `${identity.id}:${identity.version}:${capability}`;
    const cohort = cohorts.get(cohortKey) ?? {
      clientKind: identity.id,
      version: identity.version,
      capability,
      count: 0,
    };
    cohort.count++;
    cohorts.set(cohortKey, cohort);
    if (index === clients - 1) {
      actorHello = hello;
    }
  };
  if (payloadScenario) {
    // Preparation is outside pair timing; reconnects reuse the same signed devices.
    for (let index = 0; index <= clients; index++) {
      deviceKeys.set(index, generateKeyPairSync("ed25519"));
    }
    await connectPeer(clients, ["operator.read"]);
    const control = peers[clients]!;
    // The first tick proves post-ready maintenance has installed the health broadcaster.
    const tickTimeout = setTimeout(
      () => maintenanceTick.reject(new Error("Gateway maintenance did not start")),
      120_000,
    );
    await maintenanceTick.promise.finally(() => clearTimeout(tickTimeout));
    const healthRpc = makePayloadCounts();
    countPayload(healthRpc, await rpc(control, "health", { probe: true }));
    if (values["start-at"]) {
      const startAt = integer(values["start-at"], "--start-at", 1);
      assert(startAt > Date.now(), "pair start deadline must follow Gateway preparation");
      await delay(startAt - Date.now());
    }
    for (let round = 0; round <= rounds; round++) {
      payloadWave = {
        kind: round === 0 ? "cold" : "reconnect",
        elapsedMs: 0,
        hello: makePayloadCounts(),
        health: makePayloadCounts(),
        presence: makePayloadCounts(),
        connectMs: [],
        readyMs: [],
        healthSockets: new Set(),
      };
      payloadWaves.push(payloadWave);
      const started = performance.now();
      await Promise.all(Array.from({ length: clients }, (_, index) => connectPeer(index)));
      // Use the quarantine owner so the real health collector observes a changed diagnostic.
      const { recordContextEngineQuarantine } =
        await import("../../src/context-engine/registry-quarantine.ts");
      const engineId = `synthetic-health-${round}`;
      await recordContextEngineQuarantine({
        engineId,
        operation: "bootstrap",
        error: new Error("Synthetic payload measurement"),
        defaultEngineId: "legacy",
      });
      const deadline = Date.now() + 15_000;
      let collected = false;
      do {
        const health = await rpc(control, "health", { probe: true });
        if (
          isRecord(health) &&
          isRecord(health.contextEngines) &&
          Array.isArray(health.contextEngines.quarantined) &&
          health.contextEngines.quarantined.some(
            (engine: unknown) => isRecord(engine) && engine.engineId === engineId,
          )
        ) {
          countPayload(healthRpc, health);
          collected = true;
          break;
        }
        assert(Date.now() < deadline, "synthetic quarantine did not reach the health collector");
        await delay(100);
      } while (Date.now() < deadline);
      assert(collected, "synthetic quarantine did not reach the health collector");
      await delay(interval);
      assert.equal(
        payloadWave.healthSockets.size,
        clients,
        "changed health must reach every client",
      );
      payloadWave.elapsedMs = performance.now() - started;
      payloadWave = undefined;
      const comparable = (rows: PresenceEntry[]) =>
        rows.map((row) => (row.mode === "gateway" ? { ...row, ts: 0 } : row));
      const authoritative = (await rpc(peers[0]!, "system-presence", {})) as PresenceEntry[];
      for (let index = 0; index < clients; index++) {
        assert(received.has(index), `socket ${index} did not reconstruct presence`);
        assert.deepEqual(
          comparable(received.get(index)!),
          comparable(authoritative),
          `wave ${round} socket ${index} reconstructed roster differs from system-presence`,
        );
      }
      assert.equal(
        recoveryRequests,
        0,
        "the UI reducer must accept every payload-wave delta without recovery",
      );
      assert.equal(failures.length, 0, failures.join("\n"));
      await Promise.all(
        peers.slice(0, clients).map(
          (peer) =>
            new Promise<void>((resolve) => {
              peer.ws.once("close", () => resolve());
              peer.close();
            }),
        ),
      );
    }
    const summarize = (counts: ReturnType<typeof makePayloadCounts>) => ({
      frames: counts.frames,
      bytes: counts.bytes,
      bytesPerFrame: distribution(counts.samples),
      fieldBytes: counts.fieldBytes,
    });
    const report = {
      scenario: "payloads",
      clients,
      agents: agentCount,
      reconnectWaves: rounds,
      compactPayloads: values["compact-payloads"],
      clientProfile: values["client-profile"],
      healthRpc: summarize(healthRpc),
      waves: payloadWaves.map((wave) => ({
        kind: wave.kind,
        elapsedMs: wave.elapsedMs,
        hello: summarize(wave.hello),
        health: summarize(wave.health),
        healthSockets: wave.healthSockets.size,
        verifiedPresenceSockets: clients,
        presence: summarize(wave.presence),
        connectMs: distribution(wave.connectMs),
        socketToHelloAndPresenceMs: distribution(wave.readyMs),
        totalBytes: wave.hello.bytes + wave.health.bytes + wave.presence.bytes,
      })),
      limitations: [
        "Synthetic agents and signed clients; plugins, channels, cron, and heartbeat execution are disabled.",
        "Cold means first measured client attach to a Gateway whose public health is already populated; reconnects reuse devices.",
        "Time to ready ends after hello and initial presence; no browser rendering or catalog RPCs are modeled.",
        "Health uses the real collector and quarantine owner with synthetic failures; no health payloads are injected.",
        "UTF-8 JSON application bytes exclude WebSocket/TCP framing and compression; nested field sizes overlap parent totals.",
        "Control health RPC bytes are reported separately; each wave totals hello, health, and presence before disconnect.",
      ],
    };
    writeFileSync(values.output, JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report));
  } else {
    for (let index = 0; index < clients; index++) {
      await connectPeer(index);
    }
    assert(actorHello);
    const actor = peers.at(-1)!;
    const keys = ["agent:main:presence-bench-a", "agent:main:presence-bench-b"];
    const sessionIds: string[] = [];
    for (const key of keys) {
      const created = await rpc(actor, "sessions.create", {
        key,
        visibility: "shared",
        displayName: "Synthetic presence session",
      });
      assert(isRecord(created) && typeof created.sessionId === "string");
      sessionIds.push(created.sessionId);
    }
    if (values.scenario === "traffic") {
      await runTraffic(actor, keys, sessionIds[0]!);
    } else {
      // Adapt the live transport to the same plain owner used by mounted chat pages.
      const gateway = {
        snapshot: {
          phase: "connected" as const,
          hello: actorHello,
          assistantAgentId: "main",
          client: {
            request: async (method: string, params: unknown) => {
              if (measured) {
                requests++;
              }
              try {
                return await rpc(actor, method, params);
              } catch (error) {
                failures.push(String(error));
                throw error;
              }
            },
          },
        },
        subscribe: () => () => {},
      };
      // The selectable owner consumes this transport adapter, not the browser application.
      const { sessionViewerPresenceForGateway } = (await import(
        pathToFileURL(path.resolve(values["viewer-owner"])).href
      )) as {
        sessionViewerPresenceForGateway: (adapter: typeof gateway) => {
          watch: (owner: object, sessionKeys: readonly string[]) => void;
          unwatch: (owner: object) => void;
        };
      };
      const store = sessionViewerPresenceForGateway(gateway);
      let owner = {};
      store.watch(owner, [keys[0]!]);
      await delay(500);
      if (values["start-at"]) {
        const startAt = integer(values["start-at"], "--start-at", 1);
        assert(startAt > Date.now(), "pair start deadline must follow Gateway preparation");
        await delay(startAt - Date.now());
      }
      const started = performance.now();
      const cpu = process.cpuUsage();
      measured = true;
      for (let round = 0; round < rounds; round++) {
        // Real mount cleanup followed by a replacement owner with unchanged membership.
        store.unwatch(owner);
        owner = {};
        store.watch(owner, [keys[0]!]);
        await delay(interval);
      }
      const churn = structuredClone(traffic);
      const churnRequests = requests;
      const churnElapsedMs = performance.now() - started;
      // Positive control: a real session change and final departure must still publish.
      store.watch(owner, [keys[1]!]);
      await delay(500);
      store.unwatch(owner);
      await delay(500);
      measured = false;
      assert.equal(failures.length, 0, failures.join("\n"));
      assert.equal(
        traffic.legacy.frames - churn.legacy.frames,
        legacyClients * 2,
        "both changes must reach legacy readers",
      );
      assert.equal(
        traffic.delta.frames - churn.delta.frames,
        (clients - legacyClients) * 2,
        "both changes must reach delta readers",
      );
      const elapsedMs = performance.now() - started;
      const used = process.cpuUsage(cpu);
      const report = {
        clients,
        legacyClients,
        rounds,
        intervalMs: interval,
        elapsedMs,
        churnElapsedMs,
        viewerRequests: requests,
        churnRequests,
        churn,
        total: traffic,
        churnFramesPerMinute:
          ((churn.delta.frames + churn.legacy.frames) * 60_000) / churnElapsedMs,
        churnBytesPerMinute: ((churn.delta.bytes + churn.legacy.bytes) * 60_000) / churnElapsedMs,
        cpuMs: (used.user + used.system) / 1000,
        rssBytes: process.memoryUsage().rss,
      };
      writeFileSync(values.output, JSON.stringify(report, null, 2) + "\n");
      console.log(JSON.stringify(report));
    }
  }
} finally {
  for (const peer of peers) {
    peer?.close();
  }
  await server.close();
}
