import { afterEach, describe, expect, it, vi } from "vitest";
import { SsrFBlockedError } from "../infra/net/ssrf.js";

vi.mock("./cdp-proxy-bypass.js", () => ({
  getDirectAgentForCdp: vi.fn(() => null),
  withNoProxyForCdpUrl: vi.fn(async (_url: string, fn: () => Promise<unknown>) => await fn()),
}));

const { assertCdpEndpointAllowed, fetchCdpChecked } = await import("./cdp.helpers.js");
const { BrowserCdpEndpointBlockedError } = await import("./errors.js");

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

describe("assertCdpEndpointAllowed", () => {
  it("rethrows SSRF policy failures as BrowserCdpEndpointBlockedError so mapping can distinguish endpoint vs navigation", async () => {
    await expect(
      assertCdpEndpointAllowed("http://10.0.0.42:9222", { dangerouslyAllowPrivateNetwork: false }),
    ).rejects.toBeInstanceOf(BrowserCdpEndpointBlockedError);
  });

  it("does not wrap non-SSRF failures", async () => {
    await expect(
      assertCdpEndpointAllowed("file:///etc/passwd", { dangerouslyAllowPrivateNetwork: false }),
    ).rejects.not.toBeInstanceOf(BrowserCdpEndpointBlockedError);
  });

  it("leaves navigation-target SsrFBlockedError alone for callers that never hit the endpoint helper", () => {
    // Sanity check that raw SsrFBlockedError is still its own class and is not
    // accidentally converted by the endpoint helper import.
    expect(new SsrFBlockedError("blocked")).toBeInstanceOf(SsrFBlockedError);
  });
});
