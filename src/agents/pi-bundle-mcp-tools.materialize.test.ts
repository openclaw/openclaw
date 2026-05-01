import { describe, expect, it } from "vitest";
import { getPluginToolMeta } from "../plugins/tools.js";
import {
  createBundleMcpToolRuntime,
  materializeBundleMcpToolsForRun,
} from "./pi-bundle-mcp-materialize.js";
import type { McpCatalogTool } from "./pi-bundle-mcp-types.js";
import type { SessionMcpRuntime } from "./pi-bundle-mcp-types.js";

function makeToolRuntime(
  params: {
    tools?: McpCatalogTool[];
    serverName?: string;
    resultText?: string;
    resultContent?: unknown[];
    resultIsError?: boolean;
  } = {},
): SessionMcpRuntime {
  const serverName = params.serverName ?? "bundleProbe";
  const tools = params.tools ?? [
    {
      serverName,
      safeServerName: serverName,
      toolName: "bundle_probe",
      description: "Bundle probe",
      inputSchema: { type: "object", properties: {} },
      fallbackDescription: "Bundle probe",
    },
  ];
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
        [serverName]: {
          serverName,
          launchSummary: serverName,
          toolCount: tools.length,
        },
      },
      tools,
    }),
    callTool: async () =>
      ({
        content: params.resultContent ?? [
          { type: "text", text: params.resultText ?? "FROM-BUNDLE" },
        ],
        isError: params.resultIsError ?? false,
      }) as never,
    dispose: async () => {},
  };
}

describe("createBundleMcpToolRuntime", () => {
  it("materializes bundle MCP tools and executes them", async () => {
    const runtime = await materializeBundleMcpToolsForRun({
      runtime: makeToolRuntime(),
    });

    expect(runtime.tools.map((tool) => tool.name)).toEqual(["bundleProbe__bundle_probe"]);
    expect(getPluginToolMeta(runtime.tools[0])?.pluginId).toBe("bundle-mcp");
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

  it("materializes configured MCP tools through the session runtime boundary", async () => {
    const created: Parameters<
      NonNullable<Parameters<typeof createBundleMcpToolRuntime>[0]["createRuntime"]>
    >[0][] = [];
    const runtime = await createBundleMcpToolRuntime({
      workspaceDir: "/workspace",
      cfg: {
        mcp: {
          servers: {
            configuredProbe: {
              command: "node",
              args: ["configured-probe.mjs"],
              env: {
                BUNDLE_PROBE_TEXT: "FROM-CONFIG",
              },
            },
          },
        },
      },
      createRuntime: (params) => {
        created.push(params);
        return makeToolRuntime({
          serverName: "configuredProbe",
          resultText: "FROM-CONFIG",
        });
      },
    });

    expect(created).toHaveLength(1);
    expect(created[0].sessionId).toMatch(/^bundle-mcp:/);
    expect(created[0].workspaceDir).toBe("/workspace");
    expect(created[0].cfg?.mcp?.servers?.configuredProbe).toMatchObject({
      command: "node",
      args: ["configured-probe.mjs"],
    });

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
  });

  it("returns tools sorted alphabetically for stable prompt-cache keys", async () => {
    const runtime = await materializeBundleMcpToolsForRun({
      runtime: makeToolRuntime({
        tools: [
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
        ],
      }),
    });

    expect(runtime.tools.map((tool) => tool.name)).toEqual([
      "multi__alpha",
      "multi__mu",
      "multi__zeta",
    ]);
  });

  it("normalizes MCP `resource` content with text into a text block (#75674)", async () => {
    const runtime = await materializeBundleMcpToolsForRun({
      runtime: makeToolRuntime({
        resultContent: [
          {
            type: "resource",
            resource: {
              uri: "qmd://memory-root-main/memory/2026-05-01.md",
              mimeType: "text/markdown",
              text: "# 2026-05-01\n\nMemory entry markdown body",
            },
          },
        ],
      }),
    });
    const result = await runtime.tools[0].execute("call-resource-text", {}, undefined, undefined);
    expect(result.content).toEqual([
      { type: "text", text: "# 2026-05-01\n\nMemory entry markdown body" },
    ]);
  });

  it("renders binary MCP `resource` content as an informative text marker", async () => {
    const runtime = await materializeBundleMcpToolsForRun({
      runtime: makeToolRuntime({
        resultContent: [
          {
            type: "resource",
            resource: {
              uri: "file:///tmp/snapshot.bin",
              mimeType: "application/octet-stream",
              blob: "AAECAwQ=",
            },
          },
        ],
      }),
    });
    const result = await runtime.tools[0].execute("call-resource-blob", {}, undefined, undefined);
    expect(result.content).toEqual([
      {
        type: "text",
        text: "[Resource: file:///tmp/snapshot.bin (application/octet-stream)]",
      },
    ]);
  });

  it("passes existing text and image content blocks through unchanged", async () => {
    const runtime = await materializeBundleMcpToolsForRun({
      runtime: makeToolRuntime({
        resultContent: [
          { type: "text", text: "plain text" },
          {
            type: "image",
            data: "AAEC",
            mimeType: "image/png",
          },
        ],
      }),
    });
    const result = await runtime.tools[0].execute("call-mixed", {}, undefined, undefined);
    expect(result.content).toEqual([
      { type: "text", text: "plain text" },
      { type: "image", data: "AAEC", mimeType: "image/png" },
    ]);
  });
});
