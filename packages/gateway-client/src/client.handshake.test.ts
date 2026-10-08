// Gateway Client tests cover websocket opening-handshake timeout behavior.
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { validatePreviousConnectParams } from "../../gateway-protocol/src/connect-compatibility.test-support.js";
import { GATEWAY_SERVER_CAPS, validateConnectParams } from "../../gateway-protocol/src/index.js";
import { GatewayClient } from "./client.js";
import { rawDataToString } from "./websocket-data.js";
import { WebSocketServer } from "./websocket.test-support.js";

describe("GatewayClient websocket opening handshakeTimeout", () => {
  const servers: net.Server[] = [];
  const sockets: net.Socket[] = [];
  const clients: GatewayClient[] = [];

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      client.stop();
    }
    for (const socket of sockets.splice(0)) {
      socket.destroy();
    }
    for (const server of servers) {
      (server as net.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
    }
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((err) => (err ? reject(err) : resolve()));
          }),
      ),
    );
  });

  async function listen(server: net.Server): Promise<number> {
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    return (server.address() as AddressInfo).port;
  }

  it.each([
    { advertised: false, modelCatalog: { agentId: "alpha" } },
    { advertised: true, modelCatalog: { agentId: "alpha", sessionKey: "agent:alpha:saved" } },
  ])(
    "negotiates catalog input with a compatible Gateway: %j",
    async ({ advertised, modelCatalog }) => {
      const server = http.createServer();
      const wss = new WebSocketServer({ server });
      const port = await listen(server);
      const connected = createDeferred();
      const received = createDeferred<{ id: string; params: unknown }>();
      wss.on("connection", (socket) => {
        socket.send(
          JSON.stringify({
            type: "event",
            event: "connect.challenge",
            payload: {
              nonce: "catalog-handshake",
              ts: Date.now(),
              ...(advertised ? { capabilities: [GATEWAY_SERVER_CAPS.MODEL_CATALOG_SNAPSHOT] } : {}),
            },
          }),
        );
        socket.once("message", (raw) => {
          const frame = JSON.parse(rawDataToString(raw)) as { id: string; params: unknown };
          received.resolve(frame);
          const valid = advertised
            ? validateConnectParams(frame.params)
            : validatePreviousConnectParams(frame.params);
          socket.send(
            JSON.stringify({
              type: "res",
              id: frame.id,
              ok: valid,
              ...(valid
                ? { payload: { type: "hello-ok", protocol: 4 } }
                : { error: { code: "INVALID_REQUEST", message: "invalid connect params" } }),
            }),
          );
        });
      });
      const client = new GatewayClient({
        url: `ws://127.0.0.1:${port}`,
        deviceIdentity: null,
        modelCatalog,
        onHelloOk: () => connected.resolve(),
        onConnectError: connected.reject,
      });
      clients.push(client);
      try {
        client.start();
        await connected.promise;
        const frame = await received.promise;
        if (advertised) {
          expect(frame.params).toMatchObject({
            modelCatalog,
            caps: ["model-catalog-snapshot"],
          });
        } else {
          expect(frame.params).not.toHaveProperty("modelCatalog");
          expect(frame.params).toMatchObject({ caps: [] });
        }
      } finally {
        await client.stopAndWait();
        for (const socket of wss.clients) {
          socket.terminate();
        }
        await new Promise<void>((resolve) => {
          wss.close(() => resolve());
        });
      }
    },
  );

  it("keeps a hello received during WebSocket closing in the pre-hello failure path", async () => {
    const server = http.createServer();
    const wss = new WebSocketServer({ server });
    const port = await listen(server);
    const onHelloOk = vi.fn();
    const onConnectError = vi.fn();
    const onClose = vi.fn();
    const onEvent = vi.fn();
    const closed = createDeferred();
    const lateFramesWritten = createDeferred();
    const client = new GatewayClient({
      url: `ws://127.0.0.1:${port}`,
      deviceIdentity: null,
      onHelloOk,
      onConnectError,
      onClose: (...args) => {
        onClose(...args);
        closed.resolve();
      },
      onEvent,
    });
    clients.push(client);
    wss.on("connection", (socket) => {
      socket.send(
        JSON.stringify({
          type: "event",
          event: "connect.challenge",
          payload: { nonce: "synthetic-nonce", ts: Date.now() },
        }),
      );
      socket.once("message", (raw) => {
        const frame = JSON.parse(rawDataToString(raw)) as { id: string };
        // Write both frames before admitting the peer's close reply, preserving
        // their wire order without waiting for retired application callbacks.
        socket.pause();
        client.updateNodeManifest({ caps: [], commands: [] });
        socket.send(
          JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { type: "hello-ok" } }),
        );
        socket.send(JSON.stringify({ type: "event", event: "late-hello-marker" }), (error) => {
          socket.resume();
          if (error) {
            lateFramesWritten.reject(error);
          } else {
            lateFramesWritten.resolve();
          }
        });
      });
    });
    try {
      client.start();
      await Promise.all([lateFramesWritten.promise, closed.promise]);
      expect(onEvent).not.toHaveBeenCalled();
      expect(onHelloOk).not.toHaveBeenCalled();
      expect(onConnectError).toHaveBeenCalledExactlyOnceWith(
        new Error("gateway closed (1012): node manifest changed"),
      );
      expect(onClose).toHaveBeenCalledExactlyOnceWith(
        1012,
        "node manifest changed",
        expect.objectContaining({ phase: "pre-hello", connectRequestSent: true }),
      );
    } finally {
      await client.stopAndWait();
      for (const socket of wss.clients) {
        socket.terminate();
      }
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
    }
  });

  it.each([
    {
      name: "a typed Gateway rejection",
      body: JSON.stringify({
        error: {
          type: "proxy_attribution_required",
          message: "Configure gateway.trustedProxies narrowly",
        },
      }),
      expectedDetails: {
        gatewayErrorType: "proxy_attribution_required",
        gatewayErrorMessage: "Configure gateway.trustedProxies narrowly",
      },
    },
    { name: "a non-object JSON body", body: "null", expectedDetails: {} },
  ])("preserves structured upgrade details for $name", async ({ body, expectedDetails }) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(body);
    });
    const port = await listen(server);
    const error = await new Promise<Error>((resolve) => {
      const client = new GatewayClient({
        url: `ws://127.0.0.1:${port}`,
        onConnectError: resolve,
      });
      clients.push(client);
      client.start();
    });

    expect(error).toMatchObject({
      details: {
        reason: "websocket-upgrade-rejected",
        httpStatus: 403,
        ...expectedDetails,
      },
    });
    if (!("gatewayErrorType" in expectedDetails)) {
      expect(error).not.toMatchObject({ details: { gatewayErrorType: expect.anything() } });
    }
  });

  it("caps a rejected websocket upgrade body before the peer ends it", async () => {
    const omittedTail = "omitted-tail-marker";
    const server = http.createServer((_req, res) => {
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.write(`${"x".repeat(3_000)}${omittedTail}`);
    });
    const port = await listen(server);
    const error = await new Promise<Error>((resolve) => {
      const client = new GatewayClient({
        url: `ws://127.0.0.1:${port}`,
        onConnectError: resolve,
      });
      clients.push(client);
      client.start();
    });

    expect(error.message).toHaveLength(
      "gateway rejected websocket upgrade (HTTP 503): ".length + 2 * 1024,
    );
    expect(error.message).not.toContain(omittedTail);
  });
});
