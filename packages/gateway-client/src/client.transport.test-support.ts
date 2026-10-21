import { once } from "node:events";
import type { Server as HttpServer } from "node:http";
import type { Server as HttpsServer } from "node:https";
import type { AddressInfo, Server, Socket } from "node:net";
import { promisify } from "node:util";
import { afterEach } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { GatewayClient, type GatewayClientOptions } from "./client.js";
import { WebSocketServer } from "./websocket.test-support.js";

export function transportFixture(beforeSocketCleanup = () => {}) {
  const servers: Server[] = [];
  const websockets: WebSocketServer[] = [];
  const clients: GatewayClient[] = [];
  const sockets = new Set<Socket>();
  let drained = createDeferred();
  function trackSocket(socket: Socket) {
    if (!sockets.size) {
      drained = createDeferred();
    }
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
      if (!sockets.size) {
        drained.resolve();
      }
    });
  }
  async function waitForSocketDrain() {
    // A newly accepted socket can start another drain generation while we await.
    while (sockets.size) {
      await drained.promise;
    }
  }
  function client(options: GatewayClientOptions) {
    const value = new GatewayClient(options);
    clients.push(value);
    return value;
  }
  function startClient(options: GatewayClientOptions) {
    const error = createDeferred<Error>();
    const value = client({ onConnectError: error.resolve, ...options });
    value.start();
    return { client: value, failed: error.promise };
  }
  function websocketServer(server: HttpServer | HttpsServer) {
    const value = new WebSocketServer({ server });
    websockets.push(value);
    return value;
  }
  async function startWebSocketServer() {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    websockets.push(server);
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("websocket address unavailable");
    }
    return {
      server,
      url: `ws://127.0.0.1:${address.port}`,
      origin: `http://127.0.0.1:${address.port}`,
    };
  }
  async function listen(server: Server) {
    servers.push(server);
    server.on("connection", trackSocket);
    const listening = once(server, "listening");
    server.listen(0, "127.0.0.1");
    await listening;
    return (server.address() as AddressInfo).port;
  }
  afterEach(async () => {
    for (const value of clients.splice(0)) {
      await value.stopAndWait();
    }
    for (const server of websockets.splice(0)) {
      for (const socket of server.clients) {
        socket.terminate();
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
    beforeSocketCleanup();
    for (const socket of sockets) {
      socket.destroy();
    }
    for (const server of servers.splice(0).toReversed()) {
      await promisify(server.close.bind(server))();
    }
    await waitForSocketDrain();
  });
  return {
    client,
    startClient,
    websocketServer,
    startWebSocketServer,
    listen,
    trackSocket,
    waitForSocketDrain,
  };
}

export function sendFrame(socket: { send(data: string): void }, frame: unknown) {
  socket.send(JSON.stringify(frame));
}

export function sendResponse(socket: { send(data: string): void }, id: string, payload: unknown) {
  sendFrame(socket, { type: "res", id, ok: true, payload });
}

export function sendChallenge(socket: { send(data: string): void }, payload: unknown) {
  sendFrame(socket, { type: "event", event: "connect.challenge", payload });
}
