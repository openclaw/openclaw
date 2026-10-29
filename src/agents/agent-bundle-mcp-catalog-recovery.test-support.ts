import http from "node:http";
import { createDeferred } from "../../test/helpers/promise.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import {
  readMcpFixtureMessage,
  replyMcpFixtureResult,
} from "./agent-bundle-mcp-lifecycle.test-support.js";

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
    id?: string | number;
    response: http.ServerResponse;
    sessionId: string;
  }> = [];
  const replyList = (
    response: http.ServerResponse,
    id: string | number | undefined,
    sessionId: string,
  ) => {
    response.setHeader("mcp-session-id", sessionId);
    replyMcpFixtureResult(
      response,
      { id },
      {
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
    );
  };
  const server = http.createServer((request, response) => {
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
    void (async () => {
      const message = await readMcpFixtureMessage(request);
      if (message.method === "initialize") {
        sessionGeneration += 1;
        const sessionId = `${label}-${sessionGeneration}`;
        response.setHeader("mcp-session-id", sessionId);
        replyMcpFixtureResult(response, message, {
          protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: label, version: "1.0.0" },
        });
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
        response.setHeader("mcp-session-id", sessionId);
        replyMcpFixtureResult(response, message, {
          content: [],
          structuredContent: { revision: sessionId },
        });
        return;
      }
      if (message.method === "tools/list") {
        listCount += 1;
        if (listCount === 1) {
          replyList(response, message.id, sessionId);
          return;
        }
        pendingLists.push({ id: message.id, response, sessionId });
        maxActiveLists = Math.max(maxActiveLists, pendingLists.length);
        recoveryListStarted.resolve();
      }
    })();
  });
  const listener = await reserveTestPortListener({ offsets: [0], createListener: () => server });
  return {
    url: `http://127.0.0.1:${listener.claim.port}/mcp`,
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
        replyList(pending.response, pending.id, pending.sessionId);
      }
    },
    close: async () => {
      server.closeAllConnections();
      try {
        await listener.releaseListener();
      } finally {
        await listener.claim.release();
      }
    },
  };
}
