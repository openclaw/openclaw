import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getPluginToolMeta } from "../plugins/tools.js";
import {
  createBundleMcpToolRuntime,
  getBundleMcpToolMaterializationCacheStatsForTest,
  materializeBundleMcpToolsForRun,
  resetBundleMcpToolMaterializationCacheForTest,
} from "./pi-bundle-mcp-materialize.js";
import type { McpCatalogTool } from "./pi-bundle-mcp-types.js";
import type { SessionMcpRuntime } from "./pi-bundle-mcp-types.js";

function makeToolRuntime(
  params: {
    onGetCatalog?: () => void;
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
    getCatalog: async () => {
      params.onGetCatalog?.();
      return {
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
      };
    },
    callTool: async () => ({
      content: [{ type: "text", text: params.resultText ?? "FROM-BUNDLE" }],
      isError: false,
    }),
    dispose: async () => {},
  };
}

const previousBundleMcpToolCacheEnv = process.env.OPENCLAW_BUNDLE_MCP_TOOL_CACHE;

beforeEach(() => {
  delete process.env.OPENCLAW_BUNDLE_MCP_TOOL_CACHE;
});

afterEach(() => {
  if (previousBundleMcpToolCacheEnv === undefined) {
    delete process.env.OPENCLAW_BUNDLE_MCP_TOOL_CACHE;
  } else {
    process.env.OPENCLAW_BUNDLE_MCP_TOOL_CACHE = previousBundleMcpToolCacheEnv;
  }
  resetBundleMcpToolMaterializationCacheForTest();
});

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

  it("reuses cached descriptors while creating fresh proxy tools per materialization", async () => {
    let getCatalogCalls = 0;
    const runtime = makeToolRuntime({
      onGetCatalog: () => {
        getCatalogCalls += 1;
      },
    });

    const first = await materializeBundleMcpToolsForRun({ runtime });
    const second = await materializeBundleMcpToolsForRun({ runtime });

    expect(first.tools.map((tool) => tool.name)).toEqual(["bundleProbe__bundle_probe"]);
    expect(second.tools.map((tool) => tool.name)).toEqual(["bundleProbe__bundle_probe"]);
    expect(first.tools[0]).not.toBe(second.tools[0]);
    expect(getCatalogCalls).toBe(1);
    expect(getPluginToolMeta(second.tools[0])?.pluginId).toBe("bundle-mcp");
    expect(getBundleMcpToolMaterializationCacheStatsForTest()).toEqual({
      bypass: 0,
      hit: 1,
      miss: 1,
      store: 1,
    });
  });

  it("keeps reserved tool-name sets in separate materialization cache entries", async () => {
    const runtime = makeToolRuntime();

    const first = await materializeBundleMcpToolsForRun({ runtime });
    const second = await materializeBundleMcpToolsForRun({
      runtime,
      reservedToolNames: ["bundleProbe__bundle_probe"],
    });
    const third = await materializeBundleMcpToolsForRun({
      runtime,
      reservedToolNames: ["bundleProbe__bundle_probe"],
    });

    expect(first.tools.map((tool) => tool.name)).toEqual(["bundleProbe__bundle_probe"]);
    expect(second.tools.map((tool) => tool.name)).toEqual(["bundleProbe__bundle_probe-2"]);
    expect(third.tools.map((tool) => tool.name)).toEqual(["bundleProbe__bundle_probe-2"]);
    expect(getBundleMcpToolMaterializationCacheStatsForTest()).toEqual({
      bypass: 0,
      hit: 1,
      miss: 2,
      store: 2,
    });
  });

  it("can disable bundle MCP materialization descriptor caching", async () => {
    process.env.OPENCLAW_BUNDLE_MCP_TOOL_CACHE = "0";
    const runtime = makeToolRuntime();

    await materializeBundleMcpToolsForRun({ runtime });
    await materializeBundleMcpToolsForRun({ runtime });

    expect(getBundleMcpToolMaterializationCacheStatsForTest()).toEqual({
      bypass: 2,
      hit: 0,
      miss: 0,
      store: 0,
    });
  });
});
