// Nextcloud Talk tests cover pre-authentication webhook in-flight admission behavior.
import type { IncomingMessage } from "node:http";
import { createConnection, type Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { createSignedCreateMessageRequest } from "./monitor.test-fixtures.js";
import { startWebhookServer } from "./monitor.test-harness.js";
import { generateNextcloudTalkSignature } from "./signature.js";

const { rejection, legacyListeners } = vi.hoisted(() => ({
  rejection: vi.fn(),
  legacyListeners: new WeakMap<IncomingMessage, { port: number; host?: string }>(),
}));
vi.mock("openclaw/plugin-sdk/webhook-ingress", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/webhook-ingress")>();
  return {
    ...actual,
    getWebhookLegacyListener: (req: IncomingMessage) => legacyListeners.get(req),
  };
});
vi.mock("openclaw/plugin-sdk/webhook-request-guards", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/webhook-request-guards")>();
  return {
    ...actual,
    sendHttpRequestRejection: (...args: Parameters<typeof actual.sendHttpRequestRejection>) => {
      rejection(...args);
      return actual.sendHttpRequestRejection(...args);
    },
  };
});

const WEBHOOK_PATH = "/nextcloud-talk-webhook-preauth-inflight";
const IN_FLIGHT_LIMIT = 64;
const PROMISED_BODY_BYTES = 65536;

function openIncompleteWebhookRequest(params: {
  host: string;
  port: number;
  sockets: Socket[];
}): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: params.host, port: params.port });
    params.sockets.push(socket);
    socket.once("error", reject);
    socket.once("connect", () => {
      // Promise a body larger than one TCP segment but send only one byte, so the
      // pre-auth read stays open without completing signature verification.
      socket.write(
        [
          `POST ${WEBHOOK_PATH} HTTP/1.1`,
          `Host: ${params.host}:${params.port}`,
          "Content-Type: application/json",
          `Content-Length: ${PROMISED_BODY_BYTES}`,
          "X-Nextcloud-Talk-Signature: invalid-but-present",
          "X-Nextcloud-Talk-Random: attacker-controlled",
          "X-Nextcloud-Talk-Backend: https://nextcloud.example",
          "Connection: close",
          "",
          "{",
        ].join("\r\n"),
      );
      resolve(socket);
    });
  });
}

function readEntireResponse(socket: Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk.toString();
    });
    socket.once("error", reject);
    socket.once("close", () => resolve(data));
  });
}

