import { describe, expect, it, vi } from "vitest";
import { botCtorSpy } from "./bot.create-telegram-bot.test-harness.js";
import { createTelegramBot } from "./bot.js";
import { getTelegramNetworkErrorOrigin } from "./network-errors.js";
function createWrappedTelegramClientFetch(proxyFetch) {
  const shutdown = new AbortController();
  botCtorSpy.mockClear();
  createTelegramBot({
    token: "tok",
    fetchAbortSignal: shutdown.signal,
    proxyFetch
  });
  const clientFetch = botCtorSpy.mock.calls.at(-1)?.[1]?.client?.fetch;
  expect(clientFetch).toBeTypeOf("function");
  return { clientFetch, shutdown };
}
describe("createTelegramBot fetch abort", () => {
  it("aborts wrapped client fetch when fetchAbortSignal aborts", async () => {
    const fetchSpy = vi.fn(
      (_input, init) => new Promise((resolve) => {
        const signal = init?.signal;
        signal.addEventListener("abort", () => resolve(signal), { once: true });
      })
    );
    const { clientFetch, shutdown } = createWrappedTelegramClientFetch(
      fetchSpy
    );
    const observedSignalPromise = clientFetch("https://example.test");
    shutdown.abort(new Error("shutdown"));
    const observedSignal = await observedSignalPromise;
    expect(observedSignal).toBeInstanceOf(AbortSignal);
    expect(observedSignal.aborted).toBe(true);
  });
  it("tags wrapped Telegram fetch failures with the Bot API method", async () => {
    const fetchError = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("connect timeout"), {
        code: "UND_ERR_CONNECT_TIMEOUT"
      })
    });
    const fetchSpy = vi.fn(async () => {
      throw fetchError;
    });
    const { clientFetch } = createWrappedTelegramClientFetch(fetchSpy);
    await expect(clientFetch("https://api.telegram.org/bot123456:ABC/getUpdates")).rejects.toBe(
      fetchError
    );
    expect(getTelegramNetworkErrorOrigin(fetchError)).toEqual({
      method: "getupdates",
      url: "https://api.telegram.org/bot123456:ABC/getUpdates"
    });
  });
  it("preserves the original fetch error when tagging cannot attach metadata", async () => {
    const frozenError = Object.freeze(
      Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("connect timeout"), {
          code: "UND_ERR_CONNECT_TIMEOUT"
        })
      })
    );
    const fetchSpy = vi.fn(async () => {
      throw frozenError;
    });
    const { clientFetch } = createWrappedTelegramClientFetch(fetchSpy);
    await expect(clientFetch("https://api.telegram.org/bot123456:ABC/getUpdates")).rejects.toBe(
      frozenError
    );
    expect(getTelegramNetworkErrorOrigin(frozenError)).toBeNull();
  });
});
