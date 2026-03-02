/**
 * IPC protocol types for the Unix socket between the MCP bridge
 * server (spawned by Claude CLI) and the parent OpenClaw process.
 */

/** Tool schema sent from parent to bridge server for MCP tools/list. */
export type McpToolSchema = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

/** Tool result content block returned from parent after execution. */
export type McpToolResult = {
  type: "text";
  text: string;
};

// -- Requests (bridge server → parent) --

export type McpIpcListToolsRequest = {
  id: number;
  type: "list_tools";
};

export type McpIpcCallToolRequest = {
  id: number;
  type: "call_tool";
  name: string;
  arguments: Record<string, unknown>;
};

export type McpIpcRequest = McpIpcListToolsRequest | McpIpcCallToolRequest;

// -- Responses (parent → bridge server) --

export type McpIpcToolsResponse = {
  id: number;
  type: "tools";
  tools: McpToolSchema[];
};

export type McpIpcResultResponse = {
  id: number;
  type: "result";
  content: McpToolResult[];
  isError?: boolean;
};

export type McpIpcErrorResponse = {
  id: number;
  type: "error";
  message: string;
};

export type McpIpcResponse = McpIpcToolsResponse | McpIpcResultResponse | McpIpcErrorResponse;
