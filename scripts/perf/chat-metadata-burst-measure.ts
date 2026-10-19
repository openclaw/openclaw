// Cold usage-cache catch-up through the real Gateway and signed synthetic WebSocket clients.
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import WebSocket from "ws";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import type { OpenClawConfig } from "../../src/config/types.openclaw.ts";
import type { SessionsUsageResult } from "../../src/shared/usage-types.ts";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    port: { type: "string", default: "41483" },
    clients: { type: "string", default: "10" },
    output: { type: "string" },
    duration: { type: "string", default: "60000" },
    "metadata-owner": { type: "string" },
    "start-at": { type: "string" },
  },
});
assert(values.root && values.output);
const root = path.resolve(values.root);
const port = Number(values.port);
assert(port >= 40000 && port <= 65535);
const fixture = JSON.parse(readFileSync(path.join(root, "team-shape-summary.json"), "utf8"));
assert(fixture.format === "openclaw-team-shape-v1" && fixture.sessionCount === 5000);
Object.assign(process.env, {
  HOME: path.join(root, "home"),
  OPENCLAW_HOME: path.join(root, "home"),
  OPENCLAW_STATE_DIR: root,
  OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
  TMPDIR: path.join(root, "tmp"),
  OPENCLAW_SKIP_CHANNELS: "1",
});
const config: OpenClawConfig = JSON.parse(readFileSync(process.env.OPENCLAW_CONFIG_PATH!, "utf8"));
config.gateway = {
  ...config.gateway,
  controlUi: { enabled: false, allowedOrigins: [`http://127.0.0.1:${port}`] },
};
config.agents = {
  ...config.agents,
  defaults: { ...config.agents?.defaults, model: "synthetic/model" },
};
writeFileSync(process.env.OPENCLAW_CONFIG_PATH!, JSON.stringify(config));
// Inspect the exclusively owned fixture before the Gateway opens it.
const { openNodeSqliteDatabase } = await import("../../src/infra/node-sqlite.ts");
const { resolveOpenClawAgentSqlitePath } =
  await import("../../src/state/openclaw-agent-db.paths.ts");
const { readSessionCostUsageRollupRowsInDatabase } =
  await import("../../src/infra/session-cost-usage-cache.kernel.ts");
const fixtureDb = openNodeSqliteDatabase(resolveOpenClawAgentSqlitePath({ agentId: "main" }), {
  readOnly: true,
});
try {
  assert.equal(readSessionCostUsageRollupRowsInDatabase(fixtureDb).length, 0, "fixture is warm");
} finally {
  fixtureDb.close();
}
let ownerLoads = 0;
if (values["metadata-owner"]) {
  const owner = new URL("../../src/gateway/server-chat-metadata-lifecycle.ts", import.meta.url)
    .href;
  const baseline = pathToFileURL(path.resolve(values["metadata-owner"])).href;
  assert.notEqual(owner, baseline);
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const result = nextResolve(specifier, context);
      if (result.url !== owner) {
        return result;
      }
      ownerLoads++;
      return { ...result, url: baseline };
    },
  });
}
const { startGatewayServer } = await import("../../src/gateway/server.js");
const { createGatewayWsClient } = await import("../lib/gateway-ws-client.ts");
const { PROTOCOL_VERSION } = await import("../../packages/gateway-protocol/src/version.ts");
const { buildDeviceAuthPayloadV3 } =
  await import("../../packages/gateway-client/src/device-auth.ts");
const { publicKeyRawBase64UrlFromEd25519Pem, signEd25519Payload } =
  await import("../../src/infra/ed25519-signature.ts");
if (values["start-at"]) {
  const wait = Number(values["start-at"]) - Date.now();
  assert(wait > 0, "missed the paired Gateway launch schedule");
  await delay(wait);
}
const server = await startGatewayServer(port, { bind: "loopback", controlUiEnabled: false });
const { getSessionCostUsageUpdatedAt, sessionCostUsageNotifications } =
  await import("../../src/infra/session-cost-usage-events.ts");
