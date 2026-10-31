import type { IncomingMessage, ServerResponse } from "node:http";
import { json } from "node:stream/consumers";
import { startCompletionServer } from "./simple-completion.test-support.js";

export type McpFixtureMessage<TParams = { protocolVersion?: string }> = {
  id?: string | number;
  method: string;
  params?: TParams;
};

export async function readMcpFixtureMessage<TParams = { protocolVersion?: string }>(
  request: IncomingMessage,
): Promise<McpFixtureMessage<TParams>> {
  return (await json(request)) as McpFixtureMessage<TParams>;
}

export function replyMcpFixtureResult(
  response: ServerResponse,
  message: Pick<McpFixtureMessage, "id">,
  result: unknown,
) {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
}

export async function startMcpHttpFixture(
  handleRequest: (request: IncomingMessage, response: ServerResponse) => Promise<void>,
) {
  const server = await startCompletionServer((request, response) => {
    void handleRequest(request, response).catch(() => response.writeHead(500).end());
  });
  return { url: server.origin, close: () => server[Symbol.asyncDispose]() };
}

export async function startMcpLifecycleServer(options: {
  toolName: string;
  onDelete?: (endpoint: string) => Promise<void>;
  onList?: (endpoint: string) => Promise<void>;
  text: (endpoint: string, sessionId: number) => string;
}) {
  let initialized = 0;
  return startMcpHttpFixture(async (request, response) => {
    const endpoint = request.url ?? "/";
    if (request.method === "DELETE") {
      await options.onDelete?.(endpoint);
      response.writeHead(200).end();
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    const message = await readMcpFixtureMessage(request);
    let result;
    if (message.method === "initialize") {
      response.setHeader("mcp-session-id", String(++initialized));
      result = {
        protocolVersion: message.params?.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "lifecycle-proof", version: "1" },
      };
    } else if (message.method === "tools/list") {
      await options.onList?.(endpoint);
      result = { tools: [{ name: options.toolName, inputSchema: { type: "object" } }] };
    } else if (message.method === "tools/call") {
      const text = options.text(endpoint, Number(request.headers["mcp-session-id"]));
      result = { content: [{ type: "text", text }] };
    }
    if (!result) {
      response.writeHead(202).end();
      return;
    }
    replyMcpFixtureResult(response, message, result);
  });
}
