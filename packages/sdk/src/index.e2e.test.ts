import type { AddressInfo } from "node:net";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { GatewayClientTransport, OpenClaw } from "./index.js";

type JsonObject = Record<string, unknown>;

const servers: WebSocketServer[] = [];

function sendJson(socket: WebSocket, payload: JsonObject): void {
  socket.send(JSON.stringify(payload));
}

function readRawMessage(raw: RawData): string {
  if (typeof raw === "string") {
    return raw;
  }
  if (Buffer.isBuffer(raw)) {
    return raw.toString("utf8");
  }
  if (raw instanceof ArrayBuffer) {
    return Buffer.from(raw).toString("utf8");
  }
  return Buffer.concat(raw).toString("utf8");
}

async function reservePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function createFakeGateway(port = 0): Promise<{ url: string; close: () => Promise<void> }> {
  const server = new WebSocketServer({ host: "127.0.0.1", port });
  servers.push(server);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  let seq = 1;

  server.on("connection", (socket) => {
    sendJson(socket, {
      type: "event",
      event: "connect.challenge",
      seq: seq++,
      payload: { nonce: "sdk-e2e-nonce" },
    });

    socket.on("message", (raw) => {
      const frame = JSON.parse(readRawMessage(raw)) as {
        id: string;
        method: string;
        params?: unknown;
      };

      if (frame.method === "connect") {
        sendJson(socket, {
          type: "res",
          id: frame.id,
          ok: true,
          payload: {
            type: "hello-ok",
            protocol: 1,
            server: { version: "sdk-e2e", connId: "conn-sdk-e2e" },
            features: {
              methods: [
                "agent",
                "agent.wait",
                "connect",
                "sessions.abort",
                "sessions.create",
                "sessions.send",
              ],
              events: ["agent", "sessions.changed"],
            },
            snapshot: {
              presence: [],
              health: {},
              stateVersion: { presence: 0, health: 0 },
              uptimeMs: 1,
            },
            auth: { role: "operator", scopes: [] },
            policy: {
              maxPayload: 262144,
              maxBufferedBytes: 262144,
              tickIntervalMs: 30000,
            },
          },
        });
        return;
      }

      if (frame.method === "agent") {
        const params = frame.params as { sessionKey?: string } | undefined;
        sendJson(socket, {
          type: "res",
          id: frame.id,
          ok: true,
          payload: { status: "accepted", runId: "run-sdk-e2e", sessionKey: params?.sessionKey },
        });
        setTimeout(() => {
          sendJson(socket, {
            type: "event",
            event: "agent",
            seq: seq++,
            payload: {
              runId: "run-sdk-e2e",
              sessionKey: params?.sessionKey,
              stream: "lifecycle",
              ts: Date.now(),
              data: { phase: "start" },
            },
          });
          sendJson(socket, {
            type: "event",
            event: "agent",
            seq: seq++,
            payload: {
              runId: "run-sdk-e2e",
              sessionKey: params?.sessionKey,
              stream: "assistant",
              ts: Date.now(),
              data: { delta: "hello from fake gateway" },
            },
          });
          sendJson(socket, {
            type: "event",
            event: "agent",
            seq: seq++,
            payload: {
              runId: "run-sdk-e2e",
              sessionKey: params?.sessionKey,
              stream: "lifecycle",
              ts: Date.now(),
              data: { phase: "end" },
            },
          });
        }, 50);
        return;
      }

      if (frame.method === "agent.wait") {
        sendJson(socket, {
          type: "res",
          id: frame.id,
          ok: true,
          payload: {
            status: "ok",
            runId: "run-sdk-e2e",
            sessionKey: "main",
            startedAt: 123,
            endedAt: 456,
          },
        });
      }

      if (frame.method === "sessions.abort") {
        sendJson(socket, {
          type: "res",
          id: frame.id,
          ok: true,
          payload: {
            ok: true,
            abortedRunId: "run-sdk-e2e",
            status: "aborted",
          },
        });
      }
    });
  });

  const { port: boundPort } = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${boundPort}`,
    close: () => {
      const index = servers.indexOf(server);
      if (index >= 0) {
        servers.splice(index, 1);
      }
      return new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

describe("OpenClaw SDK websocket e2e", () => {
  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          }),
      ),
    );
  });

  it("runs an agent and streams normalized events over a Gateway websocket", async () => {
    const gateway = await createFakeGateway();
    const transport = new GatewayClientTransport({
      url: gateway.url,
      deviceIdentity: null,
      requestTimeoutMs: 2_000,
    });
    const oc = new OpenClaw({ transport });
    try {
      const agent = await oc.agents.get("main");
      const run = await agent.run({
        input: "say hello",
        sessionKey: "main",
        idempotencyKey: "sdk-e2e",
      });
      const seenPromise = (async () => {
        const seen: string[] = [];

        for await (const event of run.events()) {
          seen.push(event.type);
          if (event.type === "run.completed") {
            break;
          }
        }

        return seen;
      })();
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error("timed out waiting for SDK run events")), 2_000);
      });

      const [seen, result] = await Promise.all([
        Promise.race([seenPromise, timeoutPromise]),
        run.wait({ timeoutMs: 2_000 }),
      ]);

      expect(run.id).toBe("run-sdk-e2e");
      expect(seen).toEqual(["run.started", "assistant.delta", "run.completed"]);
      expect(result).toMatchObject({
        runId: "run-sdk-e2e",
        sessionKey: "main",
        status: "completed",
        startedAt: 123,
        endedAt: 456,
      });
      await expect(run.cancel()).resolves.toMatchObject({
        abortedRunId: "run-sdk-e2e",
        status: "aborted",
      });
    } finally {
      await oc.close();
      await gateway.close();
    }
  });

  it("retries after an initial websocket connection failure", async () => {
    const port = await reservePort();
    const url = `ws://127.0.0.1:${port}`;
    const transport = new GatewayClientTransport({
      url,
      deviceIdentity: null,
      connectChallengeTimeoutMs: 200,
      preauthHandshakeTimeoutMs: 200,
      requestTimeoutMs: 500,
    });

    await expect(transport.connect()).rejects.toThrow();

    const gateway = await createFakeGateway(port);
    try {
      await expect(transport.connect()).resolves.toBeUndefined();
    } finally {
      await transport.close();
      await gateway.close();
    }
  });
});
