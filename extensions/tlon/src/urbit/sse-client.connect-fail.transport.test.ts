import { once } from "node:events";
import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { text } from "node:stream/consumers";
import { isDeepStrictEqual } from "node:util";
import { withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UrbitSSEClient } from "./sse-client.js";
const proofCookie = "urbauth-~zod=synthetic-reconnect-proof";
const cleanups: Array<() => void | Promise<void>> = [];
const subscription = { app: "chat", path: "/inbox" };
function expectStopped(client: UrbitSSEClient, requests: string[], count: number) {
  expect(requests).toHaveLength(count);
  expect(client).toMatchObject({ isConnected: false, streamRelease: null });
}
async function serve(handler: RequestListener) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(async () => {
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = new UrbitSSEClient(baseUrl, proofCookie, {
    ship: "zod",
    ssrfPolicy: { allowPrivateNetwork: true },
  });
  cleanups.push(() => client.stopReceiving());
  return { client, server };
}
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it.each(["status", "socket"])("clears connect timeout on %s failure", async (failure) => {
  const closed = Promise.withResolvers<void>();
  const { client, server } = await serve((request, response) => {
    request.socket.once("close", () => closed.resolve());
    response.writeHead(503).write("retry: 1000\n");
  });
  if (failure === "socket") {
    server.on("connection", (socket) => socket.destroy());
  }
  const armed = vi.spyOn(globalThis, "setTimeout");
  const cleared = vi.spyOn(globalThis, "clearTimeout");
  if (failure === "socket") {
    await expect(client.openStream()).rejects.toThrow();
  } else {
    await expect(client.openStream()).rejects.toThrow("Stream connection failed: 503");
    await expect(closed.promise).resolves.toBeUndefined();
  }
  const handles = armed.mock.results.filter(
    (_result, index) => armed.mock.calls[index]?.[1] === 60_000,
  );
  expect(handles).toHaveLength(1);
  expect(cleared).toHaveBeenCalledWith(handles[0]?.value);
});
it.each([
  { action: "subscribe", status: 200 },
  { action: "ack", status: 503 },
  { action: "delete", status: 503 },
])("closes the unread $action response with status $status", async ({ action, status }) => {
  const closed = Promise.withResolvers<void>();
  const { client } = await serve((request, response) => {
    request.socket.once("close", () => closed.resolve());
    response.writeHead(status).write('{"result":"streaming');
  });
  if (action === "subscribe") {
    client.isConnected = true;
    await client.subscribe(subscription);
  } else if (action === "ack") {
    await expect(client.processEvent('id: 20\ndata: {"json":{"ok":true}}')).rejects.toThrow(
      "Ack failed with status 503",
    );
  } else {
    const error = vi.fn();
    client.logger = { error };
    await client.close();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Channel close failed: 503"));
    expect(client.aborted).toBe(true);
  }
  await expect(closed.promise).resolves.toBeUndefined();
});
async function reconnectFixture(holdStreamAfter = Infinity, missing = false, newline?: string) {
  const requests: string[] = [];
  let unauthorizedRequests = 0;
  let streamRequests = 0;
  let streamSocket: import("node:net").Socket | undefined;
  const streamClosed = Promise.withResolvers<void>();
  const sentinel = Promise.withResolvers<void>();
  const delivered: unknown[] = [];
  const actions: Array<{ action: string }> = [];
  const retryScheduled = Promise.withResolvers<void>();
  const onReconnect = vi.fn();
  const { client } = await serve((request, response) => {
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
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      if (streamRequests >= holdStreamAfter) {
        streamSocket = request.socket;
        streamSocket.once("close", () => streamClosed.resolve());
        const frame = `id:21${newline}data: {"id":1,${newline}data: "json":{"message":"delivered😀"}}${newline}${newline}`;
        // A valid LF sentinel exposes lost multiline delivery without timing out.
        response.write(
          newline
            ? `${frame}id:22\ndata:{"id":1,"json":{"marker":"sentinel"}}\n\n`
            : ": connected\n\n",
        );
      } else {
        response.end();
      }
      return;
    }
    if (request.method !== "PUT") {
      response.writeHead(405).end();
      return;
    }
    void text(request).then((body) => {
      const received: Array<{ action: string }> = JSON.parse(body);
      actions.push(...received);
      response.writeHead(204).end();
    });
  });
  client.onReconnect = onReconnect;
  client.logger = {
    log: (message) => {
      if (message.includes("in 1000ms")) {
        retryScheduled.resolve();
      }
    },
  };
  cleanups.push(() => client.close());
  const reconnectSpy = vi.spyOn(client, "attemptReconnect");
  await client.subscribe({
    ...subscription,
    event: (payload) => {
      delivered.push(payload);
      if (isDeepStrictEqual(payload, { marker: "sentinel" })) {
        sentinel.resolve();
      }
    },
  });
  await client.connect();
  return {
    client,
    requests,
    streamSocket: () => streamSocket,
    streamClosed: streamClosed.promise,
    sentinel: sentinel.promise,
    delivered,
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
  it("cancels the ten-second cooldown on stopReceiving", async ({ signal }) => {
    const proof = await reconnectFixture(1);
    proof.client.reconnectAttempts = 10;
    const reconnect = proof.client.attemptReconnect();
    const requestsBeforeStop = proof.requests.length;
    proof.client.stopReceiving();
    await withinTest(reconnect, signal);
    expect(proof.onReconnect).not.toHaveBeenCalled();
    expect(proof.requests).toHaveLength(requestsBeforeStop);
  });
  it("settles a real pending reconnect when the public client closes", async ({ signal }) => {
    const proof = await reconnectFixture();
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
    const proof = await reconnectFixture(2);
    const authenticating = Promise.withResolvers<void>();
    const authenticated = Promise.withResolvers<void>();
    cleanups.push(() => authenticated.resolve());
    proof.onReconnect.mockImplementation(async () => {
      authenticating.resolve();
      await authenticated.promise;
      proof.client.updateCookie(proofCookie);
    });
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
      const { client } = await serve((request, response) => {
        requests.push(request.method ?? "GET");
        if (stage === "create" && request.method === "GET") {
          response.writeHead(404).end();
        } else {
          pending.resolve(response);
        }
      });
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
    "reconnects and delivers multiline SSE (missing channel: %s)",
    async (missing, { signal }) => {
      const proof = await reconnectFixture(2, missing, missing ? "\r" : "\n");
      const channelId = proof.client.channelId;
      const { reconnect } = await proof.pendingReconnect(signal);
      await vi.advanceTimersByTimeAsync(1_000);
      await withinTest(reconnect, signal);
      await withinTest(proof.sentinel, signal);
      expect(proof.delivered).toEqual([{ message: "delivered😀" }, { marker: "sentinel" }]);
      expect(proof.actions).toContainEqual(
        expect.objectContaining({ action: "ack", "event-id": 21 }),
      );
      expect(proof.requests).toContain(`GET /~/channel/${proof.client.channelId}`);
      expect(proof.client.channelId === channelId).toBe(!missing);
      expect(proof.actions.filter(({ action }) => action === "subscribe")).toEqual(
        Array.from({ length: missing ? 2 : 1 }, () => expect.objectContaining(subscription)),
      );
      expect(proof.client.reconnectAttempts).toBe(0);
      expect(proof.unauthorizedRequests()).toBe(0);
      expect(proof.streamSocket()?.destroyed).toBe(false);
      await proof.client.close();
      await withinTest(proof.streamClosed, signal);
      expect(proof.client.streamRelease).toBeNull();
    },
  );
});
