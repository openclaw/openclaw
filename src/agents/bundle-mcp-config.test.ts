/** Tests merging bundled MCP defaults with OpenClaw user MCP configuration. */
import { describe, expect, it, vi } from "vitest";
import type { loadEnabledBundleMcpConfig } from "../plugins/bundle-mcp.js";
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
    pluginIdsByServer: { bundleProbe: "bundle-probe" },
    prepareDataDirsByServer: {
      bundleProbe: { pluginId: "bundle-probe", dataDir: "/state/plugin-data/bundle-probe" },
    },
  } satisfies ReturnType<typeof loadEnabledBundleMcpConfig>,
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
    expect(merged.prepareDataDirsByServer).toStrictEqual({});
    expect(merged.pluginIdsByServer).toStrictEqual({});
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
      type: "http",
    });
    expect(toCliBundleMcpServerConfig({ type: " CuStOm ", transport: "custom" })).toEqual({
      type: " CuStOm ",
    });
  });

  it.each([
    {
      name: "includes a disabled server",
      override: true,
      enabled: false,
      expected: true,
    },
  ])("$name", ({ override, enabled, expected }) => {
    const merged = loadMergedBundleMcpConfig({
      workspaceDir: "/workspace",
      cfg: {
        mcp: {
          servers: {
            docs: { enabled, command: "node", args: ["docs.mjs"] },
          },
        },
      },
      ...(override === undefined ? {} : { toolOverrides: { mcpServers: { docs: override } } }),
    });

    expect(Object.hasOwn(merged.config.mcpServers, "docs")).toBe(expected);
  });
});
