import { beforeEach, describe, expect, it, vi } from "vitest";

const { botApi, botCtorSpy } = vi.hoisted(() => ({
  botApi: {
    sendMessage: vi.fn(),
    sendPhoto: vi.fn(),
    setMessageReaction: vi.fn(),
    deleteMessage: vi.fn(),
  },
  botCtorSpy: vi.fn(),
}));

const { loadConfig } = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({})),
}));

const { makeProxyFetch } = vi.hoisted(() => ({
  makeProxyFetch: vi.fn(),
}));

const { resolveTelegramTransport, shouldRetryTelegramIpv4Fallback } = vi.hoisted(() => ({
  resolveTelegramTransport: vi.fn(),
  shouldRetryTelegramIpv4Fallback: vi.fn(() => true),
}));

const { loadWebMedia } = vi.hoisted(() => ({
  loadWebMedia: vi.fn(),
}));

vi.mock("../../../src/config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/config/config.js")>();
  return {
    ...actual,
    loadConfig,
  };
});

vi.mock("./proxy.js", () => ({
  makeProxyFetch,
}));

vi.mock("../../whatsapp/src/media.js", () => ({
  loadWebMedia,
}));

vi.mock("./fetch.js", () => ({
  resolveTelegramTransport,
  shouldRetryTelegramIpv4Fallback,
}));

vi.mock("grammy", () => ({
  Bot: class {
    api = { ...botApi };
    catch = vi.fn();
    constructor(
      public token: string,
      public options?: { client?: { fetch?: typeof fetch; timeoutSeconds?: number } },
    ) {
      botCtorSpy(token, options);
    }
  },
  InputFile: class {},
}));

import {
  deleteMessageTelegram,
  reactMessageTelegram,
  resetTelegramClientOptionsCacheForTests,
  sendMessageTelegram,
} from "./send.js";

describe("telegram proxy client", () => {
  const proxyUrl = "http://proxy.test:8080";

  const prepareProxyTransport = () => {
    const proxyFetch = vi.fn();
    const clientFetch = vi.fn();
    const sourceFetch = vi.fn();
    const transport = {
      fetch: clientFetch as unknown as typeof fetch,
      sourceFetch: sourceFetch as unknown as typeof fetch,
      pinnedDispatcherPolicy: { mode: "explicit-proxy", proxyUrl } as const,
      fallbackPinnedDispatcherPolicy: { mode: "direct" } as const,
    };
    makeProxyFetch.mockReturnValue(proxyFetch as unknown as typeof fetch);
    resolveTelegramTransport.mockReturnValue(transport);
    return { proxyFetch, transport };
  };

  const expectProxyClient = (transport: ReturnType<typeof prepareProxyTransport>["transport"]) => {
    expect(makeProxyFetch).toHaveBeenCalledWith(proxyUrl);
    expect(resolveTelegramTransport).toHaveBeenCalledWith(expect.any(Function), {
      network: undefined,
    });
    expect(botCtorSpy).toHaveBeenCalledWith(
      "tok",
      expect.objectContaining({
        client: expect.objectContaining({ fetch: transport.fetch }),
      }),
    );
  };

  beforeEach(() => {
    resetTelegramClientOptionsCacheForTests();
    vi.unstubAllEnvs();
    botApi.sendMessage.mockResolvedValue({ message_id: 1, chat: { id: "123" } });
    botApi.setMessageReaction.mockResolvedValue(undefined);
    botApi.deleteMessage.mockResolvedValue(true);
    botApi.sendPhoto.mockResolvedValue({ message_id: 2, chat: { id: "123" } });
    botCtorSpy.mockClear();
    loadConfig.mockReturnValue({
      channels: { telegram: { accounts: { foo: { proxy: proxyUrl } } } },
    });
    makeProxyFetch.mockClear();
    resolveTelegramTransport.mockClear();
    loadWebMedia.mockReset();
  });

  it("reuses cached Telegram client options for repeated sends with same account transport settings", async () => {
    const { transport } = prepareProxyTransport();
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "production");

    await sendMessageTelegram("123", "first", { token: "tok", accountId: "foo" });
    await sendMessageTelegram("123", "second", { token: "tok", accountId: "foo" });

    expect(makeProxyFetch).toHaveBeenCalledTimes(1);
    expect(resolveTelegramTransport).toHaveBeenCalledTimes(1);
    expect(botCtorSpy).toHaveBeenCalledTimes(2);
    expect(botCtorSpy).toHaveBeenNthCalledWith(
      1,
      "tok",
      expect.objectContaining({
        client: expect.objectContaining({ fetch: transport.fetch }),
      }),
    );
    expect(botCtorSpy).toHaveBeenNthCalledWith(
      2,
      "tok",
      expect.objectContaining({
        client: expect.objectContaining({ fetch: transport.fetch }),
      }),
    );
  });

  it.each([
    {
      name: "sendMessage",
      run: () => sendMessageTelegram("123", "hi", { token: "tok", accountId: "foo" }),
    },
    {
      name: "reactions",
      run: () => reactMessageTelegram("123", "456", "✅", { token: "tok", accountId: "foo" }),
    },
    {
      name: "deleteMessage",
      run: () => deleteMessageTelegram("123", "456", { token: "tok", accountId: "foo" }),
    },
  ])("uses proxy fetch for $name", async (testCase) => {
    const { transport } = prepareProxyTransport();

    await testCase.run();

    expectProxyClient(transport);
  });

  it("uses proxy-aware transport for outbound media prefetch", async () => {
    const { transport } = prepareProxyTransport();
    loadWebMedia.mockResolvedValueOnce({
      buffer: Buffer.from("image"),
      contentType: "image/jpeg",
      fileName: "photo.jpg",
    });

    await sendMessageTelegram("123", "caption", {
      token: "tok",
      accountId: "foo",
      mediaUrl: "https://example.com/photo.jpg",
    });

    expectProxyClient(transport);
    expect(loadWebMedia).toHaveBeenCalledWith(
      "https://example.com/photo.jpg",
      expect.objectContaining({
        fetchImpl: transport.sourceFetch,
        dispatcherPolicy: transport.pinnedDispatcherPolicy,
        fallbackDispatcherPolicy: transport.fallbackPinnedDispatcherPolicy,
        shouldRetryFetchError: expect.any(Function),
      }),
    );
  });
});
