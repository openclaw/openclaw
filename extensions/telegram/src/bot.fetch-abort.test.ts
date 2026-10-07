import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { Agent, fetch as undiciFetch } from "undici/index.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { asTelegramClientFetch, createTelegramClientFetch } from "./client-fetch.js";
import { TelegramRequestNotStartedError } from "./network-errors.js";
import {
  bindTelegramTransportAuthority,
  findTelegramRequestAuthorityError,
} from "./request-authority.js";

const effectGate = vi.hoisted(() => ({ prepare: undefined as (() => Promise<void>) | undefined }));
vi.mock("openclaw/plugin-sdk/fetch-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/fetch-runtime")>();
  return {
    ...actual,
    captureEffectAuthority: () => {
      const authority = actual.captureEffectAuthority();
      const prepare = effectGate.prepare;
      return prepare
        ? {
            ...authority,
            initiate: async <T>(effect: () => T | Promise<T>) => {
              await prepare();
              return authority.initiate(effect);
            },
          }
        : authority;
    },
  };
});

describe("Telegram client cancellation and custody", () => {
  // Local socket proof must not inherit the host's global proxy dispatcher.
  const dispatcher = new Agent({ allowH2: false });
  const fetch: typeof globalThis.fetch = (input, init) => {
    const requestInit = { ...init, dispatcher };
    // Keep fetch and Dispatcher on the same Undici ABI across Node releases;
    // the installed fetch implements the standard fetch contract used here.
    return (undiciFetch as unknown as typeof globalThis.fetch)(input, requestInit);
  };
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
    await dispatcher.destroy();
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it.each(["active", "refused", "revoked"] as const)(
    "settles a deferred %s transport handoff and closes rejected uploads",
    async (authority) => {
      const started = createDeferred<void>();
      const release = createDeferred<void>();
      const refusal = new Error("transport authority ended");
      const cancelUpload = vi.fn();
      let prepared = false;
      effectGate.prepare = async () => {
        started.resolve();
        await release.promise;
        prepared = true;
        if (authority === "refused") {
          throw refusal;
        }
      };
      const guardedFetch = bindTelegramTransportAuthority(
        undiciFetch as unknown as typeof globalThis.fetch,
        () => {
          if (prepared && authority === "revoked") {
            throw refusal;
          }
        },
      );
      const init: RequestInit & { duplex: "half" } = {
        method: "POST",
        duplex: "half",
        body: new ReadableStream<Uint8Array>({
          start: (controller) => controller.enqueue(new TextEncoder().encode("{}")),
          pull: (controller) => controller.close(),
          cancel: cancelUpload,
        }),
      };
      const sending = guardedFetch(`${apiRoot}/sendMessage`, init, dispatcher)
        .then((response) => response.json())
        .then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
      try {
        await Promise.race([
          started.promise,
          sending.then(() => {
            throw new Error("transport settled before authority preparation");
          }),
        ]);
        expect(requests).toEqual([]);
        release.resolve();
        const outcome = await sending;
        if ("error" in outcome) {
          expect(authority).not.toBe("active");
          expect(findTelegramRequestAuthorityError(outcome.error)?.originalError).toBe(refusal);
          expect(cancelUpload).toHaveBeenCalledExactlyOnceWith(outcome.error);
          expect(requests).toEqual([]);
        } else {
          expect(authority).toBe("active");
          expect(outcome.value).toEqual({ accepted: true });
          expect(cancelUpload).not.toHaveBeenCalled();
          expect(requests).toEqual(["/bot123:fixture/sendMessage"]);
        }
      } finally {
        release.resolve();
        await sending;
        effectGate.prepare = undefined;
      }
    },
  );

  it.each([
    { refuseAt: 1, rawCalls: 0, wireRequests: 0 },
    { refuseAt: 2, rawCalls: 1, wireRequests: 0 },
    { refuseAt: 0, rawCalls: 2, wireRequests: 1 },
  ])(
    "prepares a fresh raw-source handoff through 421 retry (refuseAt=$refuseAt)",
    async (expected) => {
      const firstStarted = createDeferred<void>();
      const firstRelease = createDeferred<void>();
      const retryStarted = createDeferred<void>();
      const retryRelease = createDeferred<void>();
      const refusal = new Error("raw-source authority ended");
      let preparations = 0;
      let rawCalls = 0;
      effectGate.prepare = async () => {
        const attempt = ++preparations;
        if (attempt > 2) {
          throw new Error("unexpected repeated preparation");
        }
        (attempt === 1 ? firstStarted : retryStarted).resolve();
        await (attempt === 1 ? firstRelease : retryRelease).promise;
        if (attempt === expected.refuseAt) {
          throw refusal;
        }
      };
      const raw: typeof globalThis.fetch = async (input, init) => {
        if (++rawCalls === 1) {
          return new Response(null, { status: 421 });
        }
        return fetch(input, init);
      };
      const client = createTelegramClientFetch({
        fetchImpl: asTelegramClientFetch(raw),
        transport: { sourceFetch: raw, forceFallback: () => true },
      });
      const sending = client(`${apiRoot}/sendMessage`)
        .then((response) => response.json())
        .then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
      const settledBeforePreparation = () =>
        sending.then(() => {
          throw new Error("raw source settled without its prepared handoff");
        });
      try {
        await Promise.race([firstStarted.promise, settledBeforePreparation()]);
        expect(rawCalls).toBe(0);
        expect(requests).toEqual([]);
        firstRelease.resolve();
        if (expected.refuseAt !== 1) {
          await Promise.race([retryStarted.promise, settledBeforePreparation()]);
          expect(rawCalls).toBe(1);
          expect(requests).toEqual([]);
          retryRelease.resolve();
        }
        expect(await sending).toEqual(
          expected.refuseAt ? { error: refusal } : { value: { accepted: true } },
        );
        expect(rawCalls).toBe(expected.rawCalls);
        expect(requests).toHaveLength(expected.wireRequests);
        expect(preparations).toBe(expected.refuseAt === 1 ? 1 : 2);
      } finally {
        firstRelease.resolve();
        retryRelease.resolve();
        await sending;
        effectGate.prepare = undefined;
      }
    },
  );

  it.each(["shutdown", "request"] as const)(
    "keeps %s cancellation attached while the actual response body is pending",
    async (source) => {
      hold = "body";
      const shutdown = new AbortController();
      const request = new AbortController();
      const guardedFetch = bindTelegramTransportAuthority(
        undiciFetch as unknown as typeof globalThis.fetch,
        () => {},
      );
      const transportFetch: typeof globalThis.fetch = (input, init) =>
        guardedFetch(input, init, dispatcher);
      const client = createTelegramClientFetch({
        fetchImpl: asTelegramClientFetch(transportFetch),
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

  it("recovers a timed-out deleteWebhook through the supplied fallback transport", async () => {
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
    const sending = client(`${apiRoot}/deleteWebhook`);
    await arrived.promise;
    await vi.advanceTimersByTimeAsync(15000);
    expect(await (await sending).json()).toEqual({ accepted: true });
    expect(reasons).toEqual(["request-timeout"]);
    expect(requests).toEqual(Array(2).fill("/bot123:fixture/deleteWebhook"));
  });

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
