#!/usr/bin/env node
/**
 * Standalone MCP server entry point spawned by the Claude CLI.
 *
 * Implements the MCP protocol on stdio (JSON-RPC 2.0, newline-delimited)
 * and bridges tool calls to the parent OpenClaw process via a Unix
 * domain socket whose path is read from OPENCLAW_MCP_SOCKET.
 *
 * This file runs as a separate process — it must not import heavy
 * modules from the main codebase.
 */
import net from "node:net";
import readline from "node:readline";
import type { McpIpcRequest, McpIpcResponse, McpToolSchema } from "./protocol.js";

const SOCKET_PATH = process.env.OPENCLAW_MCP_SOCKET;
if (!SOCKET_PATH) {
  process.stderr.write("OPENCLAW_MCP_SOCKET env var is required\n");
  process.exit(1);
}

// -- Unix socket IPC to parent process --

let ipcSocket: net.Socket | undefined;
let ipcRequestId = 0;
const pendingIpc = new Map<
  number,
  {
    resolve: (value: McpIpcResponse) => void;
    reject: (err: Error) => void;
  }
>();
let ipcBuffer = "";

function connectToParent(): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(SOCKET_PATH!, () => {
      ipcSocket = sock;
      resolve(sock);
    });
    sock.on("error", reject);
    sock.on("data", (chunk) => {
      ipcBuffer += chunk.toString();
      let newlineIdx: number;
      while ((newlineIdx = ipcBuffer.indexOf("\n")) !== -1) {
        const line = ipcBuffer.slice(0, newlineIdx);
        ipcBuffer = ipcBuffer.slice(newlineIdx + 1);
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as McpIpcResponse;
          const pending = pendingIpc.get(msg.id);
          if (pending) {
            pendingIpc.delete(msg.id);
            pending.resolve(msg);
          }
        } catch {
          // Ignore malformed messages
        }
      }
    });
    sock.on("close", () => {
      for (const pending of pendingIpc.values()) {
        pending.reject(new Error("IPC socket closed"));
      }
      pendingIpc.clear();
    });
  });
}

function sendIpc(request: McpIpcRequest): Promise<McpIpcResponse> {
  return new Promise((resolve, reject) => {
    if (!ipcSocket || ipcSocket.destroyed) {
      reject(new Error("IPC socket not connected"));
      return;
    }
    pendingIpc.set(request.id, { resolve, reject });
    ipcSocket.write(JSON.stringify(request) + "\n");
  });
}

// -- MCP protocol on stdio (JSON-RPC 2.0) --

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
};

function sendJsonRpc(id: number | string | undefined, result: unknown) {
  const msg = JSON.stringify({ jsonrpc: "2.0", id, result });
  process.stdout.write(msg + "\n");
}

function sendJsonRpcError(id: number | string | undefined, code: number, message: string) {
  const msg = JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });
  process.stdout.write(msg + "\n");
}

async function handleInitialize(id: number | string | undefined) {
  sendJsonRpc(id, {
    protocolVersion: "2024-11-05",
    capabilities: { tools: {} },
    serverInfo: { name: "openclaw-tools", version: "1.0.0" },
  });
}

async function handleToolsList(id: number | string | undefined) {
  const reqId = ++ipcRequestId;
  const response = await sendIpc({ id: reqId, type: "list_tools" });
  if (response.type !== "tools") {
    sendJsonRpcError(id, -32603, "Failed to list tools");
    return;
  }
  const mcpTools = response.tools.map((t: McpToolSchema) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
  sendJsonRpc(id, { tools: mcpTools });
}

async function handleToolsCall(id: number | string | undefined, params: Record<string, unknown>) {
  const toolName = params.name as string;
  const toolArgs = (params.arguments ?? {}) as Record<string, unknown>;
  const reqId = ++ipcRequestId;
  const response = await sendIpc({
    id: reqId,
    type: "call_tool",
    name: toolName,
    arguments: toolArgs,
  });
  if (response.type === "error") {
    sendJsonRpc(id, {
      content: [{ type: "text", text: response.message }],
      isError: true,
    });
    return;
  }
  if (response.type === "result") {
    sendJsonRpc(id, {
      content: response.content,
      isError: response.isError ?? false,
    });
    return;
  }
  sendJsonRpcError(id, -32603, "Unexpected IPC response");
}

async function handleRequest(req: JsonRpcRequest) {
  switch (req.method) {
    case "initialize":
      await handleInitialize(req.id);
      break;
    case "notifications/initialized":
      // No response needed for notifications
      break;
    case "tools/list":
      await handleToolsList(req.id);
      break;
    case "tools/call":
      await handleToolsCall(req.id, req.params ?? {});
      break;
    default:
      if (req.id !== undefined) {
        sendJsonRpcError(req.id, -32601, `Method not found: ${req.method}`);
      }
  }
}

// -- Main --

async function main() {
  await connectToParent();

  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    try {
      const req = JSON.parse(line) as JsonRpcRequest;
      handleRequest(req).catch((err) => {
        if (req.id !== undefined) {
          sendJsonRpcError(req.id, -32603, String(err));
        }
      });
    } catch {
      // Ignore malformed JSON
    }
  });
  rl.on("close", () => {
    ipcSocket?.destroy();
    process.exit(0);
  });
}

main().catch((err) => {
  process.stderr.write(`MCP bridge server failed: ${err}\n`);
  process.exit(1);
});
