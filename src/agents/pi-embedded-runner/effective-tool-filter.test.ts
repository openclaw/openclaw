import { describe, it, expect, vi } from "vitest";
import type { AnyAgentTool } from "../tools/common.js";
import { filterToolsForSystemPrompt } from "./effective-tool-filter.js";

const createMockTool = (name: string, pluginId?: string): AnyAgentTool => {
  const tool: AnyAgentTool = {
    name,
    description: `Mock tool ${name}`,
    inputSchema: { type: "object" as const, properties: {} },
  };
  // @ts-expect-error - pluginId is attached dynamically in real code
  if (pluginId) tool.pluginId = pluginId;
  return tool;
};

describe("filterToolsForSystemPrompt", () => {
  it("filters MCP tools based on tools.allow allowlist", () => {
    const coreTools = [createMockTool("read"), createMockTool("write")];
    const mcpTools = [
      createMockTool("mcp_server__tool1", "mcp-server"),
      createMockTool("mcp_server__tool2", "mcp-server"),
      createMockTool("mcp_server__allowed_tool", "mcp-server"),
    ];
    const allTools = [...coreTools, ...mcpTools];

    const warn = vi.fn();
    const result = filterToolsForSystemPrompt({
      tools: allTools,
      config: {
        tools: {
          allow: ["read", "write", "mcp_server__allowed_tool"],
        },
      } as any,
      warn,
    });

    // Should only include allowed tools
    expect(result.map((t) => t.name)).toContain("read");
    expect(result.map((t) => t.name)).toContain("write");
    expect(result.map((t) => t.name)).toContain("mcp_server__allowed_tool");
    // Should NOT include filtered MCP tools
    expect(result.map((t) => t.name)).not.toContain("mcp_server__tool1");
    expect(result.map((t) => t.name)).not.toContain("mcp_server__tool2");
  });

  it("returns all tools when no allowlist is configured", () => {
    const tools = [createMockTool("read"), createMockTool("mcp_server__tool1", "mcp-server")];

    const warn = vi.fn();
    const result = filterToolsForSystemPrompt({
      tools,
      config: {} as any,
      warn,
    });

    expect(result.length).toBe(2);
  });

  it("filters tools when global allowlist is set", () => {
    const tools = [
      createMockTool("read"),
      createMockTool("exec"),
      createMockTool("mcp_server__secret_tool", "mcp-server"),
    ];

    const warn = vi.fn();
    const result = filterToolsForSystemPrompt({
      tools,
      config: {
        tools: {
          allow: ["read"],
        },
      } as any,
      warn,
    });

    // Should filter to only allowed tools
    expect(result.map((t) => t.name)).toEqual(["read"]);
  });
});
