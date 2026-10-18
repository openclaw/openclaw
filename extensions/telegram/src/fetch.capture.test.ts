import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resolveTelegramTransport } from "./fetch.js";

const mocks = vi.hoisted(() => ({
  capture: vi.fn<typeof import("openclaw/plugin-sdk/proxy-capture").captureHttpExchangeAsync>(),
  syncCapture: vi.fn(),
  fetch: vi.fn<typeof fetch>(),
  dispatchers: [] as { destroy: ReturnType<typeof vi.fn> }[],
}));

vi.mock("openclaw/plugin-sdk/proxy-capture", () => ({
  captureHttpExchangeAsync: mocks.capture,
  captureHttpExchange: mocks.syncCapture,
  resolveEffectiveDebugProxyUrl: () => undefined,
}));

vi.mock("undici/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("undici")>()),
  Agent: class {
    destroy = vi.fn(async () => {});

    constructor() {
      mocks.dispatchers.push(this);
    }
  },
  fetch: mocks.fetch,
}));

beforeEach(() => {
  mocks.capture.mockReset().mockResolvedValue(undefined);
  mocks.syncCapture.mockReset();
  mocks.fetch.mockReset();
  mocks.dispatchers.length = 0;
  for (const name of [
    "ALL_PROXY",
    "all_proxy",
    "HTTP_PROXY",
    "http_proxy",
    "HTTPS_PROXY",
    "https_proxy",
    "NO_PROXY",
    "no_proxy",
    "OPENCLAW_PROXY_URL",
    "OPENCLAW_PROXY_ACTIVE",
    "OPENCLAW_PROXY_CA_FILE",
  ]) {
    vi.stubEnv(name, "");
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
});

it("preserves caller responses, errors, and dispatcher ownership when capture rejects", async () => {
  mocks.capture.mockRejectedValue(new Error("diagnostic store failed"));
  const response = new Response('{"ok":true,"result":{"id":123}}');
  const transportError = new Error("Telegram request failed");
  mocks.fetch.mockResolvedValueOnce(response).mockRejectedValueOnce(transportError);
  const callerDispatcher = { destroy: vi.fn() };
  const init = {
    method: "POST",
    body: "{}",
    dispatcher: callerDispatcher,
  };
  const transport = resolveTelegramTransport(undefined, {
    network: { autoSelectFamily: false, dnsResultOrder: "verbatim" },
  });
  const url = "https://api.telegram.org/botfixture/getMe";
  try {
    await expect(transport.fetch(url, init)).resolves.toBe(response);
    await expect(response.json()).resolves.toEqual({ ok: true, result: { id: 123 } });
    expect(mocks.fetch).toHaveBeenCalledOnce();
    expect(mocks.fetch).toHaveBeenCalledWith(
      url,
      expect.objectContaining({
        method: "POST",
        body: "{}",
        dispatcher: callerDispatcher,
      }),
    );
    await expect(transport.fetch(url, init)).rejects.toBe(transportError);
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(mocks.capture).toHaveBeenCalledOnce();
    expect(mocks.capture).toHaveBeenCalledWith(
      expect.objectContaining({
        url,
        method: "POST",
        requestBody: "{}",
        response,
        meta: { subsystem: "telegram-fetch" },
      }),
    );
    expect(mocks.syncCapture).not.toHaveBeenCalled();
  } finally {
    await transport.close();
  }
  await transport.close();
  expect(mocks.dispatchers).toHaveLength(1);
  expect(mocks.dispatchers[0]?.destroy).toHaveBeenCalledOnce();
  expect(callerDispatcher.destroy).not.toHaveBeenCalled();
  await expect(transport.fetch(url, init)).rejects.toThrow("Telegram transport is closed");
  expect(mocks.fetch).toHaveBeenCalledTimes(2);
});
