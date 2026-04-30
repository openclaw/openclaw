/** Tests merging bundled MCP defaults with OpenClaw user MCP configuration. */
import { describe, expect, it } from "vitest";
import {
  loadMergedBundleMcpConfig,
  mergedBundleMcpLayerWantsCallerContextInjection,
} from "./bundle-mcp-config.js";

describe("mergedBundleMcpLayerWantsCallerContextInjection", () => {
  it("is true when OpenClaw mcp.servers opts in", () => {
    expect(
      mergedBundleMcpLayerWantsCallerContextInjection({
        workspaceDir: "/tmp/openclaw-bundle-mcp-caller-probe-nonexistent",
        cfg: {
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
        },
      }),
    ).toBe(true);
  });

  it("is false when no server sets injectCallerContext true", () => {
    expect(
      mergedBundleMcpLayerWantsCallerContextInjection({
        workspaceDir: "/tmp/openclaw-bundle-mcp-caller-probe-nonexistent",
        cfg: {
          plugins: { enabled: false },
          mcp: {
            servers: {
              remote: {
                type: "sse",
                url: "https://example.com/mcp",
              },
            },
          },
        },
      }),
    ).toBe(false);
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
