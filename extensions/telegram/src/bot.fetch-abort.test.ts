import { describe, expect, it, vi } from "vitest";
import { botCtorSpy, useSpy } from "./bot.create-telegram-bot.test-harness.js";
import { createTelegramBot } from "./bot.js";
import { getTelegramNetworkErrorOrigin } from "./network-errors.js";

function createWrappedTelegramClientFetch(proxyFetch: typeof fetch) {
  const shutdown = new AbortController();
  botCtorSpy.mockClear();
  createTelegramBot({
    token: "tok",
    fetchAbortSignal: shutdown.signal,
    proxyFetch,
  });
  const clientFetch = (botCtorSpy.mock.calls.at(-1)?.[1] as { client?: { fetch?: unknown } })
    ?.client?.fetch as (input: RequestInfo | URL, init?: RequestInit) => Promise<unknown>;
  expect(clientFetch).toBeTypeOf("function");
  return { clientFetch, shutdown };
}

describe("createTelegramBot fetch abort", () => {
  it("aborts getUpdates when fetchAbortSignal aborts", async () => {
    createWrappedTelegramClientFetch(vi.fn() as unknown as typeof fetch);
    const shutdown = new AbortController();
    useSpy.mockClear();
    createTelegramBot({
      token: "tok",
      fetchAbortSignal: shutdown.signal,
      proxyFetch: vi.fn() as unknown as typeof fetch,
    });
    const pollingAbortMiddleware = useSpy.mock.calls.at(-1)?.[0] as
      | ((
          prev: (method: string, payload: unknown, signal?: AbortSignal) => Promise<AbortSignal>,
          method: string,
          payload: unknown,
          signal?: AbortSignal,
        ) => Promise<AbortSignal>)
      | undefined;
    expect(typeof pollingAbortMiddleware).toBe("function");

    const observedSignalPromise = pollingAbortMiddleware!(
      (_method, _payload, signal) =>
        new Promise<AbortSignal>((resolve) => {
          signal?.addEventListener("abort", () => resolve(signal), { once: true });
        }),
      "getUpdates",
      {},
    );

    shutdown.abort(new Error("shutdown"));
    const observedSignal = await observedSignalPromise;
    expect(observedSignal.aborted).toBe(true);
  });

  it("does not abort non-polling requests when fetchAbortSignal aborts", async () => {
    const shutdown = new AbortController();
    useSpy.mockClear();
    createTelegramBot({
      token: "tok",
      fetchAbortSignal: shutdown.signal,
      proxyFetch: vi.fn() as unknown as typeof fetch,
    });
    const pollingAbortMiddleware = useSpy.mock.calls.at(-1)?.[0] as
      | ((
          prev: (method: string, payload: unknown, signal?: AbortSignal) => Promise<AbortSignal>,
          method: string,
          payload: unknown,
          signal?: AbortSignal,
        ) => Promise<AbortSignal>)
      | undefined;
    expect(typeof pollingAbortMiddleware).toBe("function");

    const originalSignal = new AbortController().signal;
    const observedSignal = await pollingAbortMiddleware!(
      async (_method, _payload, signal) => signal ?? originalSignal,
      "sendMessage",
      {},
      originalSignal,
    );
    shutdown.abort(new Error("shutdown"));

    expect(observedSignal).toBe(originalSignal);
    expect(observedSignal.aborted).toBe(false);
  });

  it("tags wrapped Telegram fetch failures with the Bot API method", async () => {
    const fetchError = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("connect timeout"), {
        code: "UND_ERR_CONNECT_TIMEOUT",
      }),
    });
    const fetchSpy = vi.fn(async () => {
      throw fetchError;
    });
    const { clientFetch } = createWrappedTelegramClientFetch(fetchSpy as unknown as typeof fetch);

    await expect(clientFetch("https://api.telegram.org/bot123456:ABC/getUpdates")).rejects.toBe(
      fetchError,
    );
    expect(getTelegramNetworkErrorOrigin(fetchError)).toEqual({
      method: "getupdates",
      url: "https://api.telegram.org/bot123456:ABC/getUpdates",
    });
  });

  it("preserves the original fetch error when tagging cannot attach metadata", async () => {
    const frozenError = Object.freeze(
      Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("connect timeout"), {
          code: "UND_ERR_CONNECT_TIMEOUT",
        }),
      }),
    );
    const fetchSpy = vi.fn(async () => {
      throw frozenError;
    });
    const { clientFetch } = createWrappedTelegramClientFetch(fetchSpy as unknown as typeof fetch);

    await expect(clientFetch("https://api.telegram.org/bot123456:ABC/getUpdates")).rejects.toBe(
      frozenError,
    );
    expect(getTelegramNetworkErrorOrigin(frozenError)).toBeNull();
  });
});
