import type { AnyAgentTool } from "openclaw/plugin-sdk";
import type { McpServerConnection } from "./types.js";

/**
 * 将 MCP Server 的工具列表转换为 OpenClaw AnyAgentTool 数组
 */
export async function createMcpTools(conn: McpServerConnection): Promise<AnyAgentTool[]> {
  const result = await conn.client.listTools();
  const tools: AnyAgentTool[] = [];

  for (const mcpTool of result.tools) {
    const toolName = `mcp_${conn.name}__${mcpTool.name}`;
    const tool: AnyAgentTool = {
      name: toolName,
      label: `${conn.name}: ${mcpTool.name}`,
      description: mcpTool.description ?? `MCP tool from ${conn.name}`,
      parameters: (mcpTool.inputSchema as Record<string, unknown>) ?? {
        type: "object",
        properties: {},
      },
      execute: async (_toolCallId, args, _signal?, _onUpdate?) => {
        const callResult = await conn.client.callTool({
          name: mcpTool.name,
          arguments: (args as Record<string, unknown>) ?? {},
        });

        // 将 MCP tool result 转换为 OpenClaw AgentToolResult 格式
        const content: (
          | { type: "text"; text: string }
          | { type: "image"; data: string; mimeType: string }
        )[] = [];
        if (Array.isArray(callResult.content)) {
          for (const item of callResult.content) {
            if (item.type === "text") {
              content.push({ type: "text", text: item.text });
            } else if (item.type === "image") {
              content.push({ type: "image", data: item.data, mimeType: item.mimeType });
            }
          }
        }

        if (content.length === 0) {
          content.push({
            type: "text",
            text: JSON.stringify(callResult, null, 2),
          });
        }

        return {
          content,
          details: callResult,
        };
      },
    };
    tools.push(tool);
  }

  return tools;
}
