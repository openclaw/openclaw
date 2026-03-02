import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
/**
 * Parent-side of the MCP bridge. Creates a Unix domain socket server
 * that the MCP bridge subprocess connects to for tool execution.
 */
import net from "node:net";
import type { AnyAgentTool } from "../pi-tools.types.js";
import type { McpIpcRequest, McpIpcResponse, McpToolResult, McpToolSchema } from "./protocol.js";

export type McpBridgeHandle = {
  /** Socket path the MCP server subprocess should connect to. */
  socketPath: string;
  /** Stop the socket server and clean up. */
  cleanup(): Promise<void>;
};

/**
 * Start the parent side of the MCP bridge. Opens a Unix domain socket
 * that the bridge server subprocess connects to.
 *
 * Tool calls received from the subprocess are dispatched to the
 * matching AgentTool.execute() and results are sent back.
 */
export async function startMcpBridge(params: {
  tools: AnyAgentTool[];
  socketPath: string;
  abortSignal?: AbortSignal;
}): Promise<McpBridgeHandle> {
  const { tools, socketPath } = params;
  const toolsByName = new Map(tools.map((t) => [t.name, t]));

  // Build tool schemas once (TypeBox schemas are JSON Schema compatible)
  const toolSchemas: McpToolSchema[] = tools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    inputSchema: t.parameters
      ? (JSON.parse(JSON.stringify(t.parameters)) as Record<string, unknown>)
      : { type: "object", properties: {} },
  }));

  const server = net.createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        if (!line.trim()) continue;
        try {
          const request = JSON.parse(line) as McpIpcRequest;
          handleRequest(request, socket).catch(() => {
            // Best-effort error handling — socket may be closed
          });
        } catch {
          // Ignore malformed JSON
        }
      }
    });
  });

  async function handleRequest(request: McpIpcRequest, socket: net.Socket): Promise<void> {
    let response: McpIpcResponse;

    switch (request.type) {
      case "list_tools": {
        response = { id: request.id, type: "tools", tools: toolSchemas };
        break;
      }
      case "call_tool": {
        response = await executeToolCall(request.id, request.name, request.arguments);
        break;
      }
      default:
        response = {
          id: (request as McpIpcRequest).id,
          type: "error",
          message: `Unknown request type: ${(request as Record<string, unknown>).type}`,
        };
    }

    if (!socket.destroyed) {
      socket.write(JSON.stringify(response) + "\n");
    }
  }

  async function executeToolCall(
    id: number,
    name: string,
    args: Record<string, unknown>,
  ): Promise<McpIpcResponse> {
    const tool = toolsByName.get(name);
    if (!tool) {
      return { id, type: "error", message: `Unknown tool: ${name}` };
    }

    try {
      const toolCallId = randomUUID();
      const result = await tool.execute(toolCallId, args, params.abortSignal, undefined);

      // Convert AgentToolResult content to MCP format
      const content: McpToolResult[] = result.content.map((block) => {
        if (block.type === "text") {
          return { type: "text" as const, text: block.text };
        }
        // Image content — return a placeholder description
        return {
          type: "text" as const,
          text: "[image content]",
        };
      });

      const isError =
        result.details &&
        typeof result.details === "object" &&
        "status" in (result.details as Record<string, unknown>) &&
        (result.details as Record<string, unknown>).status === "error";

      return { id, type: "result", content, isError: !!isError };
    } catch (err) {
      return {
        id,
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // Start listening
  await new Promise<void>((resolve, reject) => {
    server.on("error", reject);
    server.listen(socketPath, () => resolve());
  });

  async function cleanup() {
    server.close();
    try {
      await fs.unlink(socketPath);
    } catch {
      // Socket file may already be gone
    }
  }

  return { socketPath, cleanup };
}
