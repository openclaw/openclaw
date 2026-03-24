export type { McpToolDescriptor } from "./mcp-client.js";

import type { JarvisMcpClient, McpToolDescriptor } from "./mcp-client.js";

/** Prefix all Jarvis tools to avoid name collisions with other OpenClaw tools. */
const TOOL_PREFIX = "jarvis_";

export type OpenClawToolDef = {
  name: string;
  label: string;
  description: string;
  parameters: McpToolDescriptor["inputSchema"];
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    details?: Record<string, unknown>;
  }>;
};

/**
 * Convert an MCP tool descriptor to an OpenClaw tool shape (without execute).
 * Used in tests; the full tool (with execute) is created by bridgeAllTools.
 */
export function convertMcpToolToOpenClaw(mcp: McpToolDescriptor): Omit<OpenClawToolDef, "execute"> {
  return {
    name: `${TOOL_PREFIX}${mcp.name}`,
    label: `Jarvis: ${mcp.name}`,
    description: mcp.description ?? `Jarvis tool: ${mcp.name}`,
    parameters: mcp.inputSchema,
  };
}

/**
 * Build fully executable OpenClaw tool definitions for all discovered MCP tools.
 * Each tool's execute proxies to the running MCP client.
 */
export function bridgeAllTools(
  mcpTools: McpToolDescriptor[],
  client: JarvisMcpClient,
  logger?: { warn(msg: string): void },
): OpenClawToolDef[] {
  return mcpTools.map((mcp) => {
    const base = convertMcpToolToOpenClaw(mcp);
    return {
      ...base,
      async execute(_toolCallId: string, params: Record<string, unknown>) {
        try {
          const result = await client.callTool(mcp.name, params);
          const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
          // Try to extract content array from MCP result.
          if (
            result &&
            typeof result === "object" &&
            "content" in (result as Record<string, unknown>)
          ) {
            const content = (result as { content: Array<{ type: string; text: string }> }).content;
            if (Array.isArray(content)) {
              return { content, details: undefined };
            }
          }
          return {
            content: [{ type: "text", text }],
            details: undefined,
          };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logger?.warn(`[jarvis] Tool ${mcp.name} failed: ${message}`);
          return {
            content: [{ type: "text", text: `Jarvis tool error: ${message}` }],
            details: { error: true },
          };
        }
      },
    };
  });
}