const publish = sessionCostUsageNotifications.onUpdated;
let publications = 0;
let publicationTicks = 0;
let tick: ReturnType<typeof setImmediate> | undefined;
sessionCostUsageNotifications.onUpdated = (publication) => {
  publications++;
  if (!tick) {
    tick = setImmediate(() => {
      publicationTicks++;
      tick = undefined;
    });
  }
  publish(publication);
};
const peers: ReturnType<typeof createGatewayWsClient>[] = [];
const latestUsage: number[] = [];
const events: Array<{
  at: number;
  bytes: number;
  cause: string;
  agentId?: string;
  failed?: boolean;
}> = [];
let measured = false;
let started = 0;
let sendCpuUs = 0;
let sendFrames = 0;
// The proxy preserves both send overloads and forwards the original socket receiver.
// eslint-disable-next-line @typescript-eslint/unbound-method
const originalSend = WebSocket.prototype.send;
WebSocket.prototype.send = new Proxy(originalSend, {
  apply(target, socket, args) {
    const data = args[0];
    const encoded = Buffer.isBuffer(data)
      ? data.toString("utf8")
      : typeof data === "string"
        ? data
        : "";
    if (!measured || !encoded.includes('"event":"chat.metadata.changed"')) {
      return Reflect.apply(target, socket, args);
    }
    const cpu = process.threadCpuUsage();
    try {
      return Reflect.apply(target, socket, args);
    } finally {
      const used = process.threadCpuUsage(cpu);
      sendCpuUs += used.user + used.system;
      sendFrames++;
    }
  },
});
async function rpc(peer: (typeof peers)[number], method: string, params: unknown) {
  const response = await peer.request(method, params, 120000);
  assert(response.ok, JSON.stringify(response.error));
  return response.payload;
}
try {
  for (let index = 0; index < Number(values.clients); index++) {
    const challenge = Promise.withResolvers<{ nonce: string; ts: number }>();
    const peer = createGatewayWsClient({
      url: `ws://127.0.0.1:${port}`,
      origin: `http://127.0.0.1:${port}`,
      onEvent(event) {
        const payload = isRecord(event.payload) ? event.payload : undefined;
        if (
          event.event === "connect.challenge" &&
          typeof payload?.nonce === "string" &&
          typeof payload.ts === "number"
        ) {
          challenge.resolve({ nonce: payload.nonce, ts: payload.ts });
        }
        if (
          event.event === "chat.metadata.changed" &&
          typeof payload?.usageUpdatedAt === "number"
        ) {
          latestUsage[index] = payload.usageUpdatedAt;
        }
        if (measured && event.event === "chat.metadata.changed") {
          events.push({
            at: performance.now() - started,
            bytes: Buffer.byteLength(JSON.stringify(event)),
            cause:
              typeof payload?.usageUpdatedAt === "number"
                ? "usage"
                : payload?.modelSelectionChanged
                  ? "selection"
                  : payload?.modelCatalogChanged
                    ? "catalog"
                    : "other",
            agentId: typeof payload?.agentId === "string" ? payload.agentId : undefined,
            failed: payload?.usageRefreshFailed === true,
          });
        }
      },
    });
    peers.push(peer);
    await peer.waitOpen();
    const { nonce, ts } = await challenge.promise;
    const keys = generateKeyPairSync("ed25519");
    const publicKey = publicKeyRawBase64UrlFromEd25519Pem(
      keys.publicKey.export({ type: "spki", format: "pem" }),
    );
    const deviceId = createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("hex");
    const client = {
      id: "openclaw-control-ui",
      version: "dev",
      platform: "web",
      mode: "webchat",
      instanceId: `metadata-${index}`,
    };
    const scopes = ["operator.admin", "operator.read", "operator.write"];
    const signed = buildDeviceAuthPayloadV3({
      deviceId,
      clientId: client.id,
      clientMode: client.mode,
      platform: client.platform,
      role: "operator",
      scopes,
      signedAtMs: ts,
      nonce,
    });
    await rpc(peer, "connect", {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client,
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
      caps: [],
    });
  }
  assert.equal(
    getSessionCostUsageUpdatedAt(),
    0,
    "startup refreshed usage before every client connected; reject the partial sample",
  );
  measured = true;
  started = performance.now();
  const cpu = process.threadCpuUsage();
  const first = (await rpc(peers[0]!, "sessions.usage", {
    agentId: "main",
    range: "all",
    projection: "overview",
    limit: 50,
  })) as SessionsUsageResult;
  console.log("Initial usage response", first.cacheStatus);
  await delay(Math.max(0, Number(values.duration) - (performance.now() - started)));
  const used = process.threadCpuUsage(cpu);
  const elapsed = performance.now() - started;
  measured = false;
  assert(publications > 0, "the fixture was already warm; no usage burst was measured");
  const final = (await rpc(peers[0]!, "sessions.usage", {
    agentId: "main",
    range: "all",
    projection: "overview",
    limit: 50,
  })) as SessionsUsageResult;
  assert.equal(final.cacheStatus?.pendingFiles, 0);
  assert.equal(final.cacheStatus?.cachedFiles, 5000);
  if (values["metadata-owner"]) {
    assert(ownerLoads > 0, "baseline owner was not loaded");
  }
  for (let index = 0; index < peers.length; index++) {
    assert.equal(
      latestUsage[index],
      getSessionCostUsageUpdatedAt(),
      `socket ${index} missed the latest usage commit`,
    );
  }
  const report = {
    elapsed,
    mainThreadCpu: used,
    sendCpuUs,
    sendFrames,
    clients: peers.length,
    publications,
    publicationTicks,
    events,
    final: { cacheStatus: final.cacheStatus, totals: final.totals },
    framesPerMinute: (events.length * 60000) / elapsed,
  };
  writeFileSync(values.output, JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({
      ...report,
      events: {
        count: events.length,
        causes: Object.fromEntries(
          ["usage", "selection", "catalog", "other"].map((cause) => [
            cause,
            events.filter((e) => e.cause === cause).length,
          ]),
        ),
      },
    }),
  );
} finally {
  WebSocket.prototype.send = originalSend;
  for (const peer of peers) {
    peer.close();
  }
  await server.close({ reason: "synthetic metadata measurement complete" });
  clearImmediate(tick);
}
