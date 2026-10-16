import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo, Server } from "node:net";
import { text } from "node:stream/consumers";
import type { AssistantMessageEventStreamContract, Context, Model } from "@openclaw/llm-core";
import { afterEach, expect, it, vi } from "vitest";

const webSocketRoute = vi.hoisted(() => ({ url: "" }));

vi.mock("openai/resources/responses/ws.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openai/resources/responses/ws.js")>();
  class RoutedResponsesWS extends actual.ResponsesWS {
    protected override _createSocket(url: URL, authHeaders: Record<string, string>) {
      if (!webSocketRoute.url) {
        throw new Error("Loopback WebSocket route is not configured");
      }
      // oxlint-disable-next-line no-underscore-dangle -- Preserve the SDK client; only reroute its socket URL to loopback.
      return super._createSocket(new URL(webSocketRoute.url, url), authHeaders);
    }
  }
  return { ...actual, ResponsesWS: RoutedResponsesWS };
});

import { WebSocketServer } from "ws";
import { createApiRegistry, type ApiStreamFunction } from "../api-registry.js";
import { cleanupSessionResources } from "../session-resources.js";
import { createNodeLlmRuntime } from "../stream.js";
import { createOpenAIResponsesTransportStreamFn } from "./openai-responses-client.js";
import type { OpenAIResponsesOptions } from "./openai-responses-contracts.js";
import { message } from "./openai-responses-stream-parity.test-helpers.js";

type Runtime = ReturnType<typeof createNodeLlmRuntime>;
const servers: Array<Server | WebSocketServer> = [];

function completedFrame(responseId: string): string {
  return JSON.stringify({
    type: "response.completed",
    response: {
      id: responseId,
      status: "completed",
      output: [message(`msg_${responseId}`, responseId)],
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    },
  });
}

function createRegistry() {
  const registry = createApiRegistry();
  const transport = createOpenAIResponsesTransportStreamFn();
  const stream: ApiStreamFunction = (requestModel, context, options) => {
    const started = transport(requestModel, context, options);
    if (!isRuntimeStream(started)) {
      throw new Error("OpenAI Responses transport must start synchronously for runtime dispatch");
    }
    return started;
  };
  registry.registerApiProvider({ api: "openai-responses", stream, streamSimple: stream });
  return registry;
}

function isRuntimeStream(value: unknown): value is AssistantMessageEventStreamContract {
  return (
    typeof value === "object" &&
    value !== null &&
    ["push", "end", "result", Symbol.asyncIterator].every(
      (key) => typeof Reflect.get(value, key) === "function",
    )
  );
}

function model(params: { provider: string; baseUrl: string }): Model<"openai-responses"> {
  return {
    id: "scripted-model",
    name: "Scripted Model",
    api: "openai-responses",
    provider: params.provider,
    baseUrl: params.baseUrl,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8192,
    compat: { supportsResponsesContinuation: true },
    [Symbol.for("openclaw.modelProviderRequestTransport")]: { allowPrivateNetwork: true },
  };
}

function closeServer(server: Server | WebSocketServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function httpServer() {
  const requests: Array<Record<string, unknown>> = [];
  const server = createServer(async (request, response) => {
    requests.push(JSON.parse(await text(request)) as Record<string, unknown>);
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${completedFrame(`http_${requests.length}`)}\n\n`);
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    requests,
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
  };
}

async function webSocketServer() {
  const requests: number[] = [];
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  servers.push(server);
  let connections = 0;
  server.on("connection", (socket) => {
    const connectionId = ++connections;
    socket.on("message", () => {
      requests.push(connectionId);
      socket.send(completedFrame(`ws_${requests.length}`));
    });
  });
  await once(server, "listening");
  webSocketRoute.url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/responses`;
  return { requests };
}

afterEach(async () => {
  cleanupSessionResources();
  for (const server of servers.splice(0)) {
    await closeServer(server);
  }
  webSocketRoute.url = "";
});

async function exerciseRuntimeCleanup<T>(params: {
  model: Model<"openai-responses">;
  transport: OpenAIResponsesOptions["transport"];
  observe: () => T;
}) {
  const first = createNodeLlmRuntime(createRegistry());
  const second = createNodeLlmRuntime(createRegistry());
  const runner = (runtime: Runtime, label: string) => {
    const contexts = new Map<string, Context>();
    return async (sessionId: string) => {
      const context: Context = contexts.get(sessionId) ?? { messages: [] };
      contexts.set(sessionId, context);
      context.messages.push({
        role: "user",
        content: `${label} ${sessionId}${context.messages.length ? " again" : ""}`,
        timestamp: context.messages.length + 1,
      });
      const response = await runtime.complete(params.model, context, {
        apiKey: "test-key",
        sessionId,
        transport: params.transport,
        reasoningEffort: "low",
      });
      if (response.stopReason === "error") {
        throw new Error(response.errorMessage ?? "OpenAI Responses turn failed");
      }
      context.messages.push(response);
      return params.observe();
    };
  };
  const runFirst = runner(first, "first");
  const runSecond = runner(second, "second");
  try {
    const firstShared = await runFirst("shared");
    const secondShared = await runSecond("shared");
    const firstOther = await runFirst("other");
    const secondOther = await runSecond("other");

    first.cleanupSessionResources("shared");
    const survivingShared = await runSecond("shared");
    const replacedShared = await runFirst("shared");

    first.cleanupSessionResources();
    const survivingOther = await runSecond("other");
    const replacedOther = await runFirst("other");
    return {
      firstShared,
      secondShared,
      firstOther,
      secondOther,
      survivingShared,
      replacedShared,
      survivingOther,
      replacedOther,
    };
  } finally {
    first.cleanupSessionResources();
    second.cleanupSessionResources();
  }
}

it("preserves a sibling runtime's real HTTP continuation for matching and omitted session cleanup", async () => {
  const server = await httpServer();
  const runtimeModel = model({ provider: "omniroute", baseUrl: server.baseUrl });
  const effects = await exerciseRuntimeCleanup({
    model: runtimeModel,
    transport: "sse",
    observe: () => {
      const request = server.requests.at(-1);
      assert(request, "Expected a loopback HTTP request");
      return request;
    },
  });
  expect(effects.survivingShared.previous_response_id).toBe("http_2");
  expect(effects.replacedShared).not.toHaveProperty("previous_response_id");
  expect(effects.survivingOther.previous_response_id).toBe("http_4");
  expect(effects.replacedOther).not.toHaveProperty("previous_response_id");
});

it("preserves a sibling runtime's real WebSocket for matching and omitted session cleanup", async () => {
  const server = await webSocketServer();
  const runtimeModel = model({ provider: "openai", baseUrl: "https://api.openai.com/v1" });
  const effects = await exerciseRuntimeCleanup({
    model: runtimeModel,
    transport: "websocket-cached",
    observe: () => {
      const request = server.requests.at(-1);
      assert(request, "Expected a loopback WebSocket request");
      return request;
    },
  });
  expect(effects.survivingShared).toBe(effects.secondShared);
  expect(effects.replacedShared).not.toBe(effects.firstShared);
  expect(effects.survivingOther).toBe(effects.secondOther);
  expect(effects.replacedOther).not.toBe(effects.firstOther);
});
