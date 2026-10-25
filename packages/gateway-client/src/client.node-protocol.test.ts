import type { ConnectParams } from "@openclaw/gateway-protocol/frame-guards";
import { MIN_NODE_PROTOCOL_VERSION, PROTOCOL_VERSION } from "@openclaw/gateway-protocol/version";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  sendChallenge,
  sendFrame,
  sendResponse,
  transportFixture,
} from "./client.transport.test-support.js";
import { rawDataToString } from "./websocket-data.js";

const { startClient, startWebSocketServer } = transportFixture();

it.each([
  { platform: "macos", legacy: "darwin", family: "Mac", protocolBounds: {} },
  {
    platform: "macos",
    legacy: "darwin",
    family: "Mac",
    protocolBounds: { minProtocol: MIN_NODE_PROTOCOL_VERSION },
  },
  {
    platform: "windows",
    legacy: "win32",
    family: "Windows",
    protocolBounds: { maxProtocol: PROTOCOL_VERSION },
  },
])(
  "omits v4-only declarations from the signed $legacy fallback",
  async ({ platform, legacy, family, protocolBounds }) => {
    const { server, url } = await startWebSocketServer();
    const connected = createDeferred();
    const requests: ConnectParams[] = [];
    server.on("connection", (socket) => {
      sendChallenge(socket, { nonce: `nonce-${requests.length}`, ts: Date.now() });
      socket.once("message", (raw) => {
        const frame = JSON.parse(rawDataToString(raw)) as { id: string; params: ConnectParams };
        requests.push(frame.params);
        if (requests.length === 1) {
          sendFrame(socket, {
            type: "res",
            id: frame.id,
            ok: false,
            error: {
              code: "INVALID_REQUEST",
              message: "protocol mismatch",
              details: { code: "PROTOCOL_MISMATCH", expectedProtocol: MIN_NODE_PROTOCOL_VERSION },
            },
          });
        } else {
          sendResponse(socket, frame.id, { type: "hello-ok", protocol: MIN_NODE_PROTOCOL_VERSION });
        }
      });
    });
    const signDevicePayload = vi.fn((_key: string, _payload: string) => "synthetic-signature");
    const computerUse = { version: 1 };
    const workerRuns = {
      bundleHash: "a".repeat(64),
      openclawVersion: "2026.8.12",
      protocolFeatures: ["worker-heartbeat-v1"],
    };
    startClient({
      url,
      ...protocolBounds,
      role: "node",
      mode: "node",
      clientName: "node-host",
      platform,
      deviceFamily: family,
      modelIdentifier: "TestMachine1,1",
      commands: ["system.run"],
      computerUse,
      workerRuns,
      deviceIdentity: {
        deviceId: "synthetic-device",
        privateKeyPem: "synthetic-key",
        publicKeyPem: "synthetic-public",
      },
      hostDeps: { signDevicePayload, publicKeyRawBase64UrlFromPem: () => "synthetic-public" },
      onHelloOk: () => connected.resolve(),
    });
    await connected.promise;
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: { platform, deviceFamily: family, modelIdentifier: "TestMachine1,1" },
      commands: ["system.run"],
      computerUse,
      workerRuns,
    });
    expect(signDevicePayload.mock.calls[0]?.[1].split("|").slice(9)).toEqual([
      platform,
      family.toLowerCase(),
    ]);
    expect(requests[1]).toMatchObject({
      minProtocol: MIN_NODE_PROTOCOL_VERSION,
      maxProtocol: MIN_NODE_PROTOCOL_VERSION,
      client: { platform: legacy },
      commands: ["system.run"],
    });
    for (const field of ["computerUse", "workerRuns"]) {
      expect(requests[1]).not.toHaveProperty(field);
    }
    expect(requests[1]?.client).not.toHaveProperty("deviceFamily");
    expect(requests[1]?.client).not.toHaveProperty("modelIdentifier");
    expect(signDevicePayload.mock.calls[1]?.[1].split("|").slice(9)).toEqual([legacy, ""]);
    expect(requests[0]?.device?.nonce).toBe("nonce-0");
    expect(requests[1]?.device?.nonce).toBe("nonce-1");
  },
);
