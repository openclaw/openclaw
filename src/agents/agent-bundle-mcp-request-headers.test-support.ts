import { randomUUID } from "node:crypto";
import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { expectDefined } from "@openclaw/normalization-core";

export async function startRequestHeaderMcpProofServer(kind: "streamable-http" | "sse") {
  const requests: Array<{ method?: string; headers: http.IncomingHttpHeaders }> = [];
  const server = new McpServer({ name: "request-header-proof", version: "1.0.0" });
  server.registerTool("probe", { description: "Exercise request attribution" }, async () => ({
    content: [{ type: "text", text: "ok" }],
  }));
  const streamable = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
  let sse: SSEServerTransport | undefined;
  if (kind === "streamable-http") {
    await server.connect(streamable);
  }
  const httpServer = http.createServer((request, response) => {
    void (async () => {
      if (kind === "sse" && request.method === "GET") {
        requests.push({ headers: { ...request.headers } });
        sse = new SSEServerTransport("/messages", response);
        await server.connect(sse);
        return;
      }
      let body: { method?: string } | undefined;
      if (request.method === "POST") {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.from(chunk));
        }
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      }
      requests.push({ method: body?.method, headers: { ...request.headers } });
      if (kind === "streamable-http") {
        await streamable.handleRequest(request, response, body);
      } else {
        await expectDefined(sse, "connected SSE transport").handlePostMessage(
          request,
          response,
          body,
        );
      }
    })().catch(() => {
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
    throw new Error("request header MCP proof server did not bind a loopback port");
  }
  return {
    requests,
    url: `http://127.0.0.1:${address.port}/mcp`,
    async close() {
      await server.close();
      httpServer.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
