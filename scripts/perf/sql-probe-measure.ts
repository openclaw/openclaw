// Synthetic Gateway WS -> HTTP pairing, plus the production capture worker IPC API.
// Run with the frozen observer in NODE_OPTIONS and SQLMEASURE_OUT set. For per-thread
// CPU profiles, add --cpu-prof --cpu-prof-dir=... and
// --import ./scripts/lib/gateway-bench-cpu-profile.mjs before --import ./scripts/tsx.mjs.
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { buildDeviceAuthPayloadV3 } from "../../packages/gateway-client/src/device-auth.ts";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.ts";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import {
  publicKeyRawBase64UrlFromEd25519Pem,
  signEd25519Payload,
} from "../../src/infra/ed25519-signature.ts";
import { BASE_GATEWAY_BENCH_CONFIG, waitForInitialProbe } from "../lib/gateway-bench-runtime.ts";
import { createGatewayWsClient } from "../lib/gateway-ws-client.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    output: { type: "string" },
    port: { type: "string", default: "41515" },
    samples: { type: "string", default: "5" },
  },
});
assert(values.root, "--root must name a new, exclusively owned synthetic directory");
assert(values.output, "--output is required");
const root = path.resolve(values.root);
const output = path.resolve(values.output);
const port = parseStrictIntegerOption({
  raw: values.port,
  label: "--port",
  min: 1024,
  fallback: 41515,
});
assert(port <= 65535, "--port must be at most 65535");
const warmSamples = parseStrictIntegerOption({
  raw: values.samples,
  label: "--samples",
  min: 1,
  fallback: 5,
});
await mkdir(root);
await mkdir(path.dirname(output), { recursive: true });
if (process.env.SQLMEASURE_OUT) {
  await mkdir(process.env.SQLMEASURE_OUT, { recursive: true });
}
async function phase(name: string) {
  if (process.env.SQLMEASURE_OUT) {
    await writeFile(path.join(process.env.SQLMEASURE_OUT, "phase"), name);
  }
}
const samples: Array<{ phase: string; elapsedMs: number; processCpuMs: number }> = [];
async function measure<T>(name: string, action: () => Promise<T>): Promise<T> {
  await phase(name);
  const cpu = process.cpuUsage();
  const started = performance.now();
  const result = await action();
  const used = process.cpuUsage(cpu);
  samples.push({
    phase: name,
    elapsedMs: performance.now() - started,
    processCpuMs: (used.user + used.system) / 1_000,
  });
  return result;
}

const configPath = path.join(root, "openclaw.json");
const token = randomBytes(32).toString("base64url");
Object.assign(process.env, {
  HOME: root,
  OPENCLAW_HOME: root,
  OPENCLAW_STATE_DIR: path.join(root, "state"),
  OPENCLAW_CONFIG_PATH: configPath,
  OPENCLAW_GATEWAY_TOKEN: token,
  OPENCLAW_SKIP_CHANNELS: "1",
});
await writeFile(
  configPath,
  JSON.stringify({
    ...BASE_GATEWAY_BENCH_CONFIG,
    gateway: { ...BASE_GATEWAY_BENCH_CONFIG.gateway, auth: { mode: "token", token } },
    agents: {
      defaults: { model: "synthetic/model", skipBootstrap: true },
      entries: { main: { workspace: path.join(root, "workspace") } },
    },
    memory: { search: { enabled: false } },
    cron: { enabled: false },
    plugins: { enabled: false },
  }),
  { mode: 0o600 },
);
await phase("setup");
const { startGatewayServer } = await import("../../src/gateway/server.ts");
const { decodePairingSetupCode } = await import("../../src/pairing/setup-code.ts");
const { acquireDebugProxyCaptureStoreAsync } =
  await import("../../src/proxy-capture/store.async.ts");
