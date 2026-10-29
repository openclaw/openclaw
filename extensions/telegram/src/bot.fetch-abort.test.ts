import { createServer, type ServerResponse } from "node:http";
import { Api, HttpError } from "grammy";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { Agent, fetch as undiciFetch } from "undici/index.js";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { listenOnLoopback } from "../../test-support/hanging-loopback-server.js";
import { asTelegramClientFetch, createTelegramClientFetch } from "./client-fetch.js";
import { isSafeToRetrySendError, TelegramRequestNotStartedError } from "./network-errors.js";
import {
  bindTelegramRequestAuthority,
  bindTelegramTransportAuthority,
  findTelegramRequestAuthorityError,
} from "./request-authority.js";
import { createTelegramNonIdempotentRequestWithDiag } from "./send-context.js";

const effectGate = await vi.hoisted(async () =>
  (
    await import("../../test-support/effect-preparation.test-support.js")
  ).createEffectPreparationGate(),
);
// mock-isolation: Share the export-preserving factory, but keep the preparation gate suite-local.
vi.mock("openclaw/plugin-sdk/fetch-runtime", effectGate.mockRuntime);

// Local socket proof must not inherit the host's global proxy dispatcher.
const dispatcher = new Agent({ allowH2: false });
// Keep fetch and Dispatcher on the same Undici ABI across Node releases.
const fetch: typeof globalThis.fetch = (input, init) => {
  const requestInit = { ...init, dispatcher };
  return (undiciFetch as unknown as typeof globalThis.fetch)(input, requestInit);
};
const clientFor = (options: Partial<Parameters<typeof createTelegramClientFetch>[0]> = {}) =>
  createTelegramClientFetch({ fetchImpl: asTelegramClientFetch(fetch), ...options });
const responses = new Set<ServerResponse>();
const requests: string[] = [];
const observeResponse = (sending: Promise<Pick<Response, "json">>) =>
  sending
    .then((response) => response.json())
    .then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
