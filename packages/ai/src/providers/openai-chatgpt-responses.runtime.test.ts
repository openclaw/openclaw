import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { createApiRegistry } from "../api-registry.js";
import {
  configureAiTransportHost,
  createAiTransportHost,
  getDefaultAiTransportHost,
  runWithAiTransportHost,
} from "../host.js";
import { cleanupSessionResources } from "../session-resources.js";
import { createNodeLlmRuntime } from "../stream.js";
import type { Context, Model } from "../types.js";
import {
  closeOpenAICodexWebSocketSessions,
  resetOpenAICodexWebSocketStateForTest,
  streamOpenAICodexResponses,
} from "./openai-chatgpt-responses.js";

const model = {
  id: "gpt-5.5",
  name: "GPT-5.5",
  api: "openai-chatgpt-responses",
  provider: "openai",
  baseUrl: "https://chatgpt.test/backend-api",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 16_000,
} satisfies Model<"openai-chatgpt-responses">;

const context = {
  messages: [{ role: "user", content: "hi", timestamp: 1 }],
} satisfies Context;

function createJwt(): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" },
  })}.signature`;
}

function completion(responseId: string) {
  return {
    type: "response.completed",
    response: {
      id: responseId,
      status: "completed",
      output: [],
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    },
  };
}

describe("ChatGPT Responses runtime transport ownership", () => {
  afterEach(() => {
    closeOpenAICodexWebSocketSessions();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    resetOpenAICodexWebSocketStateForTest();
    configureAiTransportHost({});
  });

  it("does not reuse or clean up an authenticated socket across runtime hosts", async () => {
    const sessionId = "runtime-authority-isolation";
    const firstToken = createJwt();
    const secondToken = `${createJwt()}-other`;
    const received: Array<{ authorization?: string; connectionId: number }> = [];
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    let connectionCount = 0;
    server.on("connection", (socket, request) => {
      const connectionId = ++connectionCount;
      socket.on("message", () => {
        received.push({ authorization: request.headers.authorization, connectionId });
        socket.send(JSON.stringify(completion(`resp_${connectionId}`)));
      });
    });
    await once(server, "listening");
    vi.stubGlobal("WebSocket", WebSocket);
    const loopbackModel = {
      ...model,
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/backend-api`,
    } satisfies Model<"openai-chatgpt-responses">;
    const options = { apiKey: "opaque", sessionId, transport: "websocket-cached" as const };
    const registry = createApiRegistry();
    registry.registerApiProvider({
      api: "openai-chatgpt-responses",
      stream: streamOpenAICodexResponses,
      streamSimple: streamOpenAICodexResponses,
    });
    const firstRuntime = createNodeLlmRuntime(registry, {
      resolveSecretSentinel: (value) => (value === "opaque" ? firstToken : value),
    });
    const secondRuntime = createNodeLlmRuntime(registry, {
      resolveSecretSentinel: (value) => (value === "opaque" ? secondToken : value),
    });

    try {
      await firstRuntime.stream(loopbackModel, context, options).result();
      await secondRuntime.stream(loopbackModel, context, options).result();
      firstRuntime.cleanupSessionResources(sessionId);
      await secondRuntime.stream(loopbackModel, context, options).result();
      closeOpenAICodexWebSocketSessions(sessionId);
      await secondRuntime.stream(loopbackModel, context, options).result();
      await firstRuntime.stream(loopbackModel, context, options).result();

      expect(received).toEqual([
        { authorization: `Bearer ${firstToken}`, connectionId: 1 },
        { authorization: `Bearer ${secondToken}`, connectionId: 2 },
        { authorization: `Bearer ${secondToken}`, connectionId: 2 },
        { authorization: `Bearer ${secondToken}`, connectionId: 3 },
        { authorization: `Bearer ${firstToken}`, connectionId: 4 },
      ]);
    } finally {
      firstRuntime.cleanupSessionResources(sessionId);
      secondRuntime.cleanupSessionResources(sessionId);
      for (const socket of server.clients) {
        socket.terminate();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("keeps default-host socket state reachable when replaced during payload construction", async () => {
    const sessionId = "default-host-replacement";
    const receivedConnectionIds: number[] = [];
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    let connectionId = 0;
    server.on("connection", (socket) => {
      const id = ++connectionId;
      socket.on("message", () => {
        receivedConnectionIds.push(id);
        socket.send(JSON.stringify(completion("resp_default")));
      });
    });
    await once(server, "listening");
    vi.stubGlobal("WebSocket", WebSocket);
    const closeSpy = vi.spyOn(WebSocket.prototype, "close");
    const loopbackModel = {
      ...model,
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/backend-api`,
    } satisfies Model<"openai-chatgpt-responses">;

    try {
      configureAiTransportHost({ resolveSecretSentinel: () => createJwt() });
      const firstHost = getDefaultAiTransportHost();
      await streamOpenAICodexResponses(loopbackModel, context, {
        apiKey: "opaque",
        sessionId,
        transport: "websocket-cached",
        onPayload: (body) => {
          configureAiTransportHost({ resolveSecretSentinel: () => createJwt() });
          return body;
        },
      }).result();
      await streamOpenAICodexResponses(loopbackModel, context, {
        apiKey: "opaque",
        sessionId,
        transport: "websocket-cached",
      }).result();

      cleanupSessionResources(sessionId, firstHost);
      await streamOpenAICodexResponses(loopbackModel, context, {
        apiKey: "opaque",
        sessionId,
        transport: "websocket-cached",
      }).result();

      expect(closeSpy).toHaveBeenCalledWith(1000, "debug_close");
      expect(receivedConnectionIds).toEqual([1, 2, 2]);
    } finally {
      closeOpenAICodexWebSocketSessions(sessionId);
      for (const socket of server.clients) {
        socket.terminate();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it.each(["auto", "websocket-cached"] as const)(
    "retains the managed fetch and credentials across host replacement for %s transport",
    async (transport) => {
      const firstToken = createJwt();
      let firstRequestHeaders: HeadersInit | undefined;
      const firstFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        firstRequestHeaders = init?.headers;
        return new Response(`data: ${JSON.stringify(completion("resp_first"))}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        });
      });
      const secondFetch = vi.fn(
        async () =>
          new Response(`data: ${JSON.stringify(completion("resp_second"))}\n\n`, {
            headers: { "content-type": "text/event-stream" },
          }),
      );
      const host = createAiTransportHost({
        buildModelFetch: () => firstFetch,
        requiresManagedTransport: () => true,
        resolveSecretSentinel: (value) => (value === "opaque" ? firstToken : value),
      });
      const replacementHost = createAiTransportHost({
        buildModelFetch: () => secondFetch,
        requiresManagedTransport: () => true,
      });
      configureAiTransportHost(transport === "auto" ? host : replacementHost);
      const WebSocketFixture = vi.fn(() => {
        throw new Error("managed transport must not open a WebSocket");
      });
      vi.stubGlobal("WebSocket", WebSocketFixture);

      const run = () =>
        streamOpenAICodexResponses(model, context, {
          apiKey: "opaque",
          sessionId: `managed-${transport}`,
          transport,
          onPayload: (body) => {
            configureAiTransportHost(replacementHost);
            return body;
          },
        }).result();
      const result = await (transport === "auto" ? run() : runWithAiTransportHost(host, run));

      expect(result.stopReason).toBe("stop");
      expect(firstFetch).toHaveBeenCalledOnce();
      expect(secondFetch).not.toHaveBeenCalled();
      expect(new Headers(firstRequestHeaders).get("authorization")).toBe(`Bearer ${firstToken}`);
      expect(WebSocketFixture).not.toHaveBeenCalled();
    },
  );

  it("falls back to SSE when a relative auto endpoint cannot form a WebSocket URL", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(`data: ${JSON.stringify(completion("resp_relative"))}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await streamOpenAICodexResponses(
      { ...model, baseUrl: "/backend-api" },
      context,
      { apiKey: createJwt(), transport: "auto" },
    ).result();

    expect(result.stopReason).toBe("stop");
    expect(fetchMock).toHaveBeenCalledWith(
      "/backend-api/codex/responses",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