const server = await startGatewayServer(port, { bind: "loopback", controlUiEnabled: false });
let peer: ReturnType<typeof createGatewayWsClient> | undefined;
let capture: Awaited<ReturnType<typeof acquireDebugProxyCaptureStoreAsync>> | undefined;
try {
  const readyStart = performance.now();
  const ready = await waitForInitialProbe({
    deadlineAt: readyStart + 60_000,
    path: "/readyz",
    port,
    startAt: readyStart,
  });
  assert.equal(ready.status, 200, "Gateway did not become ready");
  const challenge = Promise.withResolvers<{ nonce: string; ts: number }>();
  peer = createGatewayWsClient({
    url: `ws://127.0.0.1:${port}`,
    onEvent(event) {
      if (event.event === "connect.challenge" && isRecord(event.payload)) {
        const { nonce, ts } = event.payload;
        if (typeof nonce === "string" && typeof ts === "number") {
          challenge.resolve({ nonce, ts });
        }
      }
    },
  });
  const deadline = setTimeout(() => challenge.reject(new Error("No Gateway challenge")), 60_000);
  let nonce: string;
  let ts: number;
  try {
    await peer.waitOpen();
    ({ nonce, ts } = await challenge.promise);
  } finally {
    clearTimeout(deadline);
  }
  const keys = generateKeyPairSync("ed25519");
  const publicKey = publicKeyRawBase64UrlFromEd25519Pem(
    keys.publicKey.export({ type: "spki", format: "pem" }),
  );
  const deviceId = createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("hex");
  const client = { id: "gateway-client", version: "dev", platform: "web", mode: "backend" };
  const scopes = ["operator.admin", "operator.read", "operator.write"];
  const connected = await peer.request("connect", {
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    client,
    role: "operator",
    scopes,
    caps: [],
    auth: { token },
    device: {
      id: deviceId,
      publicKey,
      nonce,
      signedAt: ts,
      signature: signEd25519Payload(
        keys.privateKey.export({ type: "pkcs8", format: "pem" }),
        buildDeviceAuthPayloadV3({
          deviceId,
          clientId: client.id,
          clientMode: client.mode,
          platform: client.platform,
          role: "operator",
          scopes,
          signedAtMs: ts,
          token,
          nonce,
        }),
      ),
    },
  });
  assert(connected.ok, "Authenticated synthetic Gateway connect failed");
  const controller = peer;
  for (let index = 0; index <= warmSamples; index++) {
    const temperature = index === 0 ? "cold" : `warm-${index}`;
    const minted = await measure(`pairing.mint.${temperature}`, () =>
      controller.request(
        "device.pair.setupCode",
        {
          bootstrapProfile: "node",
          includeQr: false,
          publicUrl: `ws://127.0.0.1:${port}`,
          joinUrl: true,
        },
        60_000,
      ),
    );
    assert(minted.ok && isRecord(minted.payload), "Pairing mint failed");
    const { setupCode, joinUrl } = minted.payload;
    assert(typeof setupCode === "string" && typeof joinUrl === "string", "Missing pairing output");
    assert(
      new URL(joinUrl).origin === `http://127.0.0.1:${port}`,
      "Join URL escaped synthetic Gateway",
    );
    const expected = Buffer.from(JSON.stringify(decodePairingSetupCode(setupCode)));
    const missing = Buffer.from('{"error":"not_found"}');
    for (const outcome of ["redeem", "replay"] as const) {
      await measure(`pairing.${outcome}.${temperature}`, async () => {
        const response = await fetch(joinUrl, { signal: AbortSignal.timeout(60_000) });
        assert.equal(response.status, outcome === "redeem" ? 200 : 404);
        assert.equal(response.headers.get("cache-control"), "no-store");
        const body = Buffer.from(await response.arrayBuffer());
        // Boolean comparison keeps bootstrap credentials out of assertion output.
        assert(
          body.equals(outcome === "redeem" ? expected : missing),
          "Pairing redemption/replay returned the wrong response bytes",
        );
      });
    }
  }

  await phase("capture.setup");
  capture = await acquireDebugProxyCaptureStoreAsync();
  const store = capture.store;
  for (let index = 0; index <= warmSamples; index++) {
    const temperature = index === 0 ? "cold" : `warm-${index}`;
    await phase(`capture.fixture.${temperature}`);
    const ids = [`synthetic-capture-${index}-a`, `synthetic-capture-${index}-b`];
    const payload = `Synthetic shared capture payload ${index}`;
    const blob = await store.persistPayload(Buffer.from(payload), "text/plain");
    for (const sessionId of ids) {
      await store.recordEvent({
        sessionId,
        ts: 1,
        sourceScope: "openclaw",
        sourceProcess: "synthetic",
        protocol: "https",
        direction: "outbound",
        kind: "request",
        flowId: "synthetic",
        dataBlobId: blob.blobId,
        dataSha256: blob.sha256,
      });
    }
    for (const [offset, sessionId] of ids.entries()) {
      const result = await measure(`capture.delete-${offset}.${temperature}`, () =>
        store.deleteSessions([sessionId]),
      );
      assert.deepEqual(result, { sessions: 1, events: 1, blobs: offset });
      await phase(`capture.verify-${offset}.${temperature}`);
      assert(
        (await store.readBlob(blob.blobId)) === (offset === 0 ? payload : null),
        "Shared capture payload retention mismatch",
      );
    }
    const missing = await measure(`capture.missing.${temperature}`, () =>
      store.deleteSessions(ids),
    );
    assert.deepEqual(missing, { sessions: 0, events: 0, blobs: 0 });
  }
  await phase("complete");
  await writeFile(
    output,
    `${JSON.stringify(
      {
        format: "sql-probe-v1",
        warmSamples,
        transports: { pairing: "Gateway WebSocket + HTTP", capture: "async store worker IPC" },
        limitations: [
          "Capture deletion exercises production IPC, not the QA Lab HTTP endpoint.",
          "Audit progress overflow is covered separately at its native/PG writer owner.",
          "Pairing mint includes the production package-resolution network lookup.",
          "Elapsed/CPU samples require the campaign timing lock before making timing claims.",
        ],
        samples,
      },
      null,
      2,
    )}\n`,
  );
  console.log(JSON.stringify({ warmSamples, measuredOperations: samples.length }));
} finally {
  await phase("shutdown");
  peer?.close();
  try {
    await capture?.release();
  } finally {
    await server.close({ reason: "synthetic SQL probe workload finished" });
  }
}
