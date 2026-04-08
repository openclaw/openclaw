import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./cdp-proxy-bypass.js", () => ({
  getDirectAgentForCdp: vi.fn(() => null),
  withNoProxyForCdpUrl: vi.fn(async (_url: string, fn: () => Promise<unknown>) => await fn()),
}));

const { fetchCdpChecked } = await import("./cdp.helpers.js");

describe("fetchCdpChecked", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("disables automatic redirect following for CDP HTTP probes", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { Location: "http://127.0.0.1:9222/json/version" },
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    await expect(fetchCdpChecked("https://browser.example/json/version", 50)).rejects.toThrow(
      "CDP endpoint redirects are not allowed",
    );

    const init = fetchSpy.mock.calls[0]?.[1];
    expect(init?.redirect).toBe("manual");
  });
});
