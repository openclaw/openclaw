import { describe, expect, it, vi } from "vitest";
import { getTelegramNetworkErrorOrigin } from "./network-errors.js";

const { botCtorSpy, telegramBotRuntimeForTest } =
  await import("./bot.create-telegram-bot.test-harness.js");
const { createTelegramBot, setTelegramBotRuntimeForTest } = await import("./bot.js");
const { setBotHandlersRuntimeForTest } = await import("./bot-handlers.runtime.js");
const { setBotMessageDispatchRuntimeForTest } = await import("./bot-message-dispatch.js");
const { setBotNativeCommandsRuntimeForTest } = await import("./bot-native-commands.js");

setTelegramBotRuntimeForTest(telegramBotRuntimeForTest);
setBotHandlersRuntimeForTest();
setBotMessageDispatchRuntimeForTest();
setBotNativeCommandsRuntimeForTest();

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
  it("aborts wrapped client fetch when fetchAbortSignal aborts", async () => {
    const fetchSpy = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<AbortSignal>((resolve) => {
          const signal = init?.signal as AbortSignal;
          signal.addEventListener("abort", () => resolve(signal), { once: true });
        }),
    );
    const { clientFetch, shutdown } = createWrappedTelegramClientFetch(
      fetchSpy as unknown as typeof fetch,
    );

    const observedSignalPromise = clientFetch("https://example.test");
    shutdown.abort(new Error("shutdown"));
    const observedSignal = (await observedSignalPromise) as AbortSignal;

    expect(observedSignal).toBeInstanceOf(AbortSignal);
    expect(observedSignal.aborted).toBe(true);
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
