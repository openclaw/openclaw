import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const undiciFetch = vi.fn();
  const proxyAgentSpy = vi.fn();
  const setGlobalDispatcher = vi.fn();
  class ProxyAgent {
    static lastCreated: ProxyAgent | undefined;
    proxyUrl: string;
    constructor(proxyUrl: string) {
      this.proxyUrl = proxyUrl;
      ProxyAgent.lastCreated = this;
      proxyAgentSpy(proxyUrl);
    }
  }

  return {
    ProxyAgent,
    undiciFetch,
    proxyAgentSpy,
    setGlobalDispatcher,
    getLastAgent: () => ProxyAgent.lastCreated,
  };
});

vi.mock("undici", () => ({
  ProxyAgent: mocks.ProxyAgent,
  fetch: mocks.undiciFetch,
  setGlobalDispatcher: mocks.setGlobalDispatcher,
}));

type ProxyModule = typeof import("./proxy.js");

let getProxyUrlFromFetch: ProxyModule["getProxyUrlFromFetch"];
let makeProxyFetch: ProxyModule["makeProxyFetch"];

describe("makeProxyFetch", () => {
  beforeEach(async () => {
    vi.resetModules();
    ({ getProxyUrlFromFetch, makeProxyFetch } = await import("./proxy.js"));
    mocks.undiciFetch.mockReset();
    mocks.proxyAgentSpy.mockReset();
    mocks.setGlobalDispatcher.mockReset();
  });

  it("uses undici fetch with ProxyAgent dispatcher", async () => {
    const proxyUrl = "http://proxy.test:8080";
    mocks.undiciFetch.mockResolvedValue({ ok: true });

    const proxyFetch = makeProxyFetch(proxyUrl);
    await proxyFetch("https://api.telegram.org/bot123/getMe");

    expect(mocks.proxyAgentSpy).toHaveBeenCalledWith(proxyUrl);
    expect(mocks.undiciFetch).toHaveBeenCalledWith(
      "https://api.telegram.org/bot123/getMe",
      expect.objectContaining({ dispatcher: mocks.getLastAgent() }),
    );
    expect(mocks.setGlobalDispatcher).not.toHaveBeenCalled();
  });

  it("attaches proxy metadata for resolver transport handling", () => {
    const proxyUrl = "http://proxy.test:8080";
    const proxyFetch = makeProxyFetch(proxyUrl);

    expect(getProxyUrlFromFetch(proxyFetch)).toBe(proxyUrl);
  });
});
