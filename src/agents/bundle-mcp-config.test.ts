/** Tests merging bundled MCP defaults with OpenClaw user MCP configuration. */
import { describe, expect, it, vi } from "vitest";
import {
  loadMergedBundleMcpConfig,
  ownerCallerContextTrustedServers,
  ownerWantsBundleMcpCallerContextInjection,
  toCliBundleMcpServerConfig,
} from "./bundle-mcp-config.js";

const mocks = vi.hoisted(() => ({
  bundleMcp: {
    config: {
      mcpServers: {
        bundleProbe: {
          command: "node",
          args: ["./servers/probe.mjs"],
        },
      },
    },
    diagnostics: [],
  },
}));

vi.mock("../plugins/bundle-mcp.js", () => ({
  loadEnabledBundleMcpConfig: () => mocks.bundleMcp,
}));

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

describe("loadMergedBundleMcpConfig", () => {
  it("lets OpenClaw mcp.servers override bundle defaults while preserving raw transport shape", () => {
    const merged = loadMergedBundleMcpConfig({
      workspaceDir: "/workspace",
      cfg: {
        plugins: {
          entries: {
            "bundle-probe": { enabled: true },
          },
        },
        mcp: {
          servers: {
            bundleProbe: {
              transport: "streamable-http",
              url: "https://mcp.example.com/mcp",
            },
          },
        },
      },
    });

    expect(merged.config.mcpServers.bundleProbe).toEqual({
      transport: "streamable-http",
      url: "https://mcp.example.com/mcp",
    });
  });

  it("maps OpenClaw transports to downstream CLI types when requested", () => {
    expect(
      toCliBundleMcpServerConfig({
        transport: "streamable-http",
        url: "https://mcp.example.com/mcp",
      }),
    ).toEqual({
      type: "http",
      url: "https://mcp.example.com/mcp",
    });
    expect(toCliBundleMcpServerConfig({ type: "sse", transport: "streamable-http" })).toEqual({
      type: "sse",
    });
  });

  it("keeps disabled OpenClaw MCP servers out of embedded runtimes", () => {
    const merged = loadMergedBundleMcpConfig({
      workspaceDir: "/workspace",
      cfg: {
        mcp: {
          servers: {
            disabledDocs: {
              enabled: false,
              command: "node",
              args: ["docs.mjs"],
            },
          },
        },
      },
    });

    expect(merged.config.mcpServers).not.toHaveProperty("disabledDocs");
  });

  it("lets disabled OpenClaw MCP servers tombstone bundle defaults with the same name", () => {
    const merged = loadMergedBundleMcpConfig({
      workspaceDir: "/workspace",
      cfg: {
        mcp: {
          servers: {
            bundleProbe: {
              enabled: false,
            },
          },
        },
      },
    });

    expect(merged.config.mcpServers).not.toHaveProperty("bundleProbe");
  });
});
