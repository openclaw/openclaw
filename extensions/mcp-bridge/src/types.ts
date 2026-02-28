import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

/** 单个 MCP Server 的配置 */
export type McpServerConfig = {
  transport: "http" | "stdio";
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
};

/** 插件配置 */
export type McpBridgeConfig = {
  servers?: Record<string, McpServerConfig>;
};

/** 已连接的 MCP Server 实例 */
export type McpServerConnection = {
  name: string;
  config: McpServerConfig;
  client: Client;
  close: () => Promise<void>;
};
