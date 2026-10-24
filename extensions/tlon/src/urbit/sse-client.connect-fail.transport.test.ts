import { once } from "node:events";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UrbitSSEClient } from "./sse-client.js";
const proofCookie = "urbauth-~zod=synthetic-reconnect-proof";
const runningServers: Server[] = [];
const cleanups: Array<() => void | Promise<void>> = [];
function readBody(request: IncomingMessage, receive: (body: string) => void) {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.once("end", () => receive(Buffer.concat(chunks).toString("utf8")));
}
function expectStopped(client: UrbitSSEClient, requests: string[], count: number) {
  expect(requests).toHaveLength(count);
  expect(client).toMatchObject({ isConnected: false, streamRelease: null });
}
async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  runningServers.push(server);
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}
function createClient(
  baseUrl: string,
  options: ConstructorParameters<typeof UrbitSSEClient>[2] = {},
) {
  const client = new UrbitSSEClient(baseUrl, proofCookie, {
    ship: "zod",
    ssrfPolicy: { allowPrivateNetwork: true },
    ...options,
  });
  cleanups.push(() => client.stopReceiving());
  return client;
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
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
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
  it.each(["status", "socket"])("clears connect timeout on %s failure", async (failure) => {
    const closed = Promise.withResolvers<void>();
    const server = createServer((request, response) => {
      request.socket.once("close", () => closed.resolve());
      response.writeHead(503, { "Content-Type": "text/event-stream" });
      response.write("retry: 1000\n");
    });
    if (failure === "socket") {
      server.on("connection", (socket) => socket.destroy());
    }
    const client = createClient(await listen(server));
    const expectTimeoutCleared = trackConnectTimeout();
    if (failure === "socket") {
      await expect(client.openStream()).rejects.toThrow();
    } else {
      await expect(client.openStream()).rejects.toThrow("Stream connection failed: 503");
      await expect(closed.promise).resolves.toBeUndefined();
    }
    expectTimeoutCleared();
  });
  it.each([
    { action: "subscribe", status: 200 },
    { action: "ack", status: 503 },
    { action: "delete", status: 503 },
  ])("closes the unread $action response with status $status", async ({ action, status }) => {
    let observedAction: string | undefined;
    const closed = Promise.withResolvers<void>();
    const server = createServer((request, response) => {
      readBody(request, (body) => {
        const [payload] = JSON.parse(body) as Array<{ action: string }>;
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
    } else if (action === "ack") {
      await expect(client.processEvent('id: 20\ndata: {"json":{"ok":true}}')).rejects.toThrow(
        "Ack failed with status 503",
      );
    } else {
      const error = vi.fn();
      client.logger = { error };
      await client.close();
      expect(error).toHaveBeenCalledWith(
        "Error closing channel: UrbitHttpError: Channel close failed: 503",
      );
      expect(client.aborted).toBe(true);
    }
    expect(observedAction).toBe(action);
    await expect(closed.promise).resolves.toBeUndefined();
  });
  it.for([
    { ending: "LF", newline: "\n" },
    { ending: "CR", newline: "\r" },
  ])("delivers multiline data over $ending HTTP SSE framing", async ({ newline }, { signal }) => {
    const sentinel = Promise.withResolvers<void>();
    const streamClosed = Promise.withResolvers<void>();
    const delivered: unknown[] = [];
    const errors: string[] = [];
    const requestBodies: unknown[] = [];
    const requests: string[] = [];
    let streamSocket: import("node:net").Socket | undefined;
    const data = ['data: {"id":1,', 'data: "json":{"message":"delivered😀"}}'];
    const event = ["id:21", ...data, "", ""].join(newline);
    // The LF sentinel is valid even on the original parser, so missing delivery
    // fails an assertion instead of waiting for a timeout or reconnect.
    const wireBody = `${event}id:22\ndata:{"id":1,"json":{"marker":"sentinel"}}\n\n`;
    const server = createServer((request, response) => {
      requests.push(`${request.method} ${request.url} ${request.headers.cookie}`);
      if (request.method === "GET") {
        streamSocket = request.socket;
        streamSocket.once("close", () => streamClosed.resolve());
        response.writeHead(200, { "Content-Type": "text/event-stream" });
        response.write(wireBody);
        return;
      }
      readBody(request, (body) => {
        if (body) {
          requestBodies.push(JSON.parse(body));
        }
        response.writeHead(204).end();
      });
    });
    const client = createClient(await listen(server), {
      logger: { error: (message) => errors.push(message) },
    });
    cleanups.push(() => client.close());
    await client.subscribe({
      app: "chat",
      path: "/inbox",
      event: (payload) => {
        delivered.push(payload);
        if (
          typeof payload === "object" &&
          payload !== null &&
          "marker" in payload &&
          payload.marker === "sentinel"
        ) {
          sentinel.resolve();
        }
      },
    });
    await client.connect();
    await withinTest(sentinel.promise, signal);
    expect(delivered).toEqual([{ message: "delivered😀" }, { marker: "sentinel" }]);
    expect(errors).toEqual([]);
    expect(requestBodies).toContainEqual([
      expect.objectContaining({ action: "ack", "event-id": 21 }),
    ]);
    expect(requests.filter((request) => request.startsWith("GET "))).toEqual([
      `GET /~/channel/${client.channelId} ${proofCookie}`,
    ]);
    expect(streamSocket?.destroyed).toBe(false);
    await client.close();
    await withinTest(streamClosed.promise, signal);
    expect(client.streamRelease).toBeNull();
  });
});
async function startReconnectFixture(holdStreamAfter = Number.POSITIVE_INFINITY, missing = false) {
  const requests: string[] = [];
  const logs: string[] = [];
  let unauthorizedRequests = 0;
  let streamRequests = 0;
  const actions: Array<{ action: string }> = [];
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
      streamRequests++;
      if (missing && streamRequests === 2) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "Cache-Control": "no-cache", "Content-Type": "text/event-stream" });
      if (streamRequests >= holdStreamAfter) {
        response.write(": connected\n\n");
      } else {
        response.end();
      }
      return;
    }
    if (request.method !== "PUT") {
      response.writeHead(405).end();
      return;
    }
    readBody(request, (body) => {
      const received = JSON.parse(body) as Array<{ action: string }>;
      actions.push(...received);
      response.writeHead(204).end();
    });
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
  cleanups.push(() => client.close());
  const reconnectSpy = vi.spyOn(client, "attemptReconnect");
  return {
    client,
    requests,
    logs,
    onReconnect,
    actions,
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
  it("settles the real ten-second retry cooldown when the monitor stops receiving", async ({
    signal,
  }) => {
    const proof = await startReconnectFixture(1);
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
  });
  it("settles a real pending reconnect when the public client closes", async ({ signal }) => {
    const proof = await startReconnectFixture();
    await proof.client.subscribe({ app: "chat", path: "/inbox" });
    await proof.client.connect();
    const { reconnect } = await proof.pendingReconnect(signal);
    const actionsBeforeClose = proof.actions.length;
    await proof.client.close();
    const requestsAfterClose = proof.requests.length;
    await withinTest(reconnect, signal);
    expect(proof.onReconnect).not.toHaveBeenCalled();
    expect(proof.requests).toHaveLength(requestsAfterClose);
    expect(proof.actions.slice(actionsBeforeClose)).toEqual([{ action: "delete" }]);
    expect(proof.requests.some((request) => request.startsWith("DELETE /~/channel/"))).toBe(false);
  });
  it("does not reopen the stream when stopped during reauthentication", async ({ signal }) => {
    const proof = await startReconnectFixture(2);
    const authenticating = Promise.withResolvers<void>();
    const authenticated = Promise.withResolvers<void>();
    cleanups.push(() => authenticated.resolve());
    proof.onReconnect.mockImplementation(async () => {
      authenticating.resolve();
      await authenticated.promise;
      proof.client.updateCookie(proofCookie);
    });
    await proof.client.connect();
    const { reconnect } = await proof.pendingReconnect(signal);
    await vi.advanceTimersByTimeAsync(1_000);
    await withinTest(authenticating.promise, signal);
    proof.client.stopReceiving();
    const requestsAfterStop = proof.requests.length;
    authenticated.resolve();
    await withinTest(reconnect, signal);
    expectStopped(proof.client, proof.requests, requestsAfterStop);
  });
  it.for(["stream", "create"] as const)(
    "does not resume a stopped reconnect after pending %s headers",
    async (stage, { signal }) => {
      const pending = Promise.withResolvers<import("node:http").ServerResponse>();
      const requests: string[] = [];
      const server = createServer((request, response) => {
        requests.push(request.method ?? "GET");
        if (stage === "create" && request.method === "GET") {
          response.writeHead(404).end();
        } else {
          pending.resolve(response);
        }
      });
      const client = createClient(await listen(server));
      const reconnect = client.attemptReconnect();
      await vi.advanceTimersByTimeAsync(1_000);
      const response = await withinTest(pending.promise, signal);
      client.stopReceiving();
      const requestsAfterStop = requests.length;
      response.writeHead(204).end();
      await withinTest(reconnect, signal);
      expectStopped(client, requests, requestsAfterStop);
    },
  );
  it.for([false, true])(
    "reconnects and restores subscriptions (missing channel: %s)",
    async (missing, { signal }) => {
      const proof = await startReconnectFixture(2, missing);
      const channelId = proof.client.channelId;
      await proof.client.subscribe({ app: "chat", path: "/inbox" });
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
        ...(missing ? [`GET /~/channel/${proof.client.channelId}`] : []),
      ]);
      expect(proof.client.channelId === channelId).toBe(!missing);
      expect(proof.actions.filter(({ action }) => action === "subscribe")).toEqual(
        Array.from({ length: missing ? 2 : 1 }, () =>
          expect.objectContaining({ app: "chat", path: "/inbox" }),
        ),
      );
      expect(proof.client.reconnectAttempts).toBe(0);
      expect(proof.unauthorizedRequests()).toBe(0);
    },
  );
});
