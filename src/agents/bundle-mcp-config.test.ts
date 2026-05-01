import { describe, expect, it } from "vitest";
import {
  ownerCallerContextTrustedServers,
  ownerWantsBundleMcpCallerContextInjection,
} from "./bundle-mcp-config.js";

describe("ownerCallerContextTrustedServers", () => {
  it("includes only owner mcp.servers entries that declare BOTH injectCallerContext: true AND a non-empty url", () => {
    const trusted = ownerCallerContextTrustedServers({
      plugins: { enabled: false },
      mcp: {
        servers: {
          remote: {
            type: "sse",
            url: "https://example.com/mcp",
            injectCallerContext: true,
          },
          remoteOff: {
            type: "sse",
            url: "https://example.com/other",
            injectCallerContext: false,
          },
          remoteOmitted: {
            type: "sse",
            url: "https://example.com/third",
          },
          // Security: name-only opt-in (no url) must NOT grant trust, otherwise
          // an unrelated earlier merge layer could supply a URL for the same
          // name and still receive caller headers.
          flagNoUrl: {
            injectCallerContext: true,
          },
          // Empty/whitespace url is also rejected.
          flagEmptyUrl: {
            url: "   ",
            injectCallerContext: true,
          },
          // Stdio entries (no url) opting in are ignored too.
          stdioOptIn: {
            command: "node",
            args: ["x.mjs"],
            injectCallerContext: true,
          },
        },
      },
    });

    expect([...trusted.entries()]).toEqual([["remote", "https://example.com/mcp"]]);
  });

  it("returns an empty map when no servers are configured", () => {
    expect([...ownerCallerContextTrustedServers(undefined)]).toEqual([]);
    expect([...ownerCallerContextTrustedServers({ plugins: { enabled: false } })]).toEqual([]);
  });
});

describe("ownerWantsBundleMcpCallerContextInjection", () => {
  it("is true when at least one owner server declares both opt-in and url", () => {
    expect(
      ownerWantsBundleMcpCallerContextInjection({
        plugins: { enabled: false },
        mcp: {
          servers: {
            remote: {
              type: "sse",
              url: "https://example.com/mcp",
              injectCallerContext: true,
            },
          },
        },
      }),
    ).toBe(true);
  });

  it("is false when the owner only sets the flag without a url (no trust granted)", () => {
    expect(
      ownerWantsBundleMcpCallerContextInjection({
        plugins: { enabled: false },
        mcp: {
          servers: {
            flagNoUrl: {
              injectCallerContext: true,
            },
          },
        },
      }),
    ).toBe(false);
  });

  it("is false when no owner server sets injectCallerContext: true", () => {
    expect(
      ownerWantsBundleMcpCallerContextInjection({
        plugins: { enabled: false },
        mcp: {
          servers: {
            remote: {
              type: "sse",
              url: "https://example.com/mcp",
            },
          },
        },
      }),
    ).toBe(false);
  });
});
