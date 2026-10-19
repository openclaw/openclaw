// Synthetic viewer lifecycle workload through the real Gateway and WebSocket transport.
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { buildDeviceAuthPayloadV3 } from "../../packages/gateway-client/src/device-auth.ts";
import type { HelloOk } from "../../packages/gateway-protocol/src/index.js";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.ts";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import {
  publicKeyRawBase64UrlFromEd25519Pem,
  signEd25519Payload,
} from "../../src/infra/ed25519-signature.ts";
import { BASE_GATEWAY_BENCH_CONFIG } from "../lib/gateway-bench-runtime.ts";
import { createGatewayWsClient } from "../lib/gateway-ws-client.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    port: { type: "string", default: "41466" },
    clients: { type: "string", default: "42" },
    rounds: { type: "string", default: "20" },
    "interval-ms": { type: "string", default: "1000" },
    "start-at": { type: "string" },
    "viewer-owner": { type: "string", default: "ui/src/lib/session-viewer-presence.ts" },
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
const clients = integer(values.clients, "--clients", 3);
const rounds = integer(values.rounds, "--rounds", 1);
const interval = integer(values["interval-ms"], "--interval-ms", 250);
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
    agents: { entries: { main: { workspace: path.join(root, "workspace") } } },
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
let measured = false;
let requests = 0;
const failures: string[] = [];
async function rpc(peer: (typeof peers)[number], method: string, params: unknown) {
  const result = await peer.request(method, params, 60_000);
  assert(result.ok, `${method}: ${JSON.stringify(result.error)}`);
  return result.payload;
}
try {
  let actorHello: HelloOk | undefined;
  for (let index = 0; index < clients; index++) {
    const mode = index < 2 ? "legacy" : "delta";
    const challenge = Promise.withResolvers<{ nonce: string; ts: number }>();
    const peer = createGatewayWsClient({
      url: `ws://127.0.0.1:${port}`,
      origin: `http://127.0.0.1:${port}`,
      onEvent: (event) => {
        if (
          event.event === "connect.challenge" &&
          isRecord(event.payload) &&
          typeof event.payload.nonce === "string" &&
          typeof event.payload.ts === "number"
        ) {
          challenge.resolve({ nonce: event.payload.nonce, ts: event.payload.ts });
        }
        if (measured && event.event === "presence") {
          traffic[mode].frames++;
          traffic[mode].bytes += Buffer.byteLength(JSON.stringify(event));
        }
      },
    });
    peers.push(peer);
    await peer.waitOpen();
    const timeout = setTimeout(
      () => challenge.reject(new Error("connect challenge timed out")),
      12_000,
    );
    const { nonce, ts } = await challenge.promise.finally(() => clearTimeout(timeout));
    const keys = generateKeyPairSync("ed25519");
    const publicKey = publicKeyRawBase64UrlFromEd25519Pem(
      keys.publicKey.export({ type: "spki", format: "pem" }),
    );
    const deviceId = createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("hex");
    const identity = {
      id: "openclaw-control-ui",
      version: "dev",
      platform: "web",
      mode: "webchat",
      instanceId: `presence-bench-${index}`,
      displayName: `Synthetic workstation ${index}`,
    };
    const scopes = ["operator.admin"];
    const signed = buildDeviceAuthPayloadV3({
      deviceId,
      clientId: identity.id,
      clientMode: identity.mode,
      platform: identity.platform,
      role: "operator",
      scopes,
      signedAtMs: ts,
      nonce,
    });
    const hello = (await rpc(peer, "connect", {
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
      caps: mode === "delta" ? ["presence-deltas"] : [],
    })) as HelloOk;
    if (index === clients - 1) {
      actorHello = hello;
    }
  }
  assert(actorHello);
  const actor = peers.at(-1)!;
  const keys = ["agent:main:presence-bench-a", "agent:main:presence-bench-b"];
  for (const key of keys) {
    await rpc(actor, "sessions.create", {
      key,
      visibility: "shared",
      displayName: "Synthetic presence session",
    });
  }
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
    4,
    "both changes must reach legacy readers",
  );
  assert.equal(
    traffic.delta.frames - churn.delta.frames,
    (clients - 2) * 2,
    "both changes must reach delta readers",
  );
  const elapsedMs = performance.now() - started;
  const used = process.cpuUsage(cpu);
  const report = {
    clients,
    legacyClients: 2,
    rounds,
    intervalMs: interval,
    elapsedMs,
    churnElapsedMs,
    viewerRequests: requests,
    churnRequests,
    churn,
    total: traffic,
    churnFramesPerMinute: ((churn.delta.frames + churn.legacy.frames) * 60_000) / churnElapsedMs,
    churnBytesPerMinute: ((churn.delta.bytes + churn.legacy.bytes) * 60_000) / churnElapsedMs,
    cpuMs: (used.user + used.system) / 1000,
    rssBytes: process.memoryUsage().rss,
  };
  writeFileSync(values.output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
} finally {
  for (const peer of peers) {
    peer.close();
  }
  await server.close();
}
