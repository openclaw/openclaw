/** Tests live session MCP projections and launch config isolation. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { loadSessionMcpConfig } from "./agent-bundle-mcp-runtime-config.js";

const mocks = vi.hoisted(() => ({
  diagnostics: [] as Array<{ pluginId: string; message: string }>,
  prepareDataDirsByServer: {} as Record<string, { pluginId: string; dataDir: string }>,
}));

vi.mock("./embedded-agent-mcp.js", () => ({
  loadEmbeddedAgentMcpConfig: (params: {
    cfg?: { mcp?: { servers?: Record<string, unknown> } };
    toolOverrides?: { mcpServers?: Record<string, boolean> };
  }) => {
    const servers = Object.fromEntries(
      Object.entries(params.cfg?.mcp?.servers ?? {}).filter(
        ([name]) => params.toolOverrides?.mcpServers?.[name] !== false,
      ),
    );
    return {
      diagnostics: structuredClone(mocks.diagnostics),
      mcpServers: servers,
      prepareDataDirsByServer: structuredClone(mocks.prepareDataDirsByServer),
    };
  },
}));

afterEach(() => {
  mocks.diagnostics = [];
  mocks.prepareDataDirsByServer = {};
  clearPluginMetadataLifecycleCaches();
});

describe("session MCP config projection", () => {
  it("filters denied servers without renaming colliding survivors across config reloads", () => {
    const cfg = {
      mcp: { servers: { "alpha?": { command: "first" }, "alpha!": { command: "second" } } },
    };
    const params = { workspaceDir: "/policy-workspace", toolDenylist: ["alpha-__*"] };
    const filtered = loadSessionMcpConfig({ ...params, cfg });
    expect(Object.keys(filtered.loaded.mcpServers)).toEqual(["alpha!"]);
    expect([...filtered.safeServerNamesByServer]).toEqual([
      ["alpha?", "alpha-"],
      ["alpha!", "alpha--2"],
    ]);

    const reloaded = loadSessionMcpConfig({
      ...params,
      cfg: {
        mcp: {
          servers: { ...cfg.mcp.servers, "alpha@": { command: "third" } },
        },
      },
    });
    expect(Object.keys(reloaded.loaded.mcpServers)).toEqual(["alpha!", "alpha@"]);
    expect([...reloaded.safeServerNamesByServer]).toEqual([
      ["alpha?", "alpha-"],
      ["alpha!", "alpha--2"],
      ["alpha@", "alpha--3"],
    ]);
  });

  it("keeps Agent Plugins launch ownership out of fingerprints and filtered partitions", () => {
    const cfg = {
      mcp: { servers: { alpha: { command: "alpha" }, beta: { command: "beta" } } },
    };
    mocks.prepareDataDirsByServer = {
      alpha: { pluginId: "agent-plugin", dataDir: "/state/one" },
      beta: { pluginId: "agent-plugin", dataDir: "/state/two" },
    };
    const first = loadSessionMcpConfig({ workspaceDir: "/ownership-workspace", cfg });
    const filtered = loadSessionMcpConfig({
      workspaceDir: "/ownership-workspace",
      cfg,
      includeServerNames: new Set(["alpha"]),
    });

    expect(first.loaded.prepareDataDirsByServer).toEqual({
      alpha: { pluginId: "agent-plugin", dataDir: "/state/one" },
      beta: { pluginId: "agent-plugin", dataDir: "/state/two" },
    });
    expect(filtered.loaded.prepareDataDirsByServer).toEqual({
      alpha: { pluginId: "agent-plugin", dataDir: "/state/one" },
    });
    clearPluginMetadataLifecycleCaches();
    mocks.prepareDataDirsByServer = {
      alpha: { pluginId: "agent-plugin", dataDir: "/different/state" },
    };
    const changedOwnership = loadSessionMcpConfig({ workspaceDir: "/ownership-workspace", cfg });
    expect(changedOwnership.fingerprint).toBe(first.fingerprint);
  });
});
