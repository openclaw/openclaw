import { randomUUID } from "node:crypto";
import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export async function startRequesterScopedMcpProofServer(): Promise<{
  url: string;
  session: { current?: string; closed?: string; calls: number };
  close: () => Promise<void>;
}> {
  const server = new McpServer({ name: "openclaw-requester-proof", version: "1.0.0" });
  const session: { current?: string; closed?: string; calls: number } = { calls: 0 };
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: randomUUID,
    onsessioninitialized(nextSessionId) {
      session.current = nextSessionId;
    },
    onsessionclosed(nextSessionId) {
      session.closed = nextSessionId;
    },
  });
  server.registerTool(
    "requester_probe",
    { description: "Return the live requester-scoped MCP transport identity" },
    async () => {
      session.calls += 1;
      return { content: [{ type: "text", text: session.current ?? "missing-session" }] };
    },
  );
  await server.connect(transport);
  const httpServer = http.createServer((request, response) => {
    if (request.url !== "/mcp" || request.headers.authorization !== "Bearer proof-token") {
      response.writeHead(404).end();
      return;
    }
    void transport.handleRequest(request, response).catch(() => {
      if (!response.headersSent) {
        response.writeHead(500).end();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", resolve);
  });
  const address = httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("requester-scoped MCP proof server did not bind a loopback port");
  }
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    session,
    close: async () => {
      await server.close();
      httpServer.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
