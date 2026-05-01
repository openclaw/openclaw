import { describe, expect, it } from "vitest";
import {
  ownerCallerContextOptInServerNames,
  ownerWantsBundleMcpCallerContextInjection,
} from "./bundle-mcp-config.js";

describe("ownerCallerContextOptInServerNames", () => {
  it("collects only owner mcp.servers entries with injectCallerContext: true", () => {
    const names = ownerCallerContextOptInServerNames({
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
        },
      },
    });

    expect([...names]).toEqual(["remote"]);
  });

  it("returns an empty set when no servers are configured", () => {
    expect([...ownerCallerContextOptInServerNames(undefined)]).toEqual([]);
    expect([...ownerCallerContextOptInServerNames({ plugins: { enabled: false } })]).toEqual([]);
  });
});

describe("ownerWantsBundleMcpCallerContextInjection", () => {
  it("is true when at least one owner server opts in", () => {
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
