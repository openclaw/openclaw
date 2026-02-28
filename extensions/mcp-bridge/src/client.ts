import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerConfig, McpServerConnection } from "./types.js";

/**
 * 创建并连接一个 MCP Client
 */
export async function connectMcpServer(
  name: string,
  config: McpServerConfig,
): Promise<McpServerConnection> {
  const client = new Client({
    name: `openclaw-mcp-bridge/${name}`,
    version: "0.1.0",
  });

  let closeTransport: () => Promise<void>;

  if (config.transport === "http") {
    if (!config.url) {
      throw new Error(`MCP server "${name}": url is required for http transport`);
    }
    const transport = new StreamableHTTPClientTransport(new URL(config.url));
    await client.connect(transport);
    closeTransport = () => transport.close();
  } else if (config.transport === "stdio") {
    if (!config.command) {
      throw new Error(`MCP server "${name}": command is required for stdio transport`);
    }
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: config.env ? ({ ...process.env, ...config.env } as Record<string, string>) : undefined,
    });
    await client.connect(transport);
    closeTransport = () => transport.close();
  } else {
    throw new Error(`MCP server "${name}": unsupported transport "${config.transport}"`);
  }

  return {
    name,
    config,
    client,
    close: async () => {
      await client.close();
      await closeTransport();
    },
  };
}
