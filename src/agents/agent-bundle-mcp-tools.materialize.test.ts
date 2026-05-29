import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { validateToolArguments } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { getPluginToolMeta } from "../plugins/tools.js";
import {
  createBundleMcpToolRuntime,
  materializeBundleMcpToolsForRun,
} from "./agent-bundle-mcp-materialize.js";
import type { McpCatalogTool } from "./agent-bundle-mcp-types.js";
import type { McpToolCatalogDiagnostic } from "./agent-bundle-mcp-types.js";
import type { SessionMcpRuntime } from "./agent-bundle-mcp-types.js";

function expectTextContentBlock(block: unknown, text: string) {
  const content = block as { type?: string; text?: string } | undefined;
  expect(content?.type).toBe("text");
  expect(content?.text).toBe(text);
}

function makeToolRuntime(
  params: {
    tools?: McpCatalogTool[];
    serverName?: string;
    result?: CallToolResult;
    resultText?: string;
    diagnostics?: readonly McpToolCatalogDiagnostic[];
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
      ...(params.diagnostics ? { diagnostics: params.diagnostics } : {}),
    }),
    peekCatalog: () => ({
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
      ...(params.diagnostics ? { diagnostics: params.diagnostics } : {}),
    }),
    callTool: async () =>
      params.result ?? {
        content: [{ type: "text", text: params.resultText ?? "FROM-BUNDLE" }],
        isError: false,
      },
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
    expectTextContentBlock(result.content[0], "FROM-BUNDLE");
    expect(result.details).toEqual({
      mcpServer: "bundleProbe",
      mcpTool: "bundle_probe",
    });
  });

  it("keeps structuredContent visible when MCP tools also return text content", async () => {
    const runtime = await materializeBundleMcpToolsForRun({
      runtime: makeToolRuntime({
        result: {
          content: [{ type: "text", text: "pong" }],
          structuredContent: {
            threadId: "019e6cdb-8e7f-7cb2-891f-9edb689f6fc7",
            content: "pong",
          },
          isError: false,
        },
      }),
    });

    const result = await runtime.tools[0].execute("call-bundle-probe", {}, undefined, undefined);

    expectTextContentBlock(
      result.content[0],
      `structuredContent:\n${JSON.stringify(
        {
          threadId: "019e6cdb-8e7f-7cb2-891f-9edb689f6fc7",
          content: "pong",
        },
        null,
        2,
      )}`,
    );
    expect(result.content).toHaveLength(1);
    expect(result.details).toEqual({
      mcpServer: "bundleProbe",
      mcpTool: "bundle_probe",
      structuredContent: {
        threadId: "019e6cdb-8e7f-7cb2-891f-9edb689f6fc7",
        content: "pong",
      },
    });
  });

  it("disambiguates bundle MCP tools that collide with existing tool names", async () => {
    const runtime = await materializeBundleMcpToolsForRun({
      runtime: makeToolRuntime(),
      reservedToolNames: ["bundleProbe__bundle_probe"],
    });

    expect(runtime.tools.map((tool) => tool.name)).toEqual(["bundleProbe__bundle_probe-2"]);
  });

  it("preserves catalog diagnostics when MCP servers fail tool listing", async () => {
    const diagnostics = [
      {
        serverName: "fuzzplugin",
        safeServerName: "fuzzplugin",
        launchSummary: "node fuzzplugin-mcp.mjs",
        message: 'tools[0].inputSchema.type expected "object"',
      },
    ];

    const runtime = await materializeBundleMcpToolsForRun({
      runtime: makeToolRuntime({ tools: [], diagnostics }),
    });

    expect(runtime.tools).toEqual([]);
    expect(runtime.diagnostics).toEqual(diagnostics);
  });

  it("skips unreadable catalog tool fields while preserving healthy siblings", async () => {
    const inputSchema = { type: "object", properties: {} };
    const calls: Array<{ serverName: string; toolName: string }> = [];
    const unreadableName = Object.defineProperties(
      {},
      {
        serverName: { value: "fuzzplugin" },
        safeServerName: { value: "fuzzplugin" },
        toolName: {
          get() {
            throw new Error("mockplugin catalog name failed");
          },
        },
        inputSchema: { value: inputSchema },
        fallbackDescription: { value: "bad name" },
      },
    );
    const unreadableSchema = Object.defineProperties(
      {},
      {
        serverName: { value: "fuzzplugin" },
        safeServerName: { value: "fuzzplugin" },
        toolName: { value: "mockplugin_schema" },
        inputSchema: {
          get() {
            throw new Error("mockplugin catalog schema failed");
          },
        },
        fallbackDescription: { value: "bad schema" },
      },
    );
    const healthyTool = Object.defineProperties(
      {},
      {
        serverName: { value: " fuzzplugin " },
        safeServerName: { value: "fuzzplugin" },
        toolName: { value: "mockplugin_status" },
        title: { value: "Status" },
        description: {
          get() {
            throw new Error("mockplugin catalog description failed");
          },
        },
        inputSchema: { value: inputSchema },
        fallbackDescription: { value: "fallback status" },
      },
    );

    const runtime = await materializeBundleMcpToolsForRun({
      runtime: {
        ...makeToolRuntime({
          serverName: "fuzzplugin",
          tools: [unreadableName, unreadableSchema, healthyTool] as never,
        }),
        callTool: async (serverName, toolName) => {
          calls.push({ serverName, toolName });
          return {
            content: [{ type: "text", text: "FROM-CATALOG" }],
            isError: false,
          };
        },
      },
    });

    expect(runtime.tools.map((tool) => tool.name)).toEqual(["fuzzplugin__mockplugin_status"]);
    expect(runtime.tools[0]?.label).toBe("Status");
    expect(runtime.tools[0]?.description).toBe("fallback status");
    await runtime.tools[0]?.execute("call-catalog", {}, undefined, undefined);
    expect(calls).toEqual([{ serverName: " fuzzplugin ", toolName: "mockplugin_status" }]);
    expect(runtime.diagnostics?.map((diagnostic) => diagnostic.message)).toEqual([
      "tools[0].toolName is unreadable: Error: mockplugin catalog name failed",
      "tools[1].inputSchema is unreadable: Error: mockplugin catalog schema failed",
      "tools[2].description is unreadable: Error: mockplugin catalog description failed",
    ]);
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
    expect(created[0].cfg?.mcp?.servers?.configuredProbe?.command).toBe("node");
    expect(created[0].cfg?.mcp?.servers?.configuredProbe?.args).toEqual(["configured-probe.mjs"]);

    expect(runtime.tools.map((tool) => tool.name)).toEqual(["configuredProbe__bundle_probe"]);
    const result = await runtime.tools[0].execute(
      "call-configured-probe",
      {},
      undefined,
      undefined,
    );
    expectTextContentBlock(result.content[0], "FROM-CONFIG");
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
