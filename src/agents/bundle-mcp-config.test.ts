import { describe, expect, it, vi } from "vitest";
import { loadMergedBundleMcpConfig, toCliBundleMcpServerConfig } from "./bundle-mcp-config.js";

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

  it("merges bundle, plugin, and user-configured MCP servers in ownership order", () => {
    const merged = loadMergedBundleMcpConfig({
      workspaceDir: "/workspace",
      extraMcpServers: {
        bundleProbe: {
          transport: "streamable-http",
          url: "https://plugin.example.com/mcp",
        },
        pluginOnly: {
          transport: "streamable-http",
          url: "https://plugin-only.example.com/mcp",
        },
      },
      cfg: {
        mcp: {
          servers: {
            bundleProbe: {
              transport: "streamable-http",
              url: "https://configured.example.com/mcp",
            },
          },
        },
      },
    });

    expect(merged.config.mcpServers).toEqual({
      bundleProbe: {
        transport: "streamable-http",
        url: "https://configured.example.com/mcp",
      },
      pluginOnly: {
        transport: "streamable-http",
        url: "https://plugin-only.example.com/mcp",
      },
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
});
