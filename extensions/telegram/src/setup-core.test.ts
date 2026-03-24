import { describe, expect, it, vi } from "vitest";
import { resolveTelegramAllowFromEntries } from "./setup-core.js";

describe("resolveTelegramAllowFromEntries", () => {
  it("passes apiRoot through username lookups", async () => {
    const globalFetch = vi.fn(async () => {
      throw new Error("global fetch should not be called");
    });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, result: { id: 12345 } }),
    }));
    vi.stubGlobal("fetch", globalFetch);
    const proxyFetch = vi.fn();
    const fetchModule = await import("./fetch.js");
    const proxyModule = await import("./proxy.js");
    const resolveTelegramFetch = vi.spyOn(fetchModule, "resolveTelegramFetch");
    const makeProxyFetch = vi.spyOn(proxyModule, "makeProxyFetch");
    makeProxyFetch.mockReturnValue(proxyFetch as unknown as typeof fetch);
    resolveTelegramFetch.mockReturnValue(fetchMock as unknown as typeof fetch);

    try {
      const resolved = await resolveTelegramAllowFromEntries({
        entries: ["@user"],
        credentialValue: "tok",
        apiRoot: "https://custom.telegram.test/root/",
        proxyUrl: "http://127.0.0.1:8080",
        network: { autoSelectFamily: false, dnsResultOrder: "ipv4first" },
      });

      expect(resolved).toEqual([{ input: "@user", resolved: true, id: "12345" }]);
      expect(makeProxyFetch).toHaveBeenCalledWith("http://127.0.0.1:8080");
      expect(resolveTelegramFetch).toHaveBeenCalledWith(proxyFetch, {
        network: { autoSelectFamily: false, dnsResultOrder: "ipv4first" },
      });
      expect(fetchMock).toHaveBeenCalledWith(
        "https://custom.telegram.test/root/bottok/getChat?chat_id=%40user",
        undefined,
      );
    } finally {
      makeProxyFetch.mockRestore();
      resolveTelegramFetch.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
