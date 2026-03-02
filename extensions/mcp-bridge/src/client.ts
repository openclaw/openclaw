import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  ListToolsResultSchema,
  CallToolResultSchema,
  type ListToolsRequest,
  type CallToolRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { createTransport } from "./transport.js";
import type { McpDiscoveredTool, McpServerConfig } from "./types.js";

export class McpBridgeClient {
  readonly serverName: string;
  private client: Client;
  private transport: Transport | null = null;
  private config: McpServerConfig;

  constructor(config: McpServerConfig) {
    this.serverName = config.name;
    this.config = config;
    this.client = new Client({
      name: `openclaw-mcp-bridge/${config.name}`,
      version: "1.0.0",
    });
  }

  async connect(): Promise<void> {
    this.transport = createTransport(this.config);
    await this.client.connect(this.transport);
  }

  async listTools(): Promise<McpDiscoveredTool[]> {
    const request: ListToolsRequest = {
      method: "tools/list",
      params: {},
    };
    const result = await this.client.request(request, ListToolsResultSchema);
    return result.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as Record<string, unknown> | undefined,
    }));
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: string; text?: string }>; isError?: boolean }> {
    const request: CallToolRequest = {
      method: "tools/call",
      params: {
        name,
        arguments: args,
      },
    };
    const result = await this.client.request(request, CallToolResultSchema);
    return {
      content: result.content.map((item) => {
        if (item.type === "text") {
          return { type: "text", text: item.text };
        }
        return { type: item.type, text: JSON.stringify(item) };
      }),
      isError: result.isError,
    };
  }

  async close(): Promise<void> {
    try {
      await this.transport?.close();
    } catch {
      // Ignore close errors
    }
    this.transport = null;
  }
}
