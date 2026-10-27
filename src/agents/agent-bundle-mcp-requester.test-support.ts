import { randomUUID } from "node:crypto";
import http from "node:http";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { McpServer } from "@modelcontextprotocol/server";
import {
  closeHttpServer,
  listenLoopback,
} from "../../test/helpers/gateway-integration-fixtures.js";

export async function startRequesterScopedMcpProofServer(): Promise<{
  url: string;
  session: { current?: string; closed?: string; calls: number };
  close: () => Promise<void>;
}> {
  const server = new McpServer({ name: "openclaw-requester-proof", version: "1.0.0" });
  const session: { current?: string; closed?: string; calls: number } = { calls: 0 };
  const transport = new NodeStreamableHTTPServerTransport({
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
  const origin = await listenLoopback(httpServer);
  return {
    url: `${origin}/mcp`,
    session,
    close: async () => {
      await server.close();
      await closeHttpServer(httpServer);
    },
  };
}
