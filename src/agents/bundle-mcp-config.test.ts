import { describe, expect, it, vi } from "vitest";
import {
  filterBundleMcpConfigByToolPolicies,
  loadMergedBundleMcpConfig,
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

  it("filters MCP servers with tool deny policy entries", () => {
    const filtered = filterBundleMcpConfigByToolPolicies({
      config: {
        mcpServers: {
          "twenty-crm": {
            type: "sse",
            url: "https://crm.example.com/mcp",
          },
          calendar: {
            type: "sse",
            url: "https://calendar.example.com/mcp",
          },
        },
      },
      policies: [{ deny: ["mcp__twenty-crm"] }],
    });

    expect(Object.keys(filtered.mcpServers)).toEqual(["calendar"]);
  });

  it("treats MCP tool wildcards as server-level deny entries", () => {
    const filtered = filterBundleMcpConfigByToolPolicies({
      config: {
        mcpServers: {
          openclaw: { type: "http", url: "http://127.0.0.1:3000/mcp" },
          docs: { type: "sse", url: "https://docs.example.com/mcp" },
        },
      },
      policies: [{ deny: ["mcp__openclaw__*"] }],
    });

    expect(Object.keys(filtered.mcpServers)).toEqual(["docs"]);
  });

  it("honors MCP server allowlists without widening to unrelated servers", () => {
    const filtered = filterBundleMcpConfigByToolPolicies({
      config: {
        mcpServers: {
          "twenty-crm": { type: "sse", url: "https://crm.example.com/mcp" },
          docs: { type: "sse", url: "https://docs.example.com/mcp" },
        },
      },
      policies: [{ allow: ["mcp__twenty-crm__*"] }],
    });

    expect(Object.keys(filtered.mcpServers)).toEqual(["twenty-crm"]);
  });

  it("preserves profile-allowed bundle MCP servers", () => {
    const filtered = filterBundleMcpConfigByToolPolicies({
      config: {
        mcpServers: {
          "twenty-crm": { type: "sse", url: "https://crm.example.com/mcp" },
          calendar: { type: "sse", url: "https://calendar.example.com/mcp" },
        },
      },
      policies: [{ allow: ["read", "exec", "bundle-mcp"] }],
    });

    expect(Object.keys(filtered.mcpServers)).toEqual(["twenty-crm", "calendar"]);
  });

  it("lets explicit denies override profile-allowed bundle MCP servers", () => {
    const filtered = filterBundleMcpConfigByToolPolicies({
      config: {
        mcpServers: {
          "twenty-crm": { type: "sse", url: "https://crm.example.com/mcp" },
          calendar: { type: "sse", url: "https://calendar.example.com/mcp" },
        },
      },
      policies: [{ allow: ["bundle-mcp"] }, { deny: ["mcp__twenty-crm"] }],
    });

    expect(Object.keys(filtered.mcpServers)).toEqual(["calendar"]);
  });
});
