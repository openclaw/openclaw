import { beforeEach, describe, expect, it, vi } from "vitest";
const { botApi, botCtorSpy } = vi.hoisted(() => ({
  botApi: {
    sendMessage: vi.fn(),
    setMessageReaction: vi.fn(),
    deleteMessage: vi.fn()
  },
  botCtorSpy: vi.fn()
}));
const { loadConfig } = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({}))
}));
const { makeProxyFetch } = vi.hoisted(() => ({
  makeProxyFetch: vi.fn()
}));
const { resolveTelegramFetch } = vi.hoisted(() => ({
  resolveTelegramFetch: vi.fn()
}));
vi.mock("../../../src/config/config.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    loadConfig
  };
});
vi.mock("./proxy.js", () => ({
  makeProxyFetch
}));
vi.mock("./fetch.js", () => ({
  resolveTelegramFetch
}));
vi.mock("grammy", () => ({
  Bot: class {
    constructor(token, options) {
      this.token = token;
      this.options = options;
      this.api = botApi;
      this.catch = vi.fn();
      botCtorSpy(token, options);
    }
  },
  InputFile: class {
  }
}));
import {
  deleteMessageTelegram,
  reactMessageTelegram,
  resetTelegramClientOptionsCacheForTests,
  sendMessageTelegram
} from "./send.js";
describe("telegram proxy client", () => {
  const proxyUrl = "http://proxy.test:8080";
  const prepareProxyFetch = () => {
    const proxyFetch = vi.fn();
    const fetchImpl = vi.fn();
    makeProxyFetch.mockReturnValue(proxyFetch);
    resolveTelegramFetch.mockReturnValue(fetchImpl);
    return { proxyFetch, fetchImpl };
  };
  const expectProxyClient = (fetchImpl) => {
    expect(makeProxyFetch).toHaveBeenCalledWith(proxyUrl);
    expect(resolveTelegramFetch).toHaveBeenCalledWith(expect.any(Function), { network: void 0 });
    expect(botCtorSpy).toHaveBeenCalledWith(
      "tok",
      expect.objectContaining({
        client: expect.objectContaining({ fetch: fetchImpl })
      })
    );
  };
  beforeEach(() => {
    resetTelegramClientOptionsCacheForTests();
    vi.unstubAllEnvs();
    botApi.sendMessage.mockResolvedValue({ message_id: 1, chat: { id: "123" } });
    botApi.setMessageReaction.mockResolvedValue(void 0);
    botApi.deleteMessage.mockResolvedValue(true);
    botCtorSpy.mockClear();
    loadConfig.mockReturnValue({
      channels: { telegram: { accounts: { foo: { proxy: proxyUrl } } } }
    });
    makeProxyFetch.mockClear();
    resolveTelegramFetch.mockClear();
  });
  it("reuses cached Telegram client options for repeated sends with same account transport settings", async () => {
    const { fetchImpl } = prepareProxyFetch();
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "production");
    await sendMessageTelegram("123", "first", { token: "tok", accountId: "foo" });
    await sendMessageTelegram("123", "second", { token: "tok", accountId: "foo" });
    expect(makeProxyFetch).toHaveBeenCalledTimes(1);
    expect(resolveTelegramFetch).toHaveBeenCalledTimes(1);
    expect(botCtorSpy).toHaveBeenCalledTimes(2);
    expect(botCtorSpy).toHaveBeenNthCalledWith(
      1,
      "tok",
      expect.objectContaining({
        client: expect.objectContaining({ fetch: fetchImpl })
      })
    );
    expect(botCtorSpy).toHaveBeenNthCalledWith(
      2,
      "tok",
      expect.objectContaining({
        client: expect.objectContaining({ fetch: fetchImpl })
      })
    );
  });
  it.each([
    {
      name: "sendMessage",
      run: () => sendMessageTelegram("123", "hi", { token: "tok", accountId: "foo" })
    },
    {
      name: "reactions",
      run: () => reactMessageTelegram("123", "456", "\u2705", { token: "tok", accountId: "foo" })
    },
    {
      name: "deleteMessage",
      run: () => deleteMessageTelegram("123", "456", { token: "tok", accountId: "foo" })
    }
  ])("uses proxy fetch for $name", async (testCase) => {
    const { fetchImpl } = prepareProxyFetch();
    await testCase.run();
    expectProxyClient(fetchImpl);
  });
});
