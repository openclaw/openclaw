import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { promisify } from "node:util";
import OpenAI from "openai";
import { expect, vi } from "vitest";
import { WebSocketServer } from "ws";
import { cleanupSessionResources } from "../session-resources.js";
import { createModel } from "./openai-responses-prompt-observer.test-support.js";

export const responsesLoopbackModel = createModel({
  id: "scripted-model",
  name: "Scripted Model",
  reasoning: false,
  contextWindow: 8192,
  maxTokens: 256,
});

export async function createResponsesLoopbackServer(events: (turn: number) => unknown[]) {
  const requests: Array<Record<string, unknown>> = [];
  const rawRequests: string[] = [];
  const authorization: Array<string | undefined> = [];
  let connections = 0;
  const eventsForRequest = (body: string) => {
    rawRequests.push(body);
    requests.push(JSON.parse(body) as Record<string, unknown>);
    return events(requests.length);
  };
  const server = createServer((request, response) => {
    authorization.push(request.headers.authorization);
    request.setEncoding("utf8");
    let body = "";
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      const reply = eventsForRequest(body);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(reply.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
    });
  });
  const sockets = new WebSocketServer({ server });
  sockets.on("connection", (socket, request) => {
    connections += 1;
    authorization.push(request.headers.authorization);
    socket.on("message", (body) => {
      assert(Buffer.isBuffer(body), "Expected a Buffer from the WebSocket server");
      for (const event of eventsForRequest(body.toString("utf8"))) {
        socket.send(JSON.stringify(event));
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string", "Expected a loopback TCP address");
  // The replacement calls the original method with the active SDK client as this.
  // oxlint-disable-next-line typescript/unbound-method
  const buildURL = OpenAI.prototype.buildURL;
  // Route only the destination; native eligibility, the SDK, and request bytes stay real.
  const route = vi.spyOn(OpenAI.prototype, "buildURL").mockImplementation(function (
    this: OpenAI,
    ...args
  ) {
    const url = new URL(buildURL.apply(this, args));
    expect(url.origin).toBe("https://api.openai.com");
    expect(url.pathname).toBe("/v1/responses");
    url.protocol = "http:";
    url.host = `127.0.0.1:${address.port}`;
    return url.href;
  });
  return {
    requests,
    rawRequests,
    authorization,
    get connections() {
      return connections;
    },
    async close() {
      cleanupSessionResources();
      route.mockRestore();
      for (const socket of sockets.clients) {
        socket.terminate();
      }
      await promisify(sockets.close.bind(sockets))();
      const closed = promisify(server.close.bind(server))();
      server.closeAllConnections();
      await closed;
    },
  };
}
