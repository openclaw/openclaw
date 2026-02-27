export type McpTransportType = "stdio" | "sse" | "http";

export type McpServerStdioConfig = {
  name: string;
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
};

export type McpServerHttpConfig = {
  name: string;
  type: "http";
  url: string;
  headers?: Record<string, string>;
};

export type McpServerSseConfig = {
  name: string;
  type: "sse";
  url: string;
  headers?: Record<string, string>;
};

export type McpServerConfig = McpServerStdioConfig | McpServerHttpConfig | McpServerSseConfig;

export type McpBridgeConfig = {
  servers: McpServerConfig[];
};

export type McpDiscoveredTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};
