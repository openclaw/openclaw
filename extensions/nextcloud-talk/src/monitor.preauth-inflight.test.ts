import { once } from "node:events";
import type { IncomingMessage } from "node:http";
import { createConnection, type Socket } from "node:net";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { expect, it, vi } from "vitest";
import { createSignedCreateMessageRequest, signWebhookBody } from "./monitor.test-fixtures.js";
import { startWebhookServer } from "./monitor.test-harness.js";

const { legacyListeners } = vi.hoisted(() => ({
  legacyListeners: new WeakMap<IncomingMessage, { port: number; host?: string }>(),
}));
vi.mock("openclaw/plugin-sdk/webhook-ingress", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/webhook-ingress")>();
  return {
    ...actual,
    getWebhookLegacyListener: (req: IncomingMessage) => legacyListeners.get(req),
  };
});

const WEBHOOK_PATH = "/nextcloud-talk-webhook-preauth-inflight";
const IN_FLIGHT_LIMIT = 64;

async function readEntireResponse(socket: Socket): Promise<string> {
  let data = "";
  socket.on("data", (chunk) => {
    data += chunk.toString();
  });
  await once(socket, "close");
  return data;
}

it.each(["Gateway", "legacy"] as const)(
  "isolates Nextcloud Talk %s admission while preserving ordered acknowledgements and recovery",
  async (ingress) => {
    const firstEndpoint = { port: 8788, host: "127.0.0.1" };
    const secondEndpoint = { port: 8789, host: "127.0.0.1" };
    let endpoint = ingress === "legacy" ? firstEndpoint : undefined;
    const markIngress = (req: IncomingMessage) => {
      if (endpoint) {
        legacyListeners.set(req, endpoint);
      }
    };
    const admitted = createDeferred<void>();
    const releaseAdmission = createDeferred<void>();
    const dispatches: string[] = [];
    const { server, webhookUrl, waitForIdle } = await startWebhookServer({
      path: WEBHOOK_PATH,
      legacyListener: firstEndpoint,
      onWebhook: async (rawBody) => {
        dispatches.push(rawBody);
        if (dispatches.length === 1) {
          admitted.resolve();
          await releaseAdmission.promise;
        }
        return "accepted";
      },
    });
    const secondAccount = vi.fn(async () => "accepted" as const);
    await startWebhookServer({
      path: WEBHOOK_PATH,
      legacyListener: secondEndpoint,
      secret: "second-account-secret",
      onWebhook: secondAccount,
    });
    const alternatePath = await startWebhookServer({
      path: `${WEBHOOK_PATH}-alternate`,
      legacyListener: firstEndpoint,
      onWebhook: async () => "accepted",
    });
    server.prependListener("request", markIngress);
    const { hostname: host, port: portText } = new URL(webhookUrl);
    const port = Number(portText);
    const sockets: Socket[] = [];
    const closeSockets = () => sockets.splice(0).forEach((socket) => socket.destroy());
    const { body, headers } = createSignedCreateMessageRequest();
    const post = (url = webhookUrl, requestHeaders = headers) =>
      fetch(url, { method: "POST", headers: requestHeaders, body });
    const connect = () =>
      new Promise<Socket>((resolve, reject) => {
        const socket = createConnection({ host, port });
        sockets.push(socket);
        socket.once("error", reject);
        socket.once("connect", () => resolve(socket));
      });
    const wireRequest = (
      payload: string,
      requestHeaders: Record<string, string>,
      connection: string,
      size = Buffer.byteLength(payload),
    ) =>
      `POST ${WEBHOOK_PATH} HTTP/1.1\r\nHost: ${host}:${port}\r\n${Object.entries(requestHeaders)
        .map(([key, value]) => `${key}: ${value}`)
        .join("\r\n")}\r\nContent-Length: ${size}\r\nConnection: ${connection}\r\n\r\n${payload}`;
    // Promise a full body but send one byte, holding admission before signature verification.
    const incompleteHeaders = {
      ...headers,
      "x-nextcloud-talk-signature": "invalid-but-present",
      "x-nextcloud-talk-random": "attacker-controlled",
    };
    const incompleteRequest = (connection: "close" | "keep-alive") =>
      wireRequest("{", incompleteHeaders, connection, 65536);
    const openIncompleteRequest = async () => {
      const socket = await connect();
      socket.write(incompleteRequest("close"));
      return socket;
    };
    let received = 0;
    const onRequest = () => {
      received += 1;
    };
    const waitForRequests = async (count: number): Promise<void> => {
      if (received < count) {
        await once(server, "request");
        await waitForRequests(count);
      }
    };
    server.on("request", onRequest);
    try {
      const connection = await connect();
      connection.write(wireRequest(body, headers, "keep-alive"));
      await admitted.promise;

      const saturated = waitForRequests(IN_FLIGHT_LIMIT + 1);
      await Promise.all(Array.from({ length: IN_FLIGHT_LIMIT }, openIncompleteRequest));
      await saturated;
      const overflow = await openIncompleteRequest();
      const overflowResponse = await readEntireResponse(overflow);
      expect(overflowResponse).toMatch(/^HTTP\/1.1 429/);
      expect(dispatches).toHaveLength(1);

      endpoint = firstEndpoint;
      expect((await post(alternatePath.webhookUrl)).status).toBe(ingress === "legacy" ? 429 : 200);

      const secondHeaders = signWebhookBody(body, "second-account-secret").headers;
      endpoint = secondEndpoint;
      expect((await post(webhookUrl, secondHeaders)).status).toBe(200);
      expect(secondAccount).toHaveBeenCalledOnce();

      endpoint = undefined;
      expect((await post(webhookUrl, secondHeaders)).status).toBe(
        ingress === "Gateway" ? 429 : 200,
      );
      expect(secondAccount).toHaveBeenCalledTimes(ingress === "Gateway" ? 1 : 2);
      endpoint = ingress === "legacy" ? firstEndpoint : undefined;

      const pipelined = waitForRequests(received + 1);
      const connectionResponse = readEntireResponse(connection);
      connection.write(incompleteRequest("keep-alive"));
      await pipelined;
      releaseAdmission.resolve();
      const data = await connectionResponse;
      const acknowledgedAt = data.indexOf("HTTP/1.1 200");
      expect(acknowledgedAt).toBeGreaterThanOrEqual(0);
      expect(data.indexOf("HTTP/1.1 429")).toBeGreaterThan(acknowledgedAt);
      expect(data.toLowerCase()).toContain("x-openclaw-delivery-accepted: durable");
      closeSockets();
      await waitForIdle();
      expect((await post()).status).toBe(200);
      expect(dispatches).toHaveLength(2);
    } finally {
      releaseAdmission.resolve();
      closeSockets();
      await waitForIdle();
      server.off("request", onRequest).off("request", markIngress);
    }
  },
);
