import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";
import * as z from "zod/v4";
import {
  __testing,
  disposeSessionMcpRuntime,
  getOrCreateSessionMcpRuntime,
  materializeBundleMcpToolsForRun,
} from "./pi-bundle-mcp-tools.js";

type ActiveSession = {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
};

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

async function startStreamableHttpMcpServer() {
  const sessions = new Map<string, ActiveSession>();
  let deleteCount = 0;

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (!req.url?.startsWith("/mcp")) {
        res.writeHead(404).end();
        return;
      }

      const sessionIdHeader = req.headers["mcp-session-id"];
      const sessionId =
        typeof sessionIdHeader === "string"
          ? sessionIdHeader
          : Array.isArray(sessionIdHeader)
            ? sessionIdHeader[0]
            : undefined;

      if (req.method === "POST") {
        const parsedBody = await readJsonBody(req);
        const method =
          parsedBody && typeof parsedBody === "object"
            ? (parsedBody as { method?: unknown }).method
            : undefined;

        let active = sessionId ? sessions.get(sessionId) : undefined;
        if (!active && method === "initialize") {
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => `mcp-${Math.random().toString(16).slice(2)}`,
            onsessioninitialized: (createdSessionId) => {
              sessions.set(createdSessionId, active!);
            },
            onsessionclosed: (closedSessionId) => {
              sessions.delete(closedSessionId);
            },
          });
          const server = new McpServer({ name: "test-streamable-http", version: "1.0.0" });
          server.registerTool(
            "remote_search",
            {
              description: "Test remote MCP tool",
              inputSchema: { query: z.string().optional() },
            },
            async ({ query }) => ({
              content: [{ type: "text", text: query ? `query:${query}` : "ok" }],
            }),
          );
          active = { server, transport };
          await server.connect(transport);
        }

        if (!active) {
          res.writeHead(400).end("missing session");
          return;
        }

        await active.transport.handleRequest(req, res, parsedBody);
        return;
      }

      if (req.method === "GET") {
        const active = sessionId ? sessions.get(sessionId) : undefined;
        if (!active) {
          res.writeHead(400).end("missing session");
          return;
        }
        await active.transport.handleRequest(req, res);
        return;
      }

      if (req.method === "DELETE") {
        deleteCount += 1;
        const active = sessionId ? sessions.get(sessionId) : undefined;
        if (!active) {
          res.writeHead(400).end("missing session");
          return;
        }
        await active.transport.handleRequest(req, res);
        return;
      }

      res.writeHead(405).end();
    } catch (error) {
      if (!res.headersSent) {
        res.writeHead(500).end(String(error));
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", () => {
      httpServer.removeListener("error", reject);
      resolve();
    });
  });

  const address = httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to bind streamable-http test server");
  }

  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    getDeleteCount: () => deleteCount,
    close: async () => {
      for (const active of sessions.values()) {
        await active.transport.close().catch(() => {});
        await active.server.close().catch(() => {});
      }
      sessions.clear();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

afterEach(async () => {
  await __testing.resetSessionMcpRuntimeManager();
});

describe("session MCP runtime streamable-http disposal", () => {
  it("terminates streamable-http sessions on disposal", async () => {
    const server = await startStreamableHttpMcpServer();
    try {
      const runtime = await getOrCreateSessionMcpRuntime({
        sessionId: "session-streamable-http",
        sessionKey: "agent:test:streamable-http",
        workspaceDir: "/tmp",
        cfg: {
          mcp: {
            servers: {
              remoteHttp: {
                transport: "streamable-http",
                url: server.url,
              },
            },
          },
        },
      });

      const materialized = await materializeBundleMcpToolsForRun({ runtime });
      expect(materialized.tools.map((tool) => tool.name)).toEqual(["remoteHttp__remote_search"]);

      await disposeSessionMcpRuntime("session-streamable-http");

      expect(server.getDeleteCount()).toBe(1);
    } finally {
      await server.close();
    }
  });
});
