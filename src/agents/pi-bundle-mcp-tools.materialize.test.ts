import { validateToolArguments } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { logWarn } from "../logger.js";
import { getPluginToolMeta } from "../plugins/tools.js";

vi.mock("../logger.js", () => ({ logWarn: vi.fn() }));
import { materializeBundleMcpToolsForRun } from "./pi-bundle-mcp-materialize.js";
import type { McpCatalogTool } from "./pi-bundle-mcp-types.js";
import type { SessionMcpRuntime } from "./pi-bundle-mcp-types.js";

function expectTextContentBlock(block: unknown, text: string) {
  const content = block as { type?: string; text?: string } | undefined;
  expect(content?.type).toBe("text");
  expect(content?.text).toBe(text);
}

function makeToolRuntime(
  params: {
    tools?: McpCatalogTool[];
    serverName?: string;
    resultText?: string;
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
    getOmittedServers: () => [],
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
    callTool: async () => ({
      content: [{ type: "text", text: params.resultText ?? "FROM-BUNDLE" }],
      isError: false,
    }),
    dispose: async () => {},
  };
}

describe("materializeBundleMcpToolsForRun", () => {
  it("materializes bundle MCP tools and executes them", async () => {
    const runtime = await materializeBundleMcpToolsForRun({
      runtime: makeToolRuntime(),
    });

    expect(runtime.tools.map((tool) => tool.name)).toEqual(["bundleProbe__bundle_probe"]);
    expect(getPluginToolMeta(runtime.tools[0])?.pluginId).toBe("bundle-mcp");
    const result = await runtime.tools[0].execute("call-bundle-probe", {}, undefined, undefined);
    expectTextContentBlock(result.content[0], "FROM-BUNDLE");
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

  it("warns once per omitted server reason for a shared runtime", async () => {
    vi.mocked(logWarn).mockClear();
    const runtime = {
      ...makeToolRuntime(),
      getOmittedServers: () => [
        {
          serverName: "secretServer",
          safeServerName: "secretServer",
          launchSummary: "stdio: secret",
          reason: "list-tools-failed" as const,
          errorMessage: "failed https://example.com/path?token=[REDACTED]",
          failedAt: 123,
        },
      ],
    };

    await (await materializeBundleMcpToolsForRun({ runtime })).dispose();
    await (await materializeBundleMcpToolsForRun({ runtime })).dispose();

    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(logWarn).mock.calls[0]?.[0]).toContain("list-tools-failed");
    expect(vi.mocked(logWarn).mock.calls[0]?.[0]).toContain("[REDACTED]");
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

  it("normalizes local $ref schemas from MCP tools before exposing them", async () => {
    const runtime = await materializeBundleMcpToolsForRun({
      runtime: makeToolRuntime({
        tools: [
          {
            serverName: "notion",
            safeServerName: "notion",
            toolName: "API-post-page",
            description: "Create a page",
            inputSchema: {
              type: "object",
              required: ["parent"],
              properties: {
                parent: { $ref: "#/$defs/parentRequest" },
              },
              $defs: {
                parentRequest: {
                  oneOf: [
                    {
                      type: "object",
                      required: ["page_id"],
                      properties: { page_id: { type: "string" } },
                    },
                    {
                      type: "object",
                      required: ["database_id"],
                      properties: { database_id: { type: "string" } },
                    },
                  ],
                },
              },
            },
            fallbackDescription: "Create a page",
          },
        ],
      }),
    });

    expect(runtime.tools[0]?.parameters).toEqual({
      type: "object",
      required: ["parent"],
      properties: {
        parent: {
          oneOf: [
            {
              type: "object",
              required: ["page_id"],
              properties: { page_id: { type: "string" } },
            },
            {
              type: "object",
              required: ["database_id"],
              properties: { database_id: { type: "string" } },
            },
          ],
        },
      },
    });
    expect(
      validateToolArguments(runtime.tools[0], {
        type: "toolCall",
        id: "call-page",
        name: "notion__API-post-page",
        arguments: { parent: { page_id: "page-id" } },
      }),
    ).toEqual({ parent: { page_id: "page-id" } });
  });
});
