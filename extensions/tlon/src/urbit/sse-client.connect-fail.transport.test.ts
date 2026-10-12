import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { LookupFn } from "openclaw/plugin-sdk/ssrf-runtime";
import { withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UrbitSSEClient } from "./sse-client.js";

const proofCookie = "urbauth-~zod=synthetic-reconnect-proof";
const lookupLoopback = (async () => [{ address: "127.0.0.1", family: 4 }]) as unknown as LookupFn;
const runningServers: Server[] = [];

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  runningServers.push(server);
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

function createClient(
  baseUrl: string,
  options: ConstructorParameters<typeof UrbitSSEClient>[2] = {},
) {
  return new UrbitSSEClient(baseUrl, proofCookie, {
    ship: "zod",
    ssrfPolicy: { allowPrivateNetwork: true },
    lookupFn: lookupLoopback,
    ...options,
  });
}

function trackConnectTimeout() {
  const armed = vi.spyOn(globalThis, "setTimeout");
  const cleared = vi.spyOn(globalThis, "clearTimeout");
  return () => {
    const handles = armed.mock.results.filter(
      (_result, index) => armed.mock.calls[index]?.[1] === 60_000,
    );
    expect(handles).toHaveLength(1);
    expect(cleared).toHaveBeenCalledWith(handles[0]?.value);
  };
}

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

describe("UrbitSSEClient real transport ownership", () => {
  it("cancels unread non-OK stream bodies and clears the connect timeout", async () => {
    const closed = Promise.withResolvers<void>();
    const server = createServer((request, response) => {
      request.socket.once("close", () => closed.resolve());
      response.writeHead(503, { "Content-Type": "text/event-stream" });
      response.write("retry: 1000\n");
    });
    const client = createClient(await listen(server));
    const expectTimeoutCleared = trackConnectTimeout();

    await expect(client.openStream()).rejects.toThrow("Stream connection failed: 503");
    await expect(closed.promise).resolves.toBeUndefined();
    expectTimeoutCleared();
  });

  it("clears the connect timer when production urbitFetch rejects", async () => {
    const server = createServer();
    server.on("connection", (socket) => socket.destroy());
    const client = createClient(await listen(server));
    const expectTimeoutCleared = trackConnectTimeout();

    await expect(client.openStream()).rejects.toThrow();
    expectTimeoutCleared();
  });

  it.each([
    { action: "subscribe", status: 200 },
    { action: "ack", status: 200 },
    { action: "ack", status: 503 },
  ])("closes the unread $action response with status $status", async ({ action, status }) => {
    let observedAction: string | undefined;
    const closed = Promise.withResolvers<void>();
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.once("end", () => {
        const [payload] = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Array<{
          action: string;
        }>;
        observedAction = payload?.action;
        request.socket.once("close", () => closed.resolve());
        response.writeHead(status, { "Content-Type": "application/json" });
        response.write('{"result":"streaming');
      });
    });
    const client = createClient(await listen(server));

    if (action === "subscribe") {
      client.isConnected = true;
      await client.subscribe({ app: "chat", path: "/inbox" });
    } else {
      const handled = client.processEvent('id: 20\ndata: {"json":{"ok":true}}');
      if (status === 200) {
        await handled;
      } else {
        await expect(handled).rejects.toThrow("Ack failed with status 503");
      }
    }
    expect(observedAction).toBe(action);
    await expect(closed.promise).resolves.toBeUndefined();
  });

  it("keeps a no-space event stream live until its owner closes the client", async () => {
    const delivered = Promise.withResolvers<unknown>();
    const streamClosed = Promise.withResolvers<void>();
    let streamSocket: import("node:net").Socket | undefined;
    const server = createServer((request, response) => {
      if (request.method === "GET") {
        streamSocket = request.socket;
        streamSocket.once("close", () => streamClosed.resolve());
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write('id:1\ndata:{"id":1,"json":{"message":"delivered"}}\n\n');
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.write('{"ok":true');
    });
    const client = createClient(await listen(server));

    try {
      await client.subscribe({ app: "chat", path: "/inbox", event: delivered.resolve });
      await client.connect();
      await expect(delivered.promise).resolves.toEqual({ message: "delivered" });
      expect(streamSocket?.destroyed).toBe(false);
      expect(client.streamRelease).toBeTypeOf("function");

      await client.close();
      await expect(streamClosed.promise).resolves.toBeUndefined();
      expect(client.streamRelease).toBeNull();
    } finally {
      await client.close();
    }
  });
});

