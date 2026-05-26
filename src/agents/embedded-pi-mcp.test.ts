import { beforeEach, describe, expect, it, vi } from "vitest";

const loadMergedBundleMcpConfigMock = vi.fn();
const resolvePluginMcpServersMock = vi.fn();

vi.mock("./bundle-mcp-config.js", () => ({
  loadMergedBundleMcpConfig: (params: unknown) => loadMergedBundleMcpConfigMock(params),
}));

vi.mock("../plugins/mcp-servers.js", () => ({
  resolvePluginMcpServers: (params: unknown) => resolvePluginMcpServersMock(params),
}));

let loadEmbeddedPiMcpConfig: typeof import("./embedded-pi-mcp.js").loadEmbeddedPiMcpConfig;

describe("loadEmbeddedPiMcpConfig", () => {
  beforeEach(async () => {
    vi.resetModules();
    loadMergedBundleMcpConfigMock.mockReset();
    resolvePluginMcpServersMock.mockReset();
    ({ loadEmbeddedPiMcpConfig } = await import("./embedded-pi-mcp.js"));
  });

  it("passes plugin MCP servers into the bundle MCP merge layer and combines diagnostics", () => {
    resolvePluginMcpServersMock.mockReturnValue({
      mcpServers: {
        pluginOnly: { url: "https://plugin-only.example/mcp" },
      },
      diagnostics: [{ pluginId: "plugin", message: "plugin diagnostic" }],
    });
    loadMergedBundleMcpConfigMock.mockReturnValue({
      config: {
        mcpServers: {
          shared: { url: "https://configured.example/mcp" },
          pluginOnly: { url: "https://plugin-only.example/mcp" },
        },
      },
      diagnostics: [{ pluginId: "bundle", message: "bundle diagnostic" }],
    });

    const cfg = {
      mcp: {
        servers: {
          shared: { url: "https://configured.example/mcp" },
        },
      },
    };

    const result = loadEmbeddedPiMcpConfig({
      workspaceDir: "/workspace",
      cfg,
    });

    expect(resolvePluginMcpServersMock).toHaveBeenCalledWith({
      workspaceDir: "/workspace",
      config: cfg,
    });
    expect(loadMergedBundleMcpConfigMock).toHaveBeenCalledWith({
      workspaceDir: "/workspace",
      cfg,
      extraMcpServers: {
        pluginOnly: { url: "https://plugin-only.example/mcp" },
      },
    });
    expect(result).toEqual({
      mcpServers: {
        shared: { url: "https://configured.example/mcp" },
        pluginOnly: { url: "https://plugin-only.example/mcp" },
      },
      diagnostics: [
        { pluginId: "bundle", message: "bundle diagnostic" },
        { pluginId: "plugin", message: "plugin diagnostic" },
      ],
    });
  });
});
