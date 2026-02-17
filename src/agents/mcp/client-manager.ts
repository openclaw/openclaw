/**
 * MCP Client Manager (SDK-based).
 *
 * Higher-level client manager that uses the official @modelcontextprotocol/sdk
 * for connecting to MCP servers. Supports stdio and SSE transports.
 *
 * Unlike the lightweight McpClient (client.ts) which implements JSON-RPC
 * directly, this manager delegates transport and protocol to the SDK.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { WebSocketClientTransport } from "@modelcontextprotocol/sdk/client/websocket.js";
import type { AnyAgentTool } from "../tools/common.js";
import { mcpToolsToAgentTools } from "./tool-bridge.js";
import type { McpServerConfig, McpConfig, McpToolDefinition } from "./types.js";

interface ActiveClient {
  client: Client;
  transport:
    | StdioClientTransport
    | SSEClientTransport
    | StreamableHTTPClientTransport
    | WebSocketClientTransport;
  tools: McpToolDefinition[];
}

/**
 * Manages connections to MCP servers via the official SDK.
 *
 * Connects to configured servers, discovers tools, and exposes them
 * as Pi-AI AgentTools for the agent runtime.
 */
export class McpClientManager {
  private clients: Map<string, ActiveClient> = new Map();

  /**
   * Connect to all configured (non-disabled) MCP servers.
   */
  async connect(config: McpConfig): Promise<void> {
    const entries = Object.entries(config.servers).filter(([, cfg]) => !cfg.disabled);

    const results = await Promise.allSettled(
      entries.map(async ([name, serverConfig]) => {
        await this.connectServer(name, serverConfig);
      }),
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === "rejected") {
        const name = entries[i][0];
        console.warn(`MCP server "${name}" connection failed: ${result.reason}`);
      }
    }
  }

  private async connectServer(name: string, config: McpServerConfig): Promise<void> {
    let transport: StdioClientTransport | SSEClientTransport;

    if (config.type === "stdio" || !config.type) {
      if (!config.command) {
        throw new Error(`MCP server "${name}": command required for stdio transport`);
      }

      const cleanEnv = Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      );

      transport = new StdioClientTransport({
        command: config.command,
        args: config.args ?? [],
        env: { ...cleanEnv, ...config.env },
      });
    } else if (config.type === "sse") {
      if (!config.url) {
        throw new Error(`MCP server "${name}": url required for SSE transport`);
      }
      transport = new SSEClientTransport(new URL(config.url));
    } else if (config.type === "http") {
      if (!config.url) {
        throw new Error(`MCP server "${name}": url required for HTTP (Streamable HTTP) transport`);
      }
      const headers: Record<string, string> = {};
      if (config.env?.GITHUB_PERSONAL_ACCESS_TOKEN) {
        headers["Authorization"] = `Bearer ${config.env.GITHUB_PERSONAL_ACCESS_TOKEN}`;
      }
      // Type cast needed: StreamableHTTPClientTransport is valid but TS doesn't recognize it
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      transport = new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: Object.keys(headers).length > 0 ? { headers } : undefined,
      }) as any;
    } else if (config.type === "websocket") {
      if (!config.url) {
        throw new Error(`MCP server "${name}": url required for WebSocket transport`);
      }
      // Type cast needed: WebSocketClientTransport is valid but TS doesn't recognize it
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      transport = new WebSocketClientTransport(new URL(config.url)) as any;
    } else {
      const _exhaustiveCheck: never = config.type;
      throw new Error(`MCP server "${name}": unsupported transport type`);
    }

    const client = new Client({ name: "openclaw", version: "1.0.0" }, { capabilities: {} });

    await client.connect(transport);

    const toolsResult = await client.listTools();
    const tools: McpToolDefinition[] = (toolsResult.tools ?? [])
      .filter((t): t is typeof t & { name: string } => typeof t.name === "string" && t.name !== "")
      .map((t) => ({
        name: t.name,
        description: typeof t.description === "string" ? t.description : undefined,
        inputSchema: (t.inputSchema as Record<string, unknown>) ?? {
          type: "object",
          properties: {},
        },
      }));

    this.clients.set(name, { client, transport, tools });
  }

  /**
   * Get all discovered tools from connected servers as Pi-AI AgentTools.
   */
  getAgentTools(): AnyAgentTool[] {
    const allTools: AnyAgentTool[] = [];

    for (const [serverName, active] of this.clients.entries()) {
      if (active.tools.length === 0) {
        continue;
      }

      const callFn = async (
        _serverName: string,
        toolName: string,
        params: Record<string, unknown>,
      ) => {
        const result = await active.client.callTool({
          name: toolName,
          arguments: params,
        });

        const content = Array.isArray(result.content)
          ? (result.content as Array<Record<string, unknown>>)
              .filter((c): c is Record<string, unknown> => Boolean(c && typeof c === "object"))
              .map((c) => {
                if (c.type === "text" && typeof c.text === "string") {
                  return { type: "text" as const, text: c.text };
                }
                if (
                  c.type === "image" &&
                  typeof c.data === "string" &&
                  typeof c.mimeType === "string"
                ) {
                  return { type: "image" as const, data: c.data, mimeType: c.mimeType };
                }
                return { type: "text" as const, text: JSON.stringify(c) };
              })
          : [{ type: "text" as const, text: "(empty result)" }];

        return { content, isError: result.isError === true };
      };

      allTools.push(...mcpToolsToAgentTools(serverName, active.tools, callFn));
    }

    return allTools;
  }

  /**
   * Get names of all connected servers.
   */
  get serverNames(): string[] {
    return Array.from(this.clients.keys());
  }

  /**
   * Total number of available tools across all servers.
   */
  get totalToolCount(): number {
    let count = 0;
    for (const active of this.clients.values()) {
      count += active.tools.length;
    }
    return count;
  }

  /**
   * Disconnect from all MCP servers.
   */
  async disconnectAll(): Promise<void> {
    await Promise.allSettled(
      Array.from(this.clients.values()).map(async (active) => {
        try {
          await active.client.close();
        } catch {
          // Best-effort shutdown
        }
      }),
    );
    this.clients.clear();
  }
}