async function startReconnectFixture(holdStreamAfter = Number.POSITIVE_INFINITY) {
  const requests: string[] = [];
  const logs: string[] = [];
  let unauthorizedRequests = 0;
  let streamRequests = 0;
  const retryScheduled = Promise.withResolvers<void>();
  const onReconnect = vi.fn();
  const server = createServer((request, response) => {
    if (!(request.headers.cookie ?? "").includes(proofCookie)) {
      unauthorizedRequests += 1;
      response.writeHead(401).end();
      return;
    }
    requests.push(`${request.method ?? "GET"} ${request.url ?? "/"}`);
    if (request.method === "GET") {
      response.writeHead(200, { "Cache-Control": "no-cache", "Content-Type": "text/event-stream" });
      if (++streamRequests >= holdStreamAfter) {
        response.write(": connected\n\n");
      } else {
        response.end();
      }
      return;
    }
    response.writeHead(204).end();
  });
  const baseUrl = await listen(server);
  const client = createClient(baseUrl, {
    onReconnect,
    logger: {
      log: (message) => {
        logs.push(message);
        if (message.includes("in 1000ms")) {
          retryScheduled.resolve();
        }
      },
    },
  });
  const reconnectSpy = vi.spyOn(client, "attemptReconnect");
  return {
    baseUrl,
    client,
    requests,
    logs,
    onReconnect,
    unauthorizedRequests: () => unauthorizedRequests,
    async pendingReconnect(signal: AbortSignal) {
      await withinTest(retryScheduled.promise, signal);
      const reconnect = reconnectSpy.mock.results[0]?.value;
      if (!reconnect) {
        throw new Error("The real SSE stream did not enter its reconnect backoff");
      }
      return { reconnect };
    },
  };
}

describe("UrbitSSEClient real reconnect shutdown lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  it("settles a real SSE reconnect when the monitor stops receiving", async ({ signal }) => {
    const proof = await startReconnectFixture();
    try {
      await proof.client.connect();
      const { reconnect } = await proof.pendingReconnect(signal);
      const requestsBeforeStop = proof.requests.length;
      proof.client.stopReceiving();
      await withinTest(reconnect, signal);

      expect(proof.onReconnect).not.toHaveBeenCalled();
      expect(proof.requests).toHaveLength(requestsBeforeStop);
      expect(proof.requests.some((request) => request.startsWith("GET /~/channel/"))).toBe(true);
      const unauthorizedResponse = await fetch(`${proof.baseUrl}/unauthorized-control`);
      expect(unauthorizedResponse.status).toBe(401);
      expect(proof.unauthorizedRequests()).toBe(1);
    } finally {
      await proof.client.close();
    }
  });

  it("settles the real ten-second retry cooldown when the monitor stops receiving", async ({
    signal,
  }) => {
    const proof = await startReconnectFixture(1);
    try {
      await proof.client.connect();
      proof.client.reconnectAttempts = 10;
      const reconnect = proof.client.attemptReconnect();
      expect(proof.logs.some((message) => message.includes("Waiting 10s"))).toBe(true);
      const requestsBeforeStop = proof.requests.length;
      proof.client.stopReceiving();
      await withinTest(reconnect, signal);

      expect(proof.onReconnect).not.toHaveBeenCalled();
      expect(proof.requests).toHaveLength(requestsBeforeStop);
      expect(proof.logs.some((message) => message.includes("reset, resuming"))).toBe(false);
    } finally {
      await proof.client.close();
    }
  });

  it("settles a real pending reconnect when the public client closes", async ({ signal }) => {
    const proof = await startReconnectFixture();
    try {
      await proof.client.connect();
      const { reconnect } = await proof.pendingReconnect(signal);
      await proof.client.close();
      const requestsAfterClose = proof.requests.length;
      await withinTest(reconnect, signal);

      expect(proof.onReconnect).not.toHaveBeenCalled();
      expect(proof.requests).toHaveLength(requestsAfterClose);
      expect(proof.requests.some((request) => request.startsWith("DELETE /~/channel/"))).toBe(true);
    } finally {
      await proof.client.close();
    }
  });

  it("still reconnects an uninterrupted authenticated SSE stream", async ({ signal }) => {
    const proof = await startReconnectFixture(2);
    const channelId = proof.client.channelId;
    try {
      await proof.client.connect();
      const { reconnect } = await proof.pendingReconnect(signal);
      await vi.advanceTimersByTimeAsync(999);
      expect(proof.onReconnect).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await withinTest(reconnect, signal);

      expect(proof.onReconnect).toHaveBeenCalledOnce();
      expect(proof.requests.filter((request) => request.startsWith("GET /~/channel/"))).toEqual([
        `GET /~/channel/${channelId}`,
        `GET /~/channel/${channelId}`,
      ]);
      expect(proof.client.channelId).toBe(channelId);
      expect(proof.client.reconnectAttempts).toBe(0);
      expect(proof.unauthorizedRequests()).toBe(0);
    } finally {
      await proof.client.close();
    }
  });
});
