/** Synthetic authenticated WebSocket -> session reaction worker workload. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { createWriteStream, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { buildDeviceAuthPayloadV3 } from "../../packages/gateway-client/src/device-auth.ts";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.ts";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import {
  publicKeyRawBase64UrlFromEd25519Pem,
  signEd25519Payload,
} from "../../src/infra/ed25519-signature.ts";
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
  options: {
    out: { type: "string" },
    observer: { type: "string" },
    entry: { type: "string", default: "dist/entry.js" },
    "cpu-profile": { type: "boolean", default: false },
  },
});
assert(values.out && values.observer, "--out and --observer are required");
const out = path.resolve(values.out);
mkdirSync(out, { recursive: true });
const root = path.join(out, "gateway");
mkdirSync(root, { recursive: true });
const port = await getFreePort();
const token = "synthetic-reaction-benchmark";
const configPath = writeGatewayBenchConfig(
  root,
  {
    ...BASE_GATEWAY_BENCH_CONFIG,
    gateway: {
      ...BASE_GATEWAY_BENCH_CONFIG.gateway,
      port,
      auth: { mode: "token", token },
    },
  },
  { agentList: [{ id: "main", workspace: path.join(root, "workspace") }] },
);
const phase = (label: string) => writeFileSync(path.join(out, "phase"), label);
phase("boot");
const log = createWriteStream(path.join(out, "gateway.log"));
const child = spawn(
  process.execPath,
  buildGatewayBenchChildArgs(
    path.resolve(values.entry),
    port,
    gatewayBenchCpuProfileArgs(values["cpu-profile"] ? path.join(out, "profiles") : undefined),
    "token",
  ),
  {
    env: {
      ...createGatewayBenchEnv(root, configPath, {}),
      SQLMEASURE_OUT: out,
      NODE_OPTIONS: `--require=${path.resolve(values.observer)} --enable-source-maps`,
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    detached: true,
  },
);
child.stdout?.pipe(log);
child.stderr?.pipe(log);
let client: ReturnType<typeof createGatewayWsClient> | undefined;
const results: Array<{ phase: string; reactions: unknown }> = [];
try {
  const ready = await waitForInitialProbe({
    port,
    path: "/readyz",
    startAt: performance.now(),
    deadlineAt: performance.now() + 600_000,
    isDone: () => child.exitCode !== null || child.signalCode !== null,
  });
  assert.equal(ready.status, 200, "Gateway unavailable");
  phase("setup");
  const challenge = Promise.withResolvers<{ nonce: string; ts: number }>();
  client = createGatewayWsClient({
    url: `ws://127.0.0.1:${port}`,
    handshakeTimeoutMs: 30_000,
    openTimeoutMs: 30_000,
    onEvent(event) {
      const payload = event.payload;
      if (
        event.event === "connect.challenge" &&
        isRecord(payload) &&
        typeof payload.nonce === "string" &&
        typeof payload.ts === "number"
      ) {
        challenge.resolve({ nonce: payload.nonce, ts: payload.ts });
      }
    },
  });
  const rpc = async (method: string, params: unknown) => {
    assert(client);
    const reply = await client.request(method, params, 60_000);
    assert.equal(reply.ok, true, `${method}: ${JSON.stringify(reply.error)}`);
    assert(isRecord(reply.payload), `${method}: missing payload`);
    return reply.payload;
  };
  await client.waitOpen();
  const { nonce, ts } = await Promise.race([
    challenge.promise,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error("Device challenge timed out")), 30_000);
      timer.unref();
    }),
  ]);
  const keys = generateKeyPairSync("ed25519");
  const publicKey = publicKeyRawBase64UrlFromEd25519Pem(
    keys.publicKey.export({ type: "spki", format: "pem" }),
  );
  const deviceId = createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("hex");
  const scopes = ["operator.read", "operator.write", "operator.admin"];
  const identity = {
    id: "gateway-client",
    displayName: "synthetic-reaction-quota",
    version: "1.0.0",
    platform: process.platform,
    mode: "ui",
  };
  await rpc("connect", {
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    client: identity,
    role: "operator",
    scopes,
    auth: { token },
    device: {
      id: deviceId,
      publicKey,
      signedAt: ts,
      nonce,
      signature: signEd25519Payload(
        keys.privateKey.export({ type: "pkcs8", format: "pem" }),
        buildDeviceAuthPayloadV3({
          deviceId,
          clientId: identity.id,
          clientMode: identity.mode,
          platform: identity.platform,
          role: "operator",
          scopes,
          signedAtMs: ts,
          token,
          nonce,
        }),
      ),
    },
    caps: [],
  });
  const self = await rpc("users.self", {});
  assert(isRecord(self.profile) && typeof self.profile.id === "string");
  const sessionKey = "agent:main:synthetic-reaction-quota";
  await rpc("sessions.create", { agentId: "main", key: sessionKey });
  for (const temperature of ["first", "warm"]) {
    for (let sample = 0; sample < 5; sample++) {
      phase("setup");
      const injected = await rpc("chat.inject", {
        sessionKey,
        message: `Synthetic reaction message ${temperature}-${sample}`,
      });
      assert.equal(typeof injected.messageId, "string");
      for (const outcome of ["new", "duplicate", "remove"]) {
        const label = `${temperature}-${outcome}-${sample}`;
        phase(label);
        const response = await rpc("session.reactions.set", {
          sessionKey,
          messageId: injected.messageId,
          emoji: "👍",
          ...(outcome === "remove" ? { remove: true } : {}),
        });
        assert.deepEqual(
          response.reactions,
          outcome === "remove"
            ? []
            : [
                {
                  emoji: "👍",
                  count: 1,
                  identities: [
                    {
                      id: self.profile.id,
                      ...(self.profile.displayName ? { label: self.profile.displayName } : {}),
                    },
                  ],
                },
              ],
        );
        results.push({ phase: label, reactions: response.reactions });
      }
    }
  }
} finally {
  client?.close();
  phase("shutdown");
  await stopChild(child, { teardownGraceMs: 20_000 });
  log.end();
  writeFileSync(path.join(out, "results.json"), JSON.stringify(results, null, 2));
}
