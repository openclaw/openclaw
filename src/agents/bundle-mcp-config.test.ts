import { describe, expect, it } from "vitest";
import { mergedBundleMcpLayerWantsCallerContextInjection } from "./bundle-mcp-config.js";

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
});
