import { describe, expect, it, vi } from "vitest";
import { materializeBundleMcpToolsForRun } from "./pi-bundle-mcp-materialize.js";
import type { SessionMcpRuntime } from "./pi-bundle-mcp-types.js";

function createMockRuntime(tools: { toolName: string; inputSchema?: unknown }[]): SessionMcpRuntime {
  return {
    acquireLease: () => vi.fn(),
    markUsed: vi.fn(),
    getCatalog: async () => ({
      tools: tools.map((t) => ({
        serverName: "flux-mcp",
        safeServerName: "flux-mcp",
        toolName: t.toolName,
        title: undefined,
        description: "test tool",
        fallbackDescription: "",
        inputSchema: t.inputSchema,
      })),
      resources: [],
      prompts: [],
    }),
    callTool: vi.fn(),
  } as unknown as SessionMcpRuntime;
}

describe("materializeBundleMcpToolsForRun schema normalization", () => {
  it("normalizes empty inputSchema {} to { type: 'object', properties: {} }", async () => {
    const runtime = createMockRuntime([{ toolName: "get_flux_instance", inputSchema: {} }]);
    const result = await materializeBundleMcpToolsForRun({ runtime });
    const tool = result.tools.find((t) => t.name.includes("get_flux_instance"));
    expect(tool).toBeDefined();
    expect((tool!.parameters as Record<string, unknown>).type).toBe("object");
    expect((tool!.parameters as Record<string, unknown>).properties).toEqual({});
  });

  it("normalizes { type: 'object' } missing properties to include properties: {}", async () => {
    const runtime = createMockRuntime([
      { toolName: "get_flux_instance", inputSchema: { type: "object" } },
    ]);
    const result = await materializeBundleMcpToolsForRun({ runtime });
    const tool = result.tools.find((t) => t.name.includes("get_flux_instance"));
    expect(tool).toBeDefined();
    expect((tool!.parameters as Record<string, unknown>).properties).toEqual({});
  });

  it("normalizes undefined/null inputSchema to { type: 'object', properties: {} }", async () => {
    const runtime = createMockRuntime([
      { toolName: "tool_a", inputSchema: undefined },
      { toolName: "tool_b", inputSchema: null },
    ]);
    const result = await materializeBundleMcpToolsForRun({ runtime });
    for (const tool of result.tools) {
      expect((tool.parameters as Record<string, unknown>).type).toBe("object");
      expect((tool.parameters as Record<string, unknown>).properties).toEqual({});
    }
  });

  it("preserves existing valid schemas with properties", async () => {
    const schema = { type: "object", properties: { name: { type: "string" } }, required: ["name"] };
    const runtime = createMockRuntime([{ toolName: "create_resource", inputSchema: schema }]);
    const result = await materializeBundleMcpToolsForRun({ runtime });
    const tool = result.tools.find((t) => t.name.includes("create_resource"));
    expect(tool).toBeDefined();
    expect((tool!.parameters as Record<string, unknown>).properties).toEqual({
      name: { type: "string" },
    });
  });
});
