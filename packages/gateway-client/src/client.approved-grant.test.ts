// A device approved for fewer scopes than its client requests learns its grant
// from the Gateway's scope-upgrade refusal and can reconnect within it once.
import type { ConnectParams } from "@openclaw/gateway-protocol/frame-guards";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayClientOptions } from "./client.js";
import {
  sendChallenge,
  sendFrame,
  sendResponse,
  transportFixture,
} from "./client.transport.test-support.js";
import { rawDataToString } from "./websocket-data.js";

const { client: createClient, startWebSocketServer } = transportFixture();

async function connectRefusingScopeUpgrade(options: Partial<GatewayClientOptions>) {
  const { server, url } = await startWebSocketServer();
  const requests: ConnectParams[] = [];
  const connected = createDeferred();
  const paused = createDeferred();
  server.on("connection", (socket) => {
    sendChallenge(socket, { nonce: `nonce-${requests.length}`, ts: Date.now() });
    socket.once("message", (raw) => {
      const frame = JSON.parse(rawDataToString(raw)) as { id: string; params: ConnectParams };
      requests.push(frame.params);
      if (frame.params.scopes?.includes("operator.read")) {
        sendFrame(socket, {
          type: "res",
          id: frame.id,
          ok: false,
          error: {
            code: "NOT_PAIRED",
            message: "scope upgrade pending approval",
            details: {
              code: "PAIRING_REQUIRED",
              reason: "scope-upgrade",
              approvedScopes: ["operator.sessions.write"],
            },
          },
        });
      } else {
        sendResponse(socket, frame.id, { type: "hello-ok", protocol: 4 });
      }
    });
  });
  const onConnectError = vi.fn();
  const client = createClient({
    url,
    scopes: ["operator.admin", "operator.read"],
    deviceIdentity: null,
    onConnectError,
    onHelloOk: () => connected.resolve(),
    onReconnectPaused: () => paused.resolve(),
    ...options,
  });
  client.start();
  const outcome = await Promise.race([
    connected.promise.then(() => "connected" as const),
    paused.promise.then(() => "paused" as const),
  ]);
  return { outcome, requests, onConnectError };
}

it("reconnects once within the approved grant the refusal reports", async () => {
  const fit = vi.fn((approved: string[]) => [...approved]);
  const { outcome, requests, onConnectError } = await connectRefusingScopeUpgrade({
    fitScopesToApprovedGrant: fit,
  });

  expect(outcome).toBe("connected");
  expect(fit).toHaveBeenCalledWith(["operator.sessions.write"]);
  expect(requests.map((request) => request.scopes)).toEqual([
    ["operator.admin", "operator.read"],
    ["operator.sessions.write"],
  ]);
  expect(onConnectError).not.toHaveBeenCalled();
});

it.each([
  ["without the hook", {}],
  ["when the hook keeps the request", { fitScopesToApprovedGrant: () => undefined }],
])("pauses on the refusal %s", async (_name, options) => {
  const { outcome, requests, onConnectError } = await connectRefusingScopeUpgrade(options);

  expect(outcome).toBe("paused");
  expect(requests).toHaveLength(1);
  expect(onConnectError).toHaveBeenCalledTimes(1);
});
