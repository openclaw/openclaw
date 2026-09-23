import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { asTelegramClientFetch, createTelegramClientFetch } from "./client-fetch.js";
import { TelegramRequestNotStartedError } from "./network-errors.js";

describe("Telegram client cancellation and custody", () => {
  const sockets = new Set<Socket>();
  const responses = new Set<ServerResponse>();
  const requests: string[] = [];
  let arrived = createDeferred<void>();
  let hold: "headers" | "body" | undefined;
  const server = createServer((request, response) => {
    request.resume();
    requests.push(request.url!);
    responses.add(response);
    response.once("close", () => responses.delete(response));
    arrived.resolve();
    if (hold === "headers") {
      hold = undefined;
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    if (hold === "body") {
      hold = undefined;
      response.write("{");
    } else {
      response.end(JSON.stringify({ accepted: true }));
    }
  });
  let apiRoot: string;
  beforeAll(async () => {
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    apiRoot = `http://127.0.0.1:${(server.address() as AddressInfo).port}/bot123:fixture`;
  });
  beforeEach(() => {
    requests.length = 0;
    hold = undefined;
    arrived = createDeferred<void>();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const response of responses) {
      response.destroy();
    }
  });
  afterAll(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it.each(["shutdown", "request"] as const)(
    "keeps %s cancellation attached while the actual response body is pending",
    async (source) => {
      hold = "body";
      const shutdown = new AbortController();
      const request = new AbortController();
      const client = createTelegramClientFetch({
        fetchImpl: asTelegramClientFetch(fetch),
        shutdownSignal: shutdown.signal,
      })!;
      const response = await client(`${apiRoot}/getChat`, { signal: request.signal });
      const body = response.text();
      const failure = expect(body).rejects.toBeInstanceOf(Error);
      if (source === "shutdown") {
        shutdown.abort(new Error("gateway stopped"));
      } else {
        request.abort();
      }
      await failure;
      expect(requests).toEqual(["/bot123:fixture/getChat"]);
    },
  );

  it.each([
    { method: "getUpdates", deadline: 45000 },
    { method: "sendMessage", deadline: 60000 },
    { method: "getChat", deadline: 15000 },
  ])("terminates a held $method at its own request deadline", async ({ method, deadline }) => {
    hold = "headers";
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const client = createTelegramClientFetch({ fetchImpl: asTelegramClientFetch(fetch) })!;
    let settled = false;
    const sending = client(`${apiRoot}/${method}`).finally(() => {
      settled = true;
    });
    const failure = expect(sending).rejects.toThrow(`timed out after ${deadline}ms`);
    await arrived.promise;
    await vi.advanceTimersByTimeAsync(deadline - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await failure;
    expect(requests).toHaveLength(1);
  });

  it.each([
    { method: "deleteWebhook", deadline: 15000 },
    { method: "sendChatAction", deadline: 60000 },
  ])(
    "recovers one timed-out $method through the supplied fallback transport",
    async ({ method, deadline }) => {
      hold = "headers";
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const reasons: string[] = [];
      const client = createTelegramClientFetch({
        fetchImpl: asTelegramClientFetch(fetch),
        transport: {
          forceFallback: (reason) => {
            reasons.push(reason);
            return true;
          },
        },
      })!;
      const sending = client(`${apiRoot}/${method}`);
      await arrived.promise;
      await vi.advanceTimersByTimeAsync(deadline);
      expect(await (await sending).json()).toEqual({ accepted: true });
      expect(reasons).toEqual(["request-timeout"]);
      expect(requests).toEqual(Array(2).fill(`/bot123:fixture/${method}`));
    },
  );

  it.each(["recovers", "terminal", "no-fallback"] as const)(
    "releases transport-returned 421 bodies with %s custody",
    async (outcome) => {
      const bodiesClosed: Promise<void>[] = [];
      let calls = 0;
      let fallbacks = 0;
      const client = createTelegramClientFetch({
        fetchImpl: asTelegramClientFetch(async () => {
          calls++;
          if (outcome === "recovers" && calls === 2) {
            return new Response(JSON.stringify({ accepted: true }));
          }
          const closed = createDeferred<void>();
          bodiesClosed.push(closed.promise);
          return new Response(
            new ReadableStream<Uint8Array>({
              cancel: () => closed.resolve(),
            }),
            { status: 421 },
          );
        }),
        transport: {
          forceFallback: () => outcome !== "no-fallback" && fallbacks++ === 0,
        },
      })!;
      const sending = client(`${apiRoot}/sendMessage`);
      if (outcome === "recovers") {
        expect(await (await sending).json()).toEqual({ accepted: true });
      } else {
        await expect(sending).rejects.toBeInstanceOf(TelegramRequestNotStartedError);
      }
      await Promise.all(bodiesClosed);
      expect(calls).toBe(outcome === "no-fallback" ? 1 : 2);
      expect(bodiesClosed).toHaveLength(outcome === "terminal" ? 2 : 1);
    },
  );

  it.each([false, true])(
    "keeps thrown 421 lookalikes ambiguous unless fallback recovers (%s)",
    async (fallback) => {
      const edgeError = Object.assign(new Error("421 Misdirected Request"), { status: 421 });
      let calls = 0;
      const fetchWithEdgeError: typeof globalThis.fetch = async (input, init) => {
        if (++calls === 1) {
          throw edgeError;
        }
        return fetch(input, init);
      };
      const client = createTelegramClientFetch({
        fetchImpl: asTelegramClientFetch(fetchWithEdgeError),
        transport: { forceFallback: () => fallback },
      })!;
      const sending = client(`${apiRoot}/sendMessage`);
      if (fallback) {
        expect(await (await sending).json()).toEqual({ accepted: true });
      } else {
        await expect(sending).rejects.toBe(edgeError);
        expect(edgeError).not.toBeInstanceOf(TelegramRequestNotStartedError);
      }
      expect(requests).toHaveLength(fallback ? 1 : 0);
    },
  );
});
