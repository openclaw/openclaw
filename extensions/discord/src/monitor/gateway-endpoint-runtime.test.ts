import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { createDiscordGatewayPlugin } from "./gateway-plugin.js";

let server: WebSocketServer | undefined;
const DISCORD_API_URL_ENV = "DISCORD_API_URL";

afterEach(async () => {
  delete process.env[DISCORD_API_URL_ENV];
  if (server) {
    for (const client of server.clients) {
      client.terminate();
    }
    const currentServer = server;
    await new Promise<void>((resolve) => {
      currentServer.close(() => resolve());
    });
    server = undefined;
  }
});

describe("Discord Gateway endpoint environment", () => {
  it("keeps initial and resumed sockets on the configured API origin", async () => {
    server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("expected loopback TCP address");
    }
    const origin = `ws://127.0.0.1:${address.port}`;
    process.env[DISCORD_API_URL_ENV] = `http://127.0.0.1:${address.port}/api/v10`;
    const plugin = createDiscordGatewayPlugin({
      discordConfig: {},
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      testing: { webSocketCtor: WebSocket },
    });
    const createWebSocket = Reflect.get(plugin, "createWebSocket");
    if (typeof createWebSocket !== "function") {
      throw new Error("expected Gateway WebSocket factory");
    }

    for (const suffix of ["?v=10", "?resume=1"]) {
      const connection = once(server, "connection");
      const socket = Reflect.apply(createWebSocket, plugin, [`${origin}/gateway${suffix}`]);
      if (!(socket instanceof WebSocket)) {
        throw new Error("expected ws WebSocket");
      }
      await Promise.all([connection, once(socket, "open")]);
      socket.close();
      await once(socket, "close");
    }

    expect(() =>
      Reflect.apply(createWebSocket, plugin, ["wss://gateway.discord.gg/?v=10"]),
    ).toThrow(/outside the configured WebSocket origin/);
  });
});
