import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/index.js";
import { buildDeviceAuthPayloadV3 } from "../../src/gateway/device-auth.js";
import { startGatewayServer } from "../../src/gateway/server.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
} from "../../src/infra/device-identity.js";

async function getFreePort(): Promise<number> {
  const net = await import("node:net");
  return await new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("could not determine free port")));
      }
    });
    srv.once("error", reject);
  });
}

async function main() {
  console.log("=== Reproduction for issue #90654 (WebSocket handshake) ===");
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-repro-90654-ws-"));
  console.log("Temp state dir:", tmpDir);
  process.env.OPENCLAW_STATE_DIR = tmpDir;
  process.env.OPENCLAW_SKIP_CHANNELS = "1";
  process.env.OPENCLAW_SKIP_PROVIDERS = "1";
  process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = "1";
  process.env.VITEST = "true";

  const config = {
    gateway: {
      auth: { mode: "none" },
      controlUi: { enabled: false },
    },
  };
  await fs.mkdir(path.join(tmpDir, "devices"), { recursive: true });
  await fs.writeFile(path.join(tmpDir, "openclaw.json"), JSON.stringify(config, null, 2));

  const identity = await loadOrCreateDeviceIdentity(path.join(tmpDir, "device-identity.json"));
  const publicKey = publicKeyRawBase64UrlFromPem(identity.publicKeyPem);
  const deviceId = identity.deviceId;

  const paired = {
    [deviceId]: {
      deviceId,
      publicKey,
      displayName: "Repro Device",
      platform: "test",
      deviceFamily: "test",
      clientId: "openclaw-test",
      clientMode: "test",
      roles: ["operator", undefined, null, 42],
      scopes: ["read", undefined, null, 42],
      approvedScopes: ["read", undefined, null, 42],
      tokens: {},
      createdAtMs: Date.now(),
      approvedAtMs: Date.now(),
    },
  };
  await fs.writeFile(path.join(tmpDir, "devices", "paired.json"), JSON.stringify(paired));

  const port = await getFreePort();
  console.log(`Starting gateway on port ${port}...`);
  const server = await startGatewayServer(port, {
    auth: { mode: "none" },
    bind: "loopback",
    controlUiEnabled: false,
    deferStartupSidecars: true,
  });
  console.log("Gateway started.");

  // Give the server a moment to finish post-ready setup before connecting.
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 500);
  });

  console.log(`Connecting WebSocket to port ${port}...`);
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  let connectChallengeNonce: string | undefined;

  ws.on("open", () => console.log("[ws] open"));
  ws.on("error", (err) => console.log("[ws] error:", err.message));
  ws.on("close", (code, reason) => console.log("[ws] close:", code, reason.toString()));

  const response = await new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("timeout waiting for connect response")),
      15_000,
    );

    ws.on("message", (data) => {
      const text = data.toString();
      console.log("[ws] message:", text.slice(0, 500));
      let frame: unknown;
      try {
        frame = JSON.parse(text);
      } catch {
        return;
      }
      const rec = frame as Record<string, unknown>;
      const payload =
        rec.payload && typeof rec.payload === "object"
          ? (rec.payload as Record<string, unknown>)
          : undefined;
      if (
        rec.type === "event" &&
        rec.event === "connect.challenge" &&
        payload &&
        typeof payload.nonce === "string"
      ) {
        connectChallengeNonce = payload.nonce;
        console.log("Got challenge nonce:", connectChallengeNonce);
        sendConnect();
        return;
      }
      if (rec.type === "res") {
        resolved = true;
        clearTimeout(timer);
        resolve(frame);
      }
    });
    let resolved = false;
    ws.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    ws.once("close", (code, reason) => {
      clearTimeout(timer);
      // Give any in-flight response frame a moment to be delivered before treating close as failure.
      setTimeout(() => {
        if (!resolved) {
          reject(new Error(`closed ${code}: ${reason.toString()}`));
        }
      }, 100);
    });

    async function sendConnect() {
      const id = randomUUID();
      const client = {
        id: "test",
        version: "1.0.0",
        platform: "test",
        deviceFamily: "test",
        mode: "test",
      };
      const role = "operator"; // paired role is "operator"; scope mismatch triggers scope-upgrade audit
      const scopes = ["write"]; // different from paired "read" to trigger scope-upgrade audit
      const signedAtMs = Date.now();
      console.log("Sending connect with role:", role, "scopes:", scopes);
      const payload = buildDeviceAuthPayloadV3({
        deviceId,
        clientId: client.id,
        clientMode: client.mode,
        role,
        scopes,
        signedAtMs,
        token: null,
        nonce: connectChallengeNonce!,
        platform: client.platform,
        deviceFamily: client.deviceFamily,
      });
      const signature = signDevicePayload(identity.privateKeyPem, payload);
      ws.send(
        JSON.stringify({
          type: "req",
          id,
          method: "connect",
          params: {
            minProtocol: PROTOCOL_VERSION,
            maxProtocol: PROTOCOL_VERSION,
            client,
            caps: [],
            commands: [],
            role,
            scopes,
            device: {
              id: deviceId,
              publicKey,
              signature,
              signedAt: signedAtMs,
              nonce: connectChallengeNonce,
            },
          },
        }),
      );
    }
  });

  console.log("Connect response:", JSON.stringify(response, null, 2));
  ws.close();
  await server.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
  console.log("PASS: Gateway WebSocket handshake did not crash with malformed pairing state.");
}

main().catch((err: unknown) => {
  console.error("FAIL:", err);
  process.exitCode = 1;
});