async function waitForPreparation(started: Promise<void>, sending: Promise<unknown>) {
  await Promise.race([
    started,
    sending.then(() => {
      throw new Error("transport settled before authority preparation");
    }),
  ]);
  expect(requests).toEqual([]);
}
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
  apiRoot = `http://127.0.0.1:${await listenOnLoopback(server)}/bot123:fixture`;
});
beforeEach(() => {
  requests.length = 0;
  hold = undefined;
  arrived = createDeferred<void>();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  responses.forEach((response) => response.destroy());
});
afterAll(async () => {
  await dispatcher.destroy();
  server.closeAllConnections();
  await server[Symbol.asyncDispose]();
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
    const sending = observeResponse(guardedFetch(`${apiRoot}/sendMessage`, init, dispatcher));
    try {
      await waitForPreparation(started.promise, sending);
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
    const client = clientFor({
      fetchImpl: asTelegramClientFetch(raw),
      transport: { sourceFetch: raw, forceFallback: () => true },
    });
    const sending = observeResponse(client(`${apiRoot}/sendMessage`));
    try {
      await waitForPreparation(firstStarted.promise, sending);
      expect(rawCalls).toBe(0);
      firstRelease.resolve();
      if (expected.refuseAt !== 1) {
        await waitForPreparation(retryStarted.promise, sending);
        expect(rawCalls).toBe(1);
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
    const client = clientFor({
      fetchImpl: asTelegramClientFetch(transportFetch),
      shutdownSignal: shutdown.signal,
    });
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
  ["getUpdates", 45000],
  ["deleteWebhook", 15000],
] as const)("settles held %s at its own deadline", async (method, deadline) => {
  hold = "headers";
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const forceFallback = vi.fn(() => true);
  const fallback = method === "deleteWebhook";
  const client = clientFor(fallback ? { transport: { forceFallback } } : {});
  let settled = false;
  const sending = client(`${apiRoot}/${method}`).finally(() => {
    settled = true;
  });
  const failure = fallback
    ? undefined
    : expect(sending).rejects.toThrow(`timed out after ${deadline}ms`);
  await arrived.promise;
  await vi.advanceTimersByTimeAsync(deadline - 1);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  if (fallback) {
    expect(await (await sending).json()).toEqual({ accepted: true });
    expect(forceFallback).toHaveBeenCalledExactlyOnceWith("request-timeout");
    expect(requests).toEqual(Array(2).fill(`/bot123:fixture/${method}`));
  } else {
    await failure;
    expect(requests).toHaveLength(1);
  }
});

it("releases both transport-returned 421 bodies before rejecting terminal custody", async () => {
  const bodiesClosed: Promise<void>[] = [];
  let calls = 0;
  let fallbacks = 0;
  const client = clientFor({
    fetchImpl: asTelegramClientFetch(async () => {
      calls++;
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
      forceFallback: () => fallbacks++ === 0,
    },
  });
  const sending = client(`${apiRoot}/sendMessage`);
  await expect(sending).rejects.toBeInstanceOf(TelegramRequestNotStartedError);
  await Promise.all(bodiesClosed);
  expect(calls).toBe(2);
  expect(bodiesClosed).toHaveLength(2);
});

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
    const client = clientFor({
      fetchImpl: asTelegramClientFetch(fetchWithEdgeError),
      transport: { forceFallback: () => fallback },
    });
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

it.each(["headers", "body"] as const)(
  "preserves an ambiguous owned deadline through grammY while %s are pending",
  async (phase) => {
    hold = phase;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const headers = createDeferred<void>();
    const forceFallback = vi.fn(() => true);
    const observedFetch: typeof fetch = async (input, init) => {
      const response = await fetch(input, init);
      headers.resolve();
      return response;
    };
    const client = clientFor({
      fetchImpl: asTelegramClientFetch(observedFetch),
      transport: { forceFallback },
    });
    const api = new Api("123:fixture", {
      apiRoot: new URL(apiRoot).origin,
      fetch: asTelegramClientFetch(client),
    });
    const request = createTelegramNonIdempotentRequestWithDiag({
      cfg: {},
      useApiErrorLogging: false,
    });
    const sending = request(() => api.sendMessage(123, "Saved final answer"), "sendMessage");
    const failure = expect(sending).rejects.toMatchObject({
      error: { code: "ETIMEDOUT", message: "Telegram sendmessage timed out after 60000ms" },
    });
    await arrived.promise;
    if (phase === "body") {
      await headers.promise;
    }
    await vi.advanceTimersByTimeAsync(60_000);
    await failure;
    const error: unknown = await sending.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HttpError);
    expect(isSafeToRetrySendError(error)).toBe(false);
    expect(requests).toEqual(["/bot123:fixture/sendMessage"]);
    expect(forceFallback).not.toHaveBeenCalled();
  },
);

it.each(["shutdown", "request", "authority"] as const)(
  "preserves %s rejection when preparation settles after the request deadline",
  async (source) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const started = createDeferred<void>();
    const release = createDeferred<void>();
    const cancellation = new Error("caller ended this request");
    const shutdown = new AbortController();
    const request = new AbortController();
    let current = true;
    effectGate.prepare = async () => {
      started.resolve();
      await release.promise;
    };
    const forceFallback = vi.fn(() => true);
    const client = bindTelegramRequestAuthority(
      asTelegramClientFetch(
        clientFor({
          shutdownSignal: shutdown.signal,
          transport: { sourceFetch: fetch, forceFallback },
        }),
      ),
      () => {
        if (!current) {
          throw cancellation;
        }
      },
    );
    // Use a control method as well: a masked refusal must not select a fallback.
    const sending = observeResponse(client(`${apiRoot}/deleteWebhook`, { signal: request.signal }));
    try {
      await waitForPreparation(started.promise, sending);
      if (source === "authority") {
        current = false;
      } else {
        (source === "shutdown" ? shutdown : request).abort(cancellation);
      }
      await vi.advanceTimersByTimeAsync(15_000);
      release.resolve();
      const outcome = await sending;
      expect(outcome).toHaveProperty("error");
      if ("error" in outcome) {
        expect(
          source === "authority"
            ? findTelegramRequestAuthorityError(outcome.error)?.originalError
            : outcome.error,
        ).toBe(cancellation);
        expect(outcome.error).not.toHaveProperty("code");
      }
      expect(requests).toEqual([]);
      expect(forceFallback).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await sending;
      effectGate.prepare = undefined;
    }
  },
);
