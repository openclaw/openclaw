import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createBundleMcpToolRuntime,
  materializeBundleMcpToolsForRun,
} from "./pi-bundle-mcp-materialize.js";
import {
  cleanupBundleMcpHarness,
  makeTempDir,
  startSseProbeServer,
  writeBundleProbeMcpServer,
} from "./pi-bundle-mcp-test-harness.js";
import type { McpCatalogTool } from "./pi-bundle-mcp-types.js";
import type { SessionMcpRuntime } from "./pi-bundle-mcp-types.js";

afterEach(async () => {
  await cleanupBundleMcpHarness();
});

function makeToolRuntime(tools?: McpCatalogTool[]): SessionMcpRuntime {
  return {
    sessionId: "session-collision",
    workspaceDir: "/tmp",
    configFingerprint: "fingerprint",
    createdAt: 0,
    lastUsedAt: 0,
    markUsed: () => {},
    getCatalog: async () => ({
      version: 1,
      generatedAt: 0,
      servers: {
        bundleProbe: {
          serverName: "bundleProbe",
          launchSummary: "bundleProbe",
          toolCount: 1,
        },
      },
      tools: tools ?? [
        {
          serverName: "bundleProbe",
          safeServerName: "bundleProbe",
          toolName: "bundle_probe",
          description: "Bundle probe",
          inputSchema: { type: "object", properties: {} },
          fallbackDescription: "Bundle probe",
        },
      ],
    }),
    callTool: async () => ({
      content: [{ type: "text", text: "FROM-BUNDLE" }],
      isError: false,
    }),
    dispose: async () => {},
  };
}

describe("createBundleMcpToolRuntime", () => {
  it("materializes bundle MCP tools and executes them", async () => {
    const runtime = await materializeBundleMcpToolsForRun({
      runtime: makeToolRuntime(),
    });

    expect(runtime.tools.map((tool) => tool.name)).toEqual(["bundleProbe__bundle_probe"]);
    const result = await runtime.tools[0].execute("call-bundle-probe", {}, undefined, undefined);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: "FROM-BUNDLE",
    });
    expect(result.details).toEqual({
      mcpServer: "bundleProbe",
      mcpTool: "bundle_probe",
    });
  });

  it("disambiguates bundle MCP tools that collide with existing tool names", async () => {
    const runtime = await materializeBundleMcpToolsForRun({
      runtime: makeToolRuntime(),
      reservedToolNames: ["bundleProbe__bundle_probe"],
    });

    expect(runtime.tools.map((tool) => tool.name)).toEqual(["bundleProbe__bundle_probe-2"]);
  });

  it("loads configured stdio MCP tools without a bundle", async () => {
    const workspaceDir = await makeTempDir("openclaw-bundle-mcp-tools-");
    const serverScriptPath = path.join(workspaceDir, "servers", "configured-probe.mjs");
    await writeBundleProbeMcpServer(serverScriptPath);

    const runtime = await createBundleMcpToolRuntime({
      workspaceDir,
      cfg: {
        mcp: {
          servers: {
            configuredProbe: {
              command: "node",
              args: [serverScriptPath],
              env: {
                BUNDLE_PROBE_TEXT: "FROM-CONFIG",
              },
            },
          },
        },
      },
    });

    try {
      expect(runtime.tools.map((tool) => tool.name)).toEqual(["configuredProbe__bundle_probe"]);
      const result = await runtime.tools[0].execute(
        "call-configured-probe",
        {},
        undefined,
        undefined,
      );
      expect(result.content[0]).toMatchObject({
        type: "text",
        text: "FROM-CONFIG",
      });
      expect(result.details).toEqual({
        mcpServer: "configuredProbe",
        mcpTool: "bundle_probe",
      });
    } finally {
      await runtime.dispose();
    }
  });

  it("loads configured SSE MCP tools via url", async () => {
    vi.useRealTimers();
    const sseServer = await startSseProbeServer();

    try {
      const workspaceDir = await makeTempDir("openclaw-bundle-mcp-sse-");
      const runtime = await createBundleMcpToolRuntime({
        workspaceDir,
        cfg: {
          mcp: {
            servers: {
              sseProbe: {
                url: `http://127.0.0.1:${sseServer.port}/sse`,
                transport: "sse",
              },
            },
          },
        },
      });

      try {
        expect(runtime.tools.map((tool) => tool.name)).toEqual(["sseProbe__sse_probe"]);
        const result = await runtime.tools[0].execute("call-sse-probe", {}, undefined, undefined);
        expect(result.content[0]).toMatchObject({
          type: "text",
          text: "FROM-SSE",
        });
        expect(result.details).toEqual({
          mcpServer: "sseProbe",
          mcpTool: "sse_probe",
        });
      } finally {
        await runtime.dispose();
      }
    } finally {
      await sseServer.close();
    }
  });

  it("returns tools sorted alphabetically for stable prompt-cache keys", async () => {
    const runtime = await materializeBundleMcpToolsForRun({
      runtime: makeToolRuntime([
        {
          serverName: "multi",
          safeServerName: "multi",
          toolName: "zeta",
          description: "z",
          inputSchema: { type: "object", properties: {} },
          fallbackDescription: "z",
        },
        {
          serverName: "multi",
          safeServerName: "multi",
          toolName: "alpha",
          description: "a",
          inputSchema: { type: "object", properties: {} },
          fallbackDescription: "a",
        },
        {
          serverName: "multi",
          safeServerName: "multi",
          toolName: "mu",
          description: "m",
          inputSchema: { type: "object", properties: {} },
          fallbackDescription: "m",
        },
      ]),
    });

    expect(runtime.tools.map((tool) => tool.name)).toEqual([
      "multi__alpha",
      "multi__mu",
      "multi__zeta",
    ]);
  });
});
