/** Tests merging bundled MCP defaults with OpenClaw user MCP configuration. */
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSessionAgentIds } from "./agent-scope.js";
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

  it("keeps servers with no agents allowlist visible to every agent", () => {
    const merged = loadMergedBundleMcpConfig({
      workspaceDir: "/workspace",
      agentId: "max",
      cfg: {
        mcp: {
          servers: {
            finance: { command: "node", args: ["finance.mjs"] },
          },
        },
      },
    });

    expect(merged.config.mcpServers).toHaveProperty("finance");
  });

  it("includes an agent-scoped server for a listed agent and strips the agents metadata", () => {
    const merged = loadMergedBundleMcpConfig({
      workspaceDir: "/workspace",
      agentId: "migdalia",
      cfg: {
        mcp: {
          servers: {
            finance: { command: "node", args: ["finance.mjs"], agents: ["migdalia"] },
          },
        },
      },
    });

    expect(merged.config.mcpServers).toHaveProperty("finance");
    // `agents` is an OpenClaw-side scoping control; it must not reach the launched server.
    expect(merged.config.mcpServers.finance).not.toHaveProperty("agents");
  });

  it("excludes an agent-scoped server for a non-listed agent", () => {
    const merged = loadMergedBundleMcpConfig({
      workspaceDir: "/workspace",
      agentId: "max",
      cfg: {
        mcp: {
          servers: {
            finance: { command: "node", args: ["finance.mjs"], agents: ["migdalia"] },
          },
        },
      },
    });

    expect(merged.config.mcpServers).not.toHaveProperty("finance");
  });

  it("fails closed when an agent-scoped server runs without an agent id", () => {
    const merged = loadMergedBundleMcpConfig({
      workspaceDir: "/workspace",
      cfg: {
        mcp: {
          servers: {
            finance: { command: "node", args: ["finance.mjs"], agents: ["migdalia"] },
          },
        },
      },
    });

    expect(merged.config.mcpServers).not.toHaveProperty("finance");
  });

  it("fails closed when the agents allowlist is empty", () => {
    const merged = loadMergedBundleMcpConfig({
      workspaceDir: "/workspace",
      agentId: "migdalia",
      cfg: {
        mcp: {
          servers: {
            finance: { command: "node", args: ["finance.mjs"], agents: [] },
          },
        },
      },
    });

    expect(merged.config.mcpServers).not.toHaveProperty("finance");
  });

  it("scopes via the session-key-resolved agent when no explicit agentId is set", () => {
    // Regression: the embedded/CLI runner resolves the active agent from the
    // session key (sessionAgentId), NOT the raw optional params.agentId. The
    // merge must receive that resolved id, or a session-keyed run with no
    // explicit agentId fails closed and the scoped server silently vanishes.
    const cfg = {
      agents: { list: [{ id: "migdalia" }, { id: "max", default: true }] },
      mcp: {
        servers: {
          finance: { command: "node", args: ["finance.mjs"], agents: ["migdalia"] },
        },
      },
    } as OpenClawConfig;

    // No explicit agentId; the agent is encoded only in the session key.
    const { sessionAgentId } = resolveSessionAgentIds({
      sessionKey: "agent:migdalia:main",
      config: cfg,
      agentId: undefined,
    });
    expect(sessionAgentId).toBe("migdalia");

    const merged = loadMergedBundleMcpConfig({
      workspaceDir: "/workspace",
      agentId: sessionAgentId,
      cfg,
    });
    expect(merged.config.mcpServers).toHaveProperty("finance");

    // And a different session-keyed agent (max) correctly does NOT receive it.
    const maxResolved = resolveSessionAgentIds({
      sessionKey: "agent:max:main",
      config: cfg,
      agentId: undefined,
    });
    const maxMerged = loadMergedBundleMcpConfig({
      workspaceDir: "/workspace",
      agentId: maxResolved.sessionAgentId,
      cfg,
    });
    expect(maxMerged.config.mcpServers).not.toHaveProperty("finance");
  });
});