describe("Nextcloud Talk webhook pre-authentication in-flight limit", () => {
  it.each(["Gateway", "legacy"] as const)(
    "isolates %s admission while preserving ordered acknowledgements and recovery",
    async (ingress) => {
      const firstEndpoint = { port: 8788, host: "127.0.0.1" };
      const secondEndpoint = { port: 8789, host: "127.0.0.1" };
      let endpoint = ingress === "legacy" ? firstEndpoint : undefined;
      const markIngress = (req: IncomingMessage) => {
        if (endpoint) {
          legacyListeners.set(req, endpoint);
        }
      };
      const admitted = Promise.withResolvers<void>();
      const releaseAdmission = Promise.withResolvers<void>();
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
      let received = 0;
      let awaitedCount = 0;
      let receivedCount = Promise.withResolvers<void>();
      const onRequest = () => {
        received += 1;
        if (received === awaitedCount) {
          receivedCount.resolve();
        }
      };
      const waitForRequests = (count: number) => {
        awaitedCount = count;
        receivedCount = Promise.withResolvers<void>();
        if (received >= count) {
          receivedCount.resolve();
        }
        return receivedCount.promise;
      };
      server.on("request", onRequest);
      try {
        const connection = await new Promise<Socket>((resolve, reject) => {
          const socket = createConnection({ host, port });
          sockets.push(socket);
          socket.once("error", reject);
          socket.once("connect", () => resolve(socket));
        });
        const { body, headers } = createSignedCreateMessageRequest();
        const signedHeaders = Object.entries(headers)
          .map(([key, value]) => `${key}: ${value}`)
          .join("\r\n");
        connection.write(
          [
            `POST ${WEBHOOK_PATH} HTTP/1.1`,
            `Host: ${host}:${port}`,
            signedHeaders,
            `Content-Length: ${Buffer.byteLength(body)}`,
            "Connection: keep-alive",
            "",
            body,
          ].join("\r\n"),
        );
        await admitted.promise;

        const saturated = waitForRequests(IN_FLIGHT_LIMIT + 1);
        await Promise.all(
          Array.from({ length: IN_FLIGHT_LIMIT }, () =>
            openIncompleteWebhookRequest({ host, port, sockets }),
          ),
        );
        await saturated;
        const overflow = await openIncompleteWebhookRequest({ host, port, sockets });
        const overflowResponse = await readEntireResponse(overflow);
        expect(overflowResponse).toMatch(/^HTTP\/1.1 429/);
        expect(dispatches).toHaveLength(1);

        endpoint = firstEndpoint;
        const sameLegacyEndpoint = await fetch(alternatePath.webhookUrl, {
          method: "POST",
          headers,
          body,
        });
        expect(sameLegacyEndpoint.status).toBe(ingress === "legacy" ? 429 : 200);

        const signedSecond = generateNextcloudTalkSignature({
          body,
          secret: "second-account-secret",
        });
        const secondHeaders = {
          ...headers,
          "x-nextcloud-talk-random": signedSecond.random,
          "x-nextcloud-talk-signature": signedSecond.signature,
        };
        endpoint = secondEndpoint;
        const independentLegacy = await fetch(webhookUrl, {
          method: "POST",
          headers: secondHeaders,
          body,
        });
        expect(independentLegacy.status).toBe(200);
        expect(secondAccount).toHaveBeenCalledOnce();

        endpoint = undefined;
        const sharedGateway = await fetch(webhookUrl, {
          method: "POST",
          headers: secondHeaders,
          body,
        });
        expect(sharedGateway.status).toBe(ingress === "Gateway" ? 429 : 200);
        expect(secondAccount).toHaveBeenCalledTimes(ingress === "Gateway" ? 1 : 2);
        endpoint = ingress === "legacy" ? firstEndpoint : undefined;

        rejection.mockClear();
        const pipelined = waitForRequests(received + 1);
        const connectionResponse = readEntireResponse(connection);
        connection.write(
          [
            `POST ${WEBHOOK_PATH} HTTP/1.1`,
            `Host: ${host}:${port}`,
            "Content-Type: application/json",
            `Content-Length: ${PROMISED_BODY_BYTES}`,
            "X-Nextcloud-Talk-Signature: invalid-but-present",
            "X-Nextcloud-Talk-Random: attacker-controlled",
            "X-Nextcloud-Talk-Backend: https://nextcloud.example",
            "Connection: keep-alive",
            "",
            "{",
          ].join("\r\n"),
        );
        await pipelined;
        // Parsing a later request cannot select a close while admission is pending.
        expect(rejection).not.toHaveBeenCalled();
        releaseAdmission.resolve();
        const data = await connectionResponse;
        const acknowledgedAt = data.indexOf("HTTP/1.1 200");
        expect(acknowledgedAt).toBeGreaterThanOrEqual(0);
        expect(data.indexOf("HTTP/1.1 429")).toBeGreaterThan(acknowledgedAt);
        expect(data.toLowerCase()).toContain("x-openclaw-delivery-accepted: durable");
        for (const socket of sockets.splice(0)) {
          socket.destroy();
        }
        await waitForIdle();
        const recovered = await fetch(webhookUrl, { method: "POST", headers, body });
        expect(recovered.status).toBe(200);
        expect(dispatches).toHaveLength(2);
      } finally {
        releaseAdmission.resolve();
        for (const socket of sockets) {
          socket.destroy();
        }
        await waitForIdle();
        server.off("request", onRequest);
        server.off("request", markIngress);
      }
    },
  );
});
