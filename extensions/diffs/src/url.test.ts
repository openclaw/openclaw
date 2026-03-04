import { describe, expect, it } from "vitest";
import { buildViewerUrl, normalizeViewerBaseUrl } from "./url.js";

describe("diffs viewer URL helpers", () => {
  it("defaults to loopback for lan/tailnet bind modes", () => {
    expect(
      buildViewerUrl({
        config: { gateway: { bind: "lan", port: 18789 } },
        viewerPath: "/plugins/diffs/view/id/token",
      }),
    ).toBe("http://127.0.0.1:18789/plugins/diffs/view/id/token");

    expect(
      buildViewerUrl({
        config: { gateway: { bind: "tailnet", port: 24444 } },
        viewerPath: "/plugins/diffs/view/id/token",
      }),
    ).toBe("http://127.0.0.1:24444/plugins/diffs/view/id/token");
  });

  it("uses custom bind host when provided", () => {
    expect(
      buildViewerUrl({
        config: {
          gateway: {
            bind: "custom",
            customBindHost: "gateway.example.com",
            port: 443,
            tls: { enabled: true },
          },
        },
        viewerPath: "/plugins/diffs/view/id/token",
      }),
    ).toBe("https://gateway.example.com/plugins/diffs/view/id/token");
  });

  it("joins viewer path under baseUrl pathname", () => {
    expect(
      buildViewerUrl({
        config: {},
        baseUrl: "https://example.com/openclaw",
        viewerPath: "/plugins/diffs/view/id/token",
      }),
    ).toBe("https://example.com/openclaw/plugins/diffs/view/id/token");
  });

  it("rejects base URLs with query/hash", () => {
    expect(() => normalizeViewerBaseUrl("https://example.com?a=1")).toThrow(
      "baseUrl must not include query/hash",
    );
    expect(() => normalizeViewerBaseUrl("https://example.com#frag")).toThrow(
      "baseUrl must not include query/hash",
    );
  });
});
