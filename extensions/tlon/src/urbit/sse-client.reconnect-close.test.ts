import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { LookupFn } from "openclaw/plugin-sdk/ssrf-runtime";
import { withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UrbitSSEClient } from "./sse-client.js";

const proofCookie = "urbauth-~zod=synthetic-reconnect-proof";
const lookupLoopback = (async () => [{ address: "127.0.0.1", family: 4 }]) as unknown as LookupFn;
const runningServers: Server[] = [];

type UrbitChannelProof = {
  baseUrl: string;
  requests: string[];
  unauthorizedRequests: number;
};

async function startUrbitChannelServer(holdStreamAfter = Number.POSITIVE_INFINITY) {
  const proof: UrbitChannelProof = {
    baseUrl: "",
    requests: [],
    unauthorizedRequests: 0,
  };
  let streamRequests = 0;
  const server = createServer((request, response) => {
    if (!(request.headers.cookie ?? "").includes(proofCookie)) {
      proof.unauthorizedRequests += 1;
      response.writeHead(401).end();
      return;
    }
    proof.requests.push(`${request.method ?? "GET"} ${request.url ?? "/"}`);
    if (request.method === "GET") {
      response.writeHead(200, {
        "Cache-Control": "no-cache",
        "Content-Type": "text/event-stream",
      });
      if (++streamRequests >= holdStreamAfter) {
        response.write(": connected\n\n");
      } else {
        response.end();
      }
      return;
    }
    response.writeHead(204).end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  runningServers.push(server);
  const address = server.address() as AddressInfo;
  proof.baseUrl = `http://127.0.0.1:${address.port}`;
  return proof;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(
    runningServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
});

describe("UrbitSSEClient real reconnect shutdown lifecycle", () => {
  it("settles a real SSE reconnect when the monitor stops receiving", async ({ signal }) => {
    const proof = await startUrbitChannelServer();
    const retryScheduled = Promise.withResolvers<void>();
    const onReconnect = vi.fn();
    const client = new UrbitSSEClient(proof.baseUrl, proofCookie, {
      ship: "zod",
      ssrfPolicy: { allowPrivateNetwork: true },
      lookupFn: lookupLoopback,
      logger: {
        log: (message) => {
          if (message.includes("in 1000ms")) {
            retryScheduled.resolve();
          }
        },
      },
      onReconnect,
    });
    const reconnectSpy = vi.spyOn(client, "attemptReconnect");

    try {
      await client.connect();
      await withinTest(retryScheduled.promise, signal);
      const reconnect = reconnectSpy.mock.results[0]?.value as Promise<void> | undefined;
      if (!reconnect) {
        throw new Error("The real SSE stream did not enter its reconnect backoff");
      }

      const requestsBeforeStop = proof.requests.length;
      client.stopReceiving();
      await withinTest(reconnect, signal);

      expect(onReconnect).not.toHaveBeenCalled();
      expect(proof.requests).toHaveLength(requestsBeforeStop);
      expect(proof.requests.some((request) => request.startsWith("GET /~/channel/"))).toBe(true);

      const unauthorizedResponse = await fetch(`${proof.baseUrl}/unauthorized-control`);
      expect(unauthorizedResponse.status).toBe(401);
      expect(proof.unauthorizedRequests).toBe(1);
    } finally {
      await client.close();
    }
  });

  it("settles the real ten-second retry cooldown when the monitor stops receiving", async ({
    signal,
  }) => {
    const proof = await startUrbitChannelServer(1);
    const logs: string[] = [];
    const onReconnect = vi.fn();
    const client = new UrbitSSEClient(proof.baseUrl, proofCookie, {
      ship: "zod",
      ssrfPolicy: { allowPrivateNetwork: true },
      lookupFn: lookupLoopback,
      logger: { log: (message) => logs.push(message) },
      onReconnect,
    });

    try {
      await client.connect();
      client.reconnectAttempts = 10;
      const reconnect = client.attemptReconnect();
      expect(logs.some((message) => message.includes("Waiting 10s"))).toBe(true);

      const requestsBeforeStop = proof.requests.length;
      client.stopReceiving();
      await withinTest(reconnect, signal);

      expect(onReconnect).not.toHaveBeenCalled();
      expect(proof.requests).toHaveLength(requestsBeforeStop);
      expect(logs.some((message) => message.includes("reset, resuming"))).toBe(false);
    } finally {
      await client.close();
    }
  });

  it("settles a real pending reconnect when the public client closes", async ({ signal }) => {
    const proof = await startUrbitChannelServer();
    const retryScheduled = Promise.withResolvers<void>();
    const onReconnect = vi.fn();
    const client = new UrbitSSEClient(proof.baseUrl, proofCookie, {
      ship: "zod",
      ssrfPolicy: { allowPrivateNetwork: true },
      lookupFn: lookupLoopback,
      logger: {
        log: (message) => {
          if (message.includes("in 1000ms")) {
            retryScheduled.resolve();
          }
        },
      },
      onReconnect,
    });
    const reconnectSpy = vi.spyOn(client, "attemptReconnect");

    try {
      await client.connect();
      await withinTest(retryScheduled.promise, signal);
      const reconnect = reconnectSpy.mock.results[0]?.value as Promise<void> | undefined;
      if (!reconnect) {
        throw new Error("The real SSE stream did not enter its reconnect backoff");
      }

      await client.close();
      const requestsAfterClose = proof.requests.length;
      await withinTest(reconnect, signal);

      expect(onReconnect).not.toHaveBeenCalled();
      expect(proof.requests).toHaveLength(requestsAfterClose);
      expect(proof.requests.some((request) => request.startsWith("DELETE /~/channel/"))).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("still reconnects an uninterrupted authenticated SSE stream", async ({ signal }) => {
    const proof = await startUrbitChannelServer(2);
    const retryScheduled = Promise.withResolvers<void>();
    const onReconnect = vi.fn();
    const client = new UrbitSSEClient(proof.baseUrl, proofCookie, {
      ship: "zod",
      ssrfPolicy: { allowPrivateNetwork: true },
      lookupFn: lookupLoopback,
      onReconnect,
      logger: {
        log: (message) => {
          if (message.includes("in 1000ms")) {
            retryScheduled.resolve();
          }
        },
      },
    });
    const reconnectSpy = vi.spyOn(client, "attemptReconnect");

    try {
      await client.connect();
      await withinTest(retryScheduled.promise, signal);
      const reconnect = reconnectSpy.mock.results[0]?.value as Promise<void> | undefined;
      if (!reconnect) {
        throw new Error("The real SSE stream did not enter its reconnect backoff");
      }
      await vi.advanceTimersByTimeAsync(999);
      expect(onReconnect).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await withinTest(reconnect, signal);
      expect(onReconnect).toHaveBeenCalledOnce();
      expect(
        proof.requests.filter((request) => request.startsWith("GET /~/channel/")),
      ).toHaveLength(2);
      expect(proof.unauthorizedRequests).toBe(0);
    } finally {
      await client.close();
    }
  });
});
