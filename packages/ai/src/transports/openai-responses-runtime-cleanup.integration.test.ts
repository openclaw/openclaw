import { createServer } from "node:http";
import type { AddressInfo, Server } from "node:net";
import type { AssistantMessageEventStreamContract, Context, Model } from "@openclaw/llm-core";
import { afterEach, describe, expect, it, vi } from "vitest";

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

type Runtime = ReturnType<typeof createNodeLlmRuntime>;

function completedFrame(responseId: string): string {
  return JSON.stringify({
    type: "response.completed",
    response: {
      id: responseId,
      status: "completed",
      output: [
        {
          id: `msg_${responseId}`,
          type: "message",
          status: "completed",
          content: [{ type: "output_text", text: responseId, annotations: [] }],
          role: "assistant",
        },
      ],
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
    typeof Reflect.get(value, "push") === "function" &&
    typeof Reflect.get(value, "end") === "function" &&
    typeof Reflect.get(value, "result") === "function" &&
    typeof Reflect.get(value, Symbol.asyncIterator) === "function"
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

async function turn(params: {
  runtime: Runtime;
  model: Model<"openai-responses">;
  context: Context;
  sessionId: string;
  text: string;
  transport: OpenAIResponsesOptions["transport"];
}): Promise<void> {
  params.context.messages.push({
    role: "user",
    content: params.text,
    timestamp: params.context.messages.length + 1,
  });
  const response = await params.runtime.complete(params.model, params.context, {
    apiKey: "test-key",
    sessionId: params.sessionId,
    transport: params.transport,
    reasoningEffort: "low",
  });
  if (response.stopReason === "error") {
    throw new Error(response.errorMessage ?? "OpenAI Responses turn failed");
  }
  params.context.messages.push(response);
}

class LoopbackHttpResponsesServer {
  readonly requests: Array<Record<string, unknown>> = [];
  private server: Server | undefined;

  async listen(): Promise<string> {
    this.server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        this.requests.push(JSON.parse(body) as Record<string, unknown>);
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        });
        response.end(`data: ${completedFrame(`http_${this.requests.length}`)}\n\n`);
      });
    });
    await new Promise<void>((resolve) => {
      this.server?.listen(0, "127.0.0.1", resolve);
    });
    const address = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}/v1`;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server?.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

class LoopbackWebSocketResponsesServer {
  readonly requests: Array<{ connectionId: number; body: Record<string, unknown> }> = [];
  private readonly server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  private connections = 0;

  constructor() {
    this.server.on("connection", (socket) => {
      const connectionId = ++this.connections;
      socket.on("message", (data) => {
        const bytes = Array.isArray(data)
          ? Buffer.concat(data)
          : data instanceof ArrayBuffer
            ? Buffer.from(data)
            : data;
        const payload = bytes.toString("utf8");
        const body = JSON.parse(payload) as Record<string, unknown>;
        this.requests.push({ connectionId, body });
        socket.send(completedFrame(`ws_${this.requests.length}`));
      });
    });
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.server.once("listening", resolve);
    });
    const address = this.server.address() as AddressInfo;
    webSocketRoute.url = `ws://127.0.0.1:${address.port}/responses`;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
    webSocketRoute.url = "";
  }
}

afterEach(() => {
  cleanupSessionResources();
  webSocketRoute.url = "";
});

async function exerciseRuntimeCleanup<T>(params: {
  model: Model<"openai-responses">;
  transport: OpenAIResponsesOptions["transport"];
  observe: () => T;
}): Promise<{
  firstShared: T;
  secondShared: T;
  firstOther: T;
  secondOther: T;
  survivingShared: T;
  replacedShared: T;
  survivingOther: T;
  replacedOther: T;
}> {
  const first = createNodeLlmRuntime(createRegistry());
  const second = createNodeLlmRuntime(createRegistry());
  const contexts = {
    firstShared: { messages: [] } satisfies Context,
    firstOther: { messages: [] } satisfies Context,
    secondShared: { messages: [] } satisfies Context,
    secondOther: { messages: [] } satisfies Context,
  };
  const run = async (runtime: Runtime, context: Context, sessionId: string, text: string) => {
    await turn({
      runtime,
      model: params.model,
      context,
      sessionId,
      text,
      transport: params.transport,
    });
    return params.observe();
  };
  try {
    const firstShared = await run(first, contexts.firstShared, "shared", "first shared");
    const secondShared = await run(second, contexts.secondShared, "shared", "second shared");
    const firstOther = await run(first, contexts.firstOther, "other", "first other");
    const secondOther = await run(second, contexts.secondOther, "other", "second other");

    first.cleanupSessionResources("shared");
    const survivingShared = await run(
      second,
      contexts.secondShared,
      "shared",
      "second shared again",
    );
    const replacedShared = await run(first, contexts.firstShared, "shared", "first shared again");

    first.cleanupSessionResources();
    const survivingOther = await run(second, contexts.secondOther, "other", "second other again");
    const replacedOther = await run(first, contexts.firstOther, "other", "first other again");
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

describe("native Responses cleanup through public runtimes", () => {
  it("preserves a sibling runtime's real HTTP continuation for matching and omitted session cleanup", async () => {
    const server = new LoopbackHttpResponsesServer();
    const runtimeModel = model({ provider: "omniroute", baseUrl: await server.listen() });
    try {
      const effects = await exerciseRuntimeCleanup({
        model: runtimeModel,
        transport: "sse",
        observe: () => {
          const request = server.requests.at(-1);
          if (!request) {
            throw new Error("Expected the loopback server to receive an HTTP request");
          }
          return request;
        },
      });
      expect(effects.survivingShared.previous_response_id).toBe("http_2");
      expect(effects.replacedShared).not.toHaveProperty("previous_response_id");
      expect(effects.survivingOther.previous_response_id).toBe("http_4");
      expect(effects.replacedOther).not.toHaveProperty("previous_response_id");
    } finally {
      await server.close();
    }
  });

  it("preserves a sibling runtime's real WebSocket for matching and omitted session cleanup", async () => {
    const server = new LoopbackWebSocketResponsesServer();
    await server.listen();
    const runtimeModel = model({ provider: "openai", baseUrl: "https://api.openai.com/v1" });
    try {
      const effects = await exerciseRuntimeCleanup({
        model: runtimeModel,
        transport: "websocket-cached",
        observe: () => {
          const connectionId = server.requests.at(-1)?.connectionId;
          if (connectionId === undefined) {
            throw new Error("Expected the loopback server to receive a WebSocket request");
          }
          return connectionId;
        },
      });
      expect(effects.survivingShared).toBe(effects.secondShared);
      expect(effects.replacedShared).not.toBe(effects.firstShared);
      expect(effects.survivingOther).toBe(effects.secondOther);
      expect(effects.replacedOther).not.toBe(effects.firstOther);
    } finally {
      await server.close();
    }
  });
});
