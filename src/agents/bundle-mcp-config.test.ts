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

  it("merges a stdio mcp.servers.rockie entry into the bundle catalog (fleet-task #24 BYOK wiring)", () => {
    // Exercises the exact shape that overlay/multitenant/entrypoint.sh
    // writes into ~/.openclaw/openclaw.json on a BYOK tenant: a
    // single stdio MCP server named `rockie` pointing at the same
    // mcp-rockie binary that subscription paths register, with the
    // ROCKIELAB_* env triple mcp-rockie needs to authenticate against
    // platform-context. If OpenClaw upstream renames `mcp.servers`,
    // this assertion catches it before BYOK tenants silently lose
    // their tools.
    const merged = loadMergedBundleMcpConfig({
      workspaceDir: "/workspace",
      cfg: {
        mcp: {
          servers: {
            rockie: {
              command: "node",
              args: ["/home/runtime/mcp-rockie/server.js"],
              env: {
                ROCKIELAB_API_BASE: "https://api.dev.rockielab.com",
                ROCKIELAB_TENANT_DEV_TOKEN: "t-95a34ff7c78c",
                ROCKIELAB_API_PASSWORD: "",
              },
            },
          },
        },
      },
    });

    expect(merged.config.mcpServers.rockie).toEqual({
      command: "node",
      args: ["/home/runtime/mcp-rockie/server.js"],
      env: {
        ROCKIELAB_API_BASE: "https://api.dev.rockielab.com",
        ROCKIELAB_TENANT_DEV_TOKEN: "t-95a34ff7c78c",
        ROCKIELAB_API_PASSWORD: "",
      },
    });
    // Bundle defaults remain present alongside the configured server —
    // configured servers extend, they don't replace.
    expect(merged.config.mcpServers.bundleProbe).toBeDefined();
  });

  // --- Edge-case coverage (fleet-task #24 Tester run) ------------------
  // The implementer's 3-test set proves the happy path of the
  // BYOK mcp.servers.rockie merge but does not pin the boundaries
  // that a non-BYOK tenant (or a misconfigured tenant) would hit.
  // These four cases lock down: missing mcp key, empty servers map,
  // multi-server preservation, and a malformed-server smoke check.
  it("falls back to bundle defaults when cfg.mcp is entirely missing (BYOK fallback path)", () => {
    // Subscription tenants and freshly provisioned BYOK tenants both
    // start with no `mcp` block. The new merge logic must not crash
    // and must leave bundle defaults intact untouched.
    const merged = loadMergedBundleMcpConfig({
      workspaceDir: "/workspace",
      cfg: {},
    });

    expect(merged.config.mcpServers).toEqual({
      bundleProbe: {
        command: "node",
        args: ["./servers/probe.mjs"],
      },
    });
    expect(merged.diagnostics).toEqual([]);
  });

  it("treats empty cfg.mcp.servers {} like missing — bundle defaults survive untouched", () => {
    // A tenant who pasted an empty `{ "mcp": { "servers": {} } }`
    // (e.g. a wizard step that wrote the key but no entries) must
    // produce the same shape as the missing-key case above.
    const merged = loadMergedBundleMcpConfig({
      workspaceDir: "/workspace",
      cfg: {
        mcp: {
          servers: {},
        },
      },
    });

    expect(merged.config.mcpServers).toEqual({
      bundleProbe: {
        command: "node",
        args: ["./servers/probe.mjs"],
      },
    });
  });

  it("preserves pre-existing cfg.mcp.servers.other when adding rockie (multi-server merge)", () => {
    // Owners may configure their own stdio MCP alongside the BYOK
    // `rockie` server. If the merge clobbered sibling entries the
    // owner-visible plugin catalog would silently regress.
    const merged = loadMergedBundleMcpConfig({
      workspaceDir: "/workspace",
      cfg: {
        mcp: {
          servers: {
            other: {
              command: "python",
              args: ["-m", "owner_mcp"],
              env: { OWNER_TOKEN: "abc" },
            },
            rockie: {
              command: "node",
              args: ["/home/runtime/mcp-rockie/server.js"],
              env: {
                ROCKIELAB_API_BASE: "https://api.dev.rockielab.com",
                ROCKIELAB_TENANT_DEV_TOKEN: "t-multi",
                ROCKIELAB_API_PASSWORD: "",
              },
            },
          },
        },
      },
    });

    expect(merged.config.mcpServers.other).toEqual({
      command: "python",
      args: ["-m", "owner_mcp"],
      env: { OWNER_TOKEN: "abc" },
    });
    expect(merged.config.mcpServers.rockie).toMatchObject({
      command: "node",
      args: ["/home/runtime/mcp-rockie/server.js"],
    });
    // Bundle default still present alongside both configured servers.
    expect(merged.config.mcpServers.bundleProbe).toBeDefined();
    expect(Object.keys(merged.config.mcpServers).toSorted()).toEqual([
      "bundleProbe",
      "other",
      "rockie",
    ]);
  });

  it("does not crash when a configured server is missing the command field (graceful pass-through)", () => {
    // Malformed entries (no `command`, no `url`) should not blow up
    // the gateway boot path. Downstream CLI adapters validate the
    // shape; the merge step's job is just to plumb it through.
    const merged = loadMergedBundleMcpConfig({
      workspaceDir: "/workspace",
      cfg: {
        mcp: {
          servers: {
            broken: {
              args: ["--no-command"],
              env: { FOO: "bar" },
            },
          },
        },
      },
    });

    // Entry is preserved as-is (no `command` synthesized) so a
    // downstream validator can produce the actionable error rather
    // than the merge step silently dropping the row.
    expect(merged.config.mcpServers.broken).toEqual({
      args: ["--no-command"],
      env: { FOO: "bar" },
    });
    expect(merged.config.mcpServers.bundleProbe).toBeDefined();
  });
});
