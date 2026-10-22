import http from "node:http";
import { json } from "node:stream/consumers";

export async function startMcpLifecycleServer(options: {
  toolName: string;
  onDelete?: (endpoint: string) => Promise<void>;
  onList?: (endpoint: string) => Promise<void>;
  text: (endpoint: string, sessionId: number) => string;
}) {
  let initialized = 0;
  const server = http.createServer((request, response) => {
    void (async () => {
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
      const message = (await json(request)) as {
        id?: number;
        method: string;
        params?: { protocolVersion?: string };
      };
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
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    })().catch(() => response.writeHead(500).end());
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("MCP fixture did not bind");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
