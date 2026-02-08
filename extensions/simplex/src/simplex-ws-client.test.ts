import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { SimplexWsClient } from "./simplex-ws-client.js";

type ServerInfo = {
  wss: WebSocketServer;
  url: string;
};

let server: ServerInfo | null = null;

function startServer(): ServerInfo {
  const wss = new WebSocketServer({ port: 0 });
  const address = wss.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind websocket server");
  }
  return { wss, url: `ws://127.0.0.1:${address.port}` };
}

function stopServer(wss: WebSocketServer): Promise<void> {
  return new Promise((resolve) => wss.close(() => resolve()));
}

describe("SimplexWsClient", () => {
  beforeEach(() => {
    server = startServer();
  });

  afterEach(async () => {
    if (server) {
      await stopServer(server.wss);
      server = null;
    }
  });

  it("round-trips commands and emits events", async () => {
    if (!server) {
      throw new Error("server not initialized");
    }
    const events: Array<{ type: string }> = [];
    server.wss.on("connection", (socket) => {
      socket.on("message", (data) => {
        let text: string;
        if (typeof data === "string") {
          text = data;
        } else if (Buffer.isBuffer(data)) {
          text = data.toString("utf8");
        } else if (Array.isArray(data)) {
          text = Buffer.concat(data).toString("utf8");
        } else {
          text = Buffer.from(data).toString("utf8");
        }
        const parsed = JSON.parse(text) as { corrId?: string };
        socket.send(Buffer.from(JSON.stringify({ corrId: parsed.corrId, resp: { type: "ok" } })));
        socket.send(JSON.stringify({ resp: { type: "event", hello: true } }));
      });
    });

    const client = new SimplexWsClient({ url: server.url });
    client.onEvent((event) => events.push(event));

    const result = await client.sendCommand("/ping");
    expect(result.resp?.type).toBe("ok");

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events[0]?.type).toBe("event");

    await client.close();
  });

  it("rejects pending command on unexpected close and reconnects cleanly", async () => {
    if (!server) {
      throw new Error("server not initialized");
    }

    let connectionCount = 0;
    server.wss.on("connection", (socket) => {
      connectionCount += 1;
      socket.on("message", (data) => {
        let text: string;
        if (typeof data === "string") {
          text = data;
        } else if (Buffer.isBuffer(data)) {
          text = data.toString("utf8");
        } else if (Array.isArray(data)) {
          text = Buffer.concat(data).toString("utf8");
        } else {
          text = Buffer.from(data).toString("utf8");
        }
        const parsed = JSON.parse(text) as { corrId?: string };

        if (connectionCount === 1) {
          socket.close();
          return;
        }
        socket.send(Buffer.from(JSON.stringify({ corrId: parsed.corrId, resp: { type: "ok" } })));
      });
    });

    const client = new SimplexWsClient({ url: server.url });
    await expect(client.sendCommand("/first", 5_000)).rejects.toThrow("SimpleX WS closed");

    const second = await client.sendCommand("/second");
    expect(second.resp?.type).toBe("ok");

    await client.close();
  });
});
