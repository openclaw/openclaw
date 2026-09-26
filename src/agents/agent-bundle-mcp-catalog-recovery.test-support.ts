import http from "node:http";
import { createDeferred } from "../../test/helpers/promise.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";

export async function startCatalogRecoveryMcpServer(
  label: string,
  options: { holdTermination?: Promise<void> } = {},
) {
  const terminationStarted = createDeferred();
  let terminationCount = 0;
  let sessionGeneration = 0;
  let listCount = 0;
  let maxActiveLists = 0;
  let hangCalls = true;
  let callReceived = createDeferred();
  const recoveryListStarted = createDeferred();
  const pendingLists: Array<{
    id: string | number;
    response: http.ServerResponse;
    sessionId: string;
  }> = [];
  const server = http.createServer((request, response) => {
    if (request.method === "GET") {
      response.writeHead(405).end();
      return;
    }
    if (request.method === "DELETE") {
      terminationCount += 1;
      terminationStarted.resolve();
      if (options.holdTermination) {
        void options.holdTermination.then(
          () => response.writeHead(204).end(),
          () => response.writeHead(500).end(),
        );
      } else {
        response.writeHead(204).end();
      }
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const message = JSON.parse(body) as {
        id: string | number;
        method: string;
        params?: { protocolVersion?: string };
      };
      if (message.method === "initialize") {
        sessionGeneration += 1;
        const sessionId = `${label}-${sessionGeneration}`;
        response.setHeader("content-type", "application/json");
        response.setHeader("mcp-session-id", sessionId);
        response.writeHead(200).end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: label, version: "1.0.0" },
            },
          }),
        );
        return;
      }
      if (message.method === "notifications/initialized") {
        response.writeHead(202).end();
        return;
      }
      const rawSessionId = request.headers["mcp-session-id"];
      const sessionId = typeof rawSessionId === "string" ? rawSessionId : "missing";
      if (message.method === "tools/call") {
        callReceived.resolve();
        callReceived = createDeferred();
        if (hangCalls) {
          return;
        }
        response.setHeader("content-type", "application/json");
        response.setHeader("mcp-session-id", sessionId);
        response.writeHead(200).end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              content: [],
              structuredContent: { revision: sessionId },
            },
          }),
        );
        return;
      }
      if (message.method === "tools/list") {
        listCount += 1;
        if (listCount === 1) {
          response.setHeader("content-type", "application/json");
          response.setHeader("mcp-session-id", sessionId);
          response.writeHead(200).end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                tools: [
                  {
                    name: "probe",
                    inputSchema: { type: "object" },
                    outputSchema: {
                      type: "object",
                      properties: { revision: { const: sessionId } },
                      required: ["revision"],
                    },
                  },
                ],
              },
            }),
          );
          return;
        }
        pendingLists.push({ id: message.id, response, sessionId });
        maxActiveLists = Math.max(maxActiveLists, pendingLists.length);
        recoveryListStarted.resolve();
      }
    });
  });
  const portClaim = await acquireTestPortBlock({ offsets: [0] });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(portClaim.port, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    await portClaim.release();
    throw error;
  }
  return {
    url: `http://127.0.0.1:${portClaim.port}/mcp`,
    terminationStarted: terminationStarted.promise,
    terminationCount: () => terminationCount,
    nextCall: () => callReceived.promise,
    recoveryListStarted: recoveryListStarted.promise,
    maxActiveLists: () => maxActiveLists,
    allowCalls: () => {
      hangCalls = false;
    },
    releaseLists: () => {
      for (const pending of pendingLists.splice(0)) {
        pending.response.setHeader("content-type", "application/json");
        pending.response.setHeader("mcp-session-id", pending.sessionId);
        pending.response.writeHead(200).end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: pending.id,
            result: {
              tools: [
                {
                  name: "probe",
                  inputSchema: { type: "object" },
                  outputSchema: {
                    type: "object",
                    properties: { revision: { const: pending.sessionId } },
                    required: ["revision"],
                  },
                },
              ],
            },
          }),
        );
      }
    },
    close: async () => {
      server.closeAllConnections();
      try {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      } finally {
        await portClaim.release();
      }
    },
  };
}
