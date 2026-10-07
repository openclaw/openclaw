import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { zstdDecompressSync } from "node:zlib";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { createApiRegistry } from "../api-registry.js";
import {
  configureAiTransportHost,
  createAiTransportHost,
  getDefaultAiTransportHost,
  runWithAiTransportHost,
} from "../host.js";
import { responsesPromptObserver, type ResponsesPromptObservation } from "../internal/openai.js";
import { cleanupSessionResources } from "../session-resources.js";
import { createNodeLlmRuntime } from "../stream.js";
import { withProviderAcceptanceObserver } from "../transports/transport-stream-shared.js";
import type { Context, Model, SimpleStreamOptions } from "../types.js";
import { createZeroUsage } from "../usage.test-support.js";
import { isTransientNetworkError } from "../utils/retryable-network-errors.js";
import {
  closeOpenAICodexWebSocketSessions,
  extractOpenAICodexAccountId,
  resetOpenAICodexWebSocketStateForTest,
  streamSimpleOpenAICodexResponses,
  streamOpenAICodexResponses,
} from "./openai-chatgpt-responses.js";

function createJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.signature`;
}

function stubTimeoutSignal(timeoutMs: number): void {
  vi.spyOn(AbortSignal, "timeout").mockImplementation((actualTimeoutMs) => {
    expect(actualTimeoutMs).toBe(timeoutMs);
    const controller = new AbortController();
    queueMicrotask(() => {
      controller.abort(new DOMException("timed out", "TimeoutError"));
    });
    return controller.signal;
  });
}

function stubHangingFetch(timeoutMs: number): void {
  stubTimeoutSignal(timeoutMs);

  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (!signal) {
            reject(new Error("missing abort signal"));
            return;
          }

          const abort = () => {
            reject(
              signal.reason instanceof Error
                ? signal.reason
                : new DOMException("aborted", "AbortError"),
            );
          };
          if (signal.aborted) {
            abort();
            return;
          }
          signal.addEventListener("abort", abort, { once: true });
        }),
    ),
  );
}

function completion(id = "resp_test") {
  return {
    type: "response.completed",
    response: {
      id,
      status: "completed",
      output: [],
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    },
  };
}
function completedSseResponse(id = "resp_test"): Response {
  return new Response(`data: ${JSON.stringify(completion(id))}\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
}
function installWebSocket(
  reply: (socket: EventTarget & { connectionId: number }) => void,
  open = true,
) {
  const sockets: ScriptedWebSocket[] = [];
  const close = vi.fn();
  const send = vi.fn(reply);
  class ScriptedWebSocket extends EventTarget {
    readonly connectionId = sockets.length + 1;
    readyState = 1;
    constructor() {
      super();
      sockets.push(this);
      if (open) {
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }
    }
    send() {
      queueMicrotask(() => send(this));
    }
    close() {
      this.readyState = 3;
      close(this.connectionId);
    }
  }
  vi.stubGlobal("WebSocket", ScriptedWebSocket);
  return { sockets, close, send };
}
function message(socket: EventTarget, event: Record<string, unknown>) {
  socket.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(event) }));
}

describe("extractOpenAICodexAccountId", () => {
  it("rejects tokens without a Codex account id", () => {
    expect(() => extractOpenAICodexAccountId(createJwt({}))).toThrow(
      "Failed to extract accountId from token",
    );
  });
});

describe("streamOpenAICodexResponses transport", () => {
  afterEach(() => {
    closeOpenAICodexWebSocketSessions();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    resetOpenAICodexWebSocketStateForTest();
    configureAiTransportHost({});
  });

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

  const apiKey = createJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } });
  const context = {
    messages: [{ role: "user", content: "hi", timestamp: 1 }],
  } satisfies Context;

  function run(
    options: Options,
    requestContext: Context = context,
    requestModel: Model<"openai-chatgpt-responses"> = model,
  ) {
    return streamOpenAICodexResponses(requestModel, requestContext, {
      apiKey,
      ...options,
    }).result();
  }

  it("unwraps sentinels before constructing ChatGPT SSE auth headers", async () => {
    const realToken = createJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-sentinel" },
    });
    const sentinel = "oc-sent-v2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.end";
    configureAiTransportHost({
      resolveSecretSentinel: (value) => value.replaceAll(sentinel, realToken),
    });
    let authorization: string | null = null;
    let providerToken: string | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input, init) => {
        const headers = new Headers(init?.headers);
        authorization = headers.get("authorization");
        providerToken = headers.get("x-provider-token");
        return completedSseResponse();
      }),
    );

    const result = await streamOpenAICodexResponses(
      { ...model, headers: { "X-Provider-Token": `Bearer ${sentinel}` } },
      context,
      {
        apiKey: sentinel,
        transport: "sse",
      },
    ).result();

    expect(result.stopReason).toBe("stop");
    expect(authorization).toBe(`Bearer ${realToken}`);
    expect(authorization).not.toContain(sentinel);
    expect(providerToken).toBe(`Bearer ${realToken}`);
  });

  it("reconnects once when the websocket connection limit is reached", async () => {
    const { sockets } = installWebSocket((socket) =>
      message(
        socket,
        socket.connectionId === 1
          ? { type: "error", error: { code: "websocket_connection_limit_reached" } }
          : completion("resp_ws"),
      ),
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await run({
      transport: "websocket",
    });

    expect(result.stopReason).toBe("stop");
    expect(sockets).toHaveLength(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rotates cached websockets before the backend connection age limit", async () => {
    vi.useFakeTimers();
    const startedAt = new Date("2026-07-03T00:00:00Z");
    vi.setSystemTime(startedAt);
    const sentConnectionIds: number[] = [];
    const { sockets } = installWebSocket((socket) => {
      sentConnectionIds.push(socket.connectionId);
      message(socket, completion("resp_" + socket.connectionId));
    });
    const sessionId = "aged-session";

    await run({
      sessionId,
      transport: "websocket-cached",
    });
    vi.setSystemTime(new Date(startedAt.getTime() + 56 * 60 * 1000));
    await run({
      sessionId,
      transport: "websocket-cached",
    });

    expect(sentConnectionIds).toEqual([1, 2]);
    expect(sockets).toHaveLength(2);
  });

  it("sends the selected service tier from simple completions", async () => {
    expect(await simplePayload({ serviceTier: "priority" })).toMatchObject({
      service_tier: "priority",
    });
  });

  it("preserves max reasoning without catalog metadata", async () => {
    expect(
      await simplePayload({ reasoning: "max" }, { ...model, id: "gpt-5.6-sol" }),
    ).toMatchObject({
      reasoning: { effort: "max", summary: "auto" },
    });
  });

  it.each([
    { id: "gpt-6.1-sol", effort: "minimal", map: undefined, expected: "low" },
    { id: "gpt-6-sol", effort: "none", map: undefined, expected: "none" },
  ] as const)("normalizes raw $id $effort", async ({ id, effort, map, expected }) => {
    const payload = await capturePayload(
      context,
      { reasoningEffort: effort },
      { ...model, id, thinkingLevelMap: map },
    );
    expect(payload.reasoning).toEqual({
      effort: expected,
      ...(expected === "none" ? {} : { summary: "auto" }),
    });
  });

  it.each([
    [true, "off", undefined, undefined, undefined, undefined],
    [false, "high", ["none", "high"], undefined, undefined, undefined],
  ] as const)(
    "resolves reasoning=%s request=%s supported=%j scalar=%s off=%s",
    async (reasoning, requested, supported, scalar, off, expected) => {
      const payload = await simplePayload(
        { reasoning: requested },
        {
          ...model,
          id: "custom-reasoning",
          reasoning,
          thinkingLevelMap: { off: off ?? "none" },
          compat: {
            supportedReasoningEfforts: supported ? [...supported] : undefined,
            supportsReasoningEffort: scalar,
          },
        },
      );
      expect(payload.reasoning).toEqual(
        expected === undefined
          ? undefined
          : {
              effort: expected,
              ...(expected === "none" ? {} : { summary: "auto" }),
            },
      );
    },
  );

  it("sends strict structured output without adding tools", async () => {
    const format = {
      name: "reef_guard_verdict",
      strict: true,
      schema: { type: "object", additionalProperties: false },
    };
    const payload = await simplePayload({
      responseFormat: { type: "json_schema", json_schema: format },
    });
    expect(payload).toMatchObject({
      text: { verbosity: "low", format: { type: "json_schema", ...format } },
    });
    expect(payload).not.toHaveProperty("tools");
    expect(payload).not.toHaveProperty("tool_choice");
  });

  it("does not fall back to SSE when websocket transport is explicit", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("fetch should not run");
    });
    vi.stubGlobal("fetch", fetchMock);
    function FailingWebSocket() {
      throw new Error("websocket connect failed");
    }
    vi.stubGlobal("WebSocket", FailingWebSocket);

    const result = await run({
      sessionId: "session-explicit-websocket",
      transport: "websocket",
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("websocket connect failed");
  });

  it("does not replay Responses item ids for store-disabled ChatGPT requests", async () => {
    let capturedPayload:
      | {
          store?: unknown;
          input?: Array<Record<string, unknown>>;
        }
      | undefined;
    const stream = streamOpenAICodexResponses(
      model,
      {
        messages: [
          {
            role: "assistant",
            api: "openai-chatgpt-responses",
            provider: model.provider,
            model: model.id,
            usage: createZeroUsage(),
            stopReason: "toolUse",
            timestamp: 1,
            content: [
              {
                type: "thinking",
                thinking: "Need a tool.",
                thinkingSignature: JSON.stringify({
                  type: "reasoning",
                  id: "rs_prior",
                  encrypted_content: "ciphertext",
                }),
              },
              {
                type: "text",
                text: "Checking.",
                textSignature: JSON.stringify({
                  v: 1,
                  id: "msg_prior",
                  phase: "commentary",
                }),
              },
              {
                type: "toolCall",
                id: "call_abc|fc_prior",
                name: "lookup",
                arguments: {},
              },
            ],
          },
        ],
      },
      {
        apiKey,
        transport: "sse",
        onPayload: (payload) => {
          capturedPayload = payload as typeof capturedPayload;
          throw new Error("stop after payload");
        },
      },
    );

    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe("stop after payload");
    expect(capturedPayload?.store).toBe(false);
    const reasoningItem = capturedPayload?.input?.find((item) => item.type === "reasoning");
    expect(reasoningItem).toMatchObject({
      type: "reasoning",
      encrypted_content: "ciphertext",
      summary: [],
    });
    expect(reasoningItem).not.toHaveProperty("id");
    const messageItem = capturedPayload?.input?.find((item) => item.type === "message");
    expect(messageItem).toMatchObject({
      type: "message",
      phase: "commentary",
    });
    expect(messageItem).not.toHaveProperty("id");
    const functionCall = capturedPayload?.input?.find((item) => item.type === "function_call");
    expect(functionCall).toMatchObject({
      type: "function_call",
      call_id: "call_abc",
    });
    expect(functionCall).not.toHaveProperty("id");
  });

  it("caps oversized timeoutMs before creating request abort signals", async () => {
    stubHangingFetch(MAX_TIMER_TIMEOUT_MS);

    const stream = streamOpenAICodexResponses(model, context, {
      apiKey,
      timeoutMs: Number.MAX_SAFE_INTEGER,
      transport: "sse",
    });

    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain(`Request timed out after ${MAX_TIMER_TIMEOUT_MS}ms`);
  });

  it("honors timeoutMs for default websocket transport requests", async () => {
    stubTimeoutSignal(5);
    const fetchMock = vi.fn(async () => {
      throw new Error("fetch should not run before websocket timeout");
    });
    vi.stubGlobal("fetch", fetchMock);
    installWebSocket(() => {}, false);

    const stream = streamOpenAICodexResponses(model, context, {
      apiKey,
      timeoutMs: 5,
    });

    const result = await stream.result();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("Request timed out after 5ms");
  });

  it("does not send websocket payload after timeout fires during connect", async () => {
    let timeoutController: AbortController | undefined;
    vi.spyOn(AbortSignal, "timeout").mockImplementation((actualTimeoutMs) => {
      expect(actualTimeoutMs).toBe(5);
      timeoutController = new AbortController();
      return timeoutController.signal;
    });
    const sendMock = vi.fn();
    class OpeningThenTimedOutWebSocket {
      send = sendMock;
      close = vi.fn();
      addEventListener(type: string, listener: (event: unknown) => void): void {
        if (type === "open") {
          queueMicrotask(() => {
            listener({});
            timeoutController?.abort(new DOMException("timed out", "TimeoutError"));
          });
        }
      }
      removeEventListener(): void {}
    }
    vi.stubGlobal("WebSocket", OpeningThenTimedOutWebSocket);

    const stream = streamOpenAICodexResponses(model, context, {
      apiKey,
      timeoutMs: 5,
    });

    const result = await stream.result();

    expect(sendMock).not.toHaveBeenCalled();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("Request timed out after 5ms");
  });

  it("fails closed on conflicting model evidence from a typeless SSE event", async () => {
    const events = [
      { headers: { "openai-model": "gpt-5.6-sol" } },
      {
        ...completion(),
        response: {
          ...completion().response,
          headers: { "x-openai-model": "gpt-5.6-terra-2026-08-01" },
        },
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
            headers: { "content-type": "text/event-stream" },
          }),
      ),
    );

    const result = await run({ transport: "sse" });
    expect(result).toMatchObject({
      stopReason: "error",
      errorMessage: "Conflicting OpenAI response model attestations",
    });
    expect(result.responseModel).toBeUndefined();
  });

  it("preserves model evidence carried only by the response.done alias", async () => {
    installWebSocket((socket) =>
      message(socket, {
        type: "response.done",
        response: { ...completion("resp_ws_done").response, headers: {}, model: model.id },
      }),
    );

    expect(await run({ transport: "websocket" })).toMatchObject({
      responseModel: model.id,
      stopReason: "stop",
    });
  });

  it.each([
    [
      429,
      JSON.stringify({ error: { message: "Too many requests" } }),
      "",
      expect.stringMatching(/^429: .*Retry-After: 7 seconds/),
    ],
    [304, null, "Not Modified", "304: Not Modified"],
  ] as const)(
    "leaves HTTP %s retry ownership to the runner",
    async (status, body, statusText, errorMessage) => {
      vi.useFakeTimers();
      const prompt = "PRIVATE-NATIVE-SSE-RETRY-PROMPT";
      const observations: ResponsesPromptObservation[] = [];
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
        new Response(body, {
          status,
          statusText,
          headers:
            status === 429 ? { "retry-after-ms": "not-a-number", "retry-after": "7" } : undefined,
        }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const acceptanceObserver = vi.fn();
      const onResponse = vi.fn();
      const options = withProviderAcceptanceObserver(
        { apiKey, transport: "sse" as const, onResponse },
        acceptanceObserver,
      );
      responsesPromptObserver.set(options, (observation) => observations.push(observation));
      const pending = streamOpenAICodexResponses(
        model,
        { ...context, systemPrompt: prompt },
        options,
      ).result();
      await vi.runAllTimersAsync();
      expect(await pending).toMatchObject({
        stopReason: "error",
        errorCode: String(status),
        errorMessage,
      });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(acceptanceObserver).not.toHaveBeenCalled();
      expect(onResponse.mock.calls.map(([response]) => response.status)).toEqual([status]);
      expect(observations).toMatchObject([
        { egress: "native-codex-sse", payloadVariant: "initial", matchesAssembledPrompt: true },
      ]);
      expect(JSON.stringify(observations)).not.toContain(prompt);
    },
  );

  it("does not retry a non-Error rejection with a wrapped certificate code", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue({
      cause: { code: "INVALID_CA" },
      message: "fetch failed",
    });
    vi.stubGlobal("fetch", fetchMock);
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    const result = await run({ transport: "sse" });

    expect(result.stopReason).toBe("error");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  type Options = NonNullable<Parameters<typeof streamOpenAICodexResponses>[2]>;
  async function capturePayload(
    requestContext: Context = context,
    options: Options = {},
    requestModel: Model<"openai-chatgpt-responses"> = model,
  ) {
    let payload: Record<string, unknown> | undefined;
    const result = await streamOpenAICodexResponses(requestModel, requestContext, {
      apiKey,
      transport: "sse",
      ...options,
      onPayload: (value) => {
        payload = value as Record<string, unknown>;
        throw new Error("stop after payload");
      },
    }).result();
    expect(result).toMatchObject({ stopReason: "error", errorMessage: "stop after payload" });
    expect(payload).toBeDefined();
    return payload ?? {};
  }
  async function simplePayload(
    options: SimpleStreamOptions,
    requestModel: Model<"openai-chatgpt-responses"> = model,
  ) {
    let payload: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const body = Buffer.from(await request.arrayBuffer());
        payload = JSON.parse(
          (request.headers.get("content-encoding") === "zstd"
            ? zstdDecompressSync(body)
            : body
          ).toString("utf8"),
        );
        return completedSseResponse();
      }),
    );
    const result = await streamSimpleOpenAICodexResponses(requestModel, context, {
      apiKey,
      transport: "sse",
      ...options,
    }).result();
    expect(result.stopReason).toBe("stop");
    expect(result.errorMessage).toBeUndefined();
    expect(payload).toBeDefined();
    return payload ?? {};
  }
  it("keeps tool controls when a tool schema is usable", async () => {
    const payload = await capturePayload({
      ...context,
      tools: [
        {
          name: "lookup",
          description: "Look up a value.",
          parameters: {
            type: "object",
            properties: { query: { type: "string" }, after: { type: "string" } },
            required: ["query"],
            additionalProperties: false,
          },
        },
      ],
    });

    expect(payload).toMatchObject({
      tools: [
        {
          type: "function",
          name: "lookup",
          description: "Look up a value.",
          strict: false,
          parameters: {
            type: "object",
            properties: { query: { type: "string" }, after: { type: "string" } },
            required: ["query"],
            additionalProperties: false,
          },
        },
      ],
      tool_choice: "auto",
      parallel_tool_calls: true,
    });
  });

  it("does not classify a permanent WebSocket close as transient", async () => {
    installWebSocket((socket) =>
      socket.dispatchEvent(
        Object.assign(new Event("close"), {
          code: 1008,
          reason: "policy violation: ECONNRESET",
          wasClean: true,
        }),
      ),
    );

    const result = await run({
      transport: "websocket",
    });

    expect(result).toMatchObject({
      stopReason: "error",
      errorMessage: "WebSocket closed 1008 policy violation: ECONNRESET",
      errorCode: "ERR_WEBSOCKET_NON_RETRYABLE_CLOSE",
    });
    expect(isTransientNetworkError({ message: result.errorMessage, code: result.errorCode })).toBe(
      false,
    );
  });
});

describe("ChatGPT Responses runtime transport ownership", () => {
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

  const runtimeToken = createJwt({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" },
  });

  afterEach(() => {
    closeOpenAICodexWebSocketSessions();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    resetOpenAICodexWebSocketStateForTest();
    configureAiTransportHost({});
  });

  it("does not reuse or clean up an authenticated socket across runtime hosts", async () => {
    const sessionId = "runtime-authority-isolation";
    const firstToken = runtimeToken;
    const secondToken = `${runtimeToken}-other`;
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
      configureAiTransportHost({ resolveSecretSentinel: () => runtimeToken });
      const firstHost = getDefaultAiTransportHost();
      await streamOpenAICodexResponses(loopbackModel, context, {
        apiKey: "opaque",
        sessionId,
        transport: "websocket-cached",
        onPayload: (body) => {
          configureAiTransportHost({ resolveSecretSentinel: () => runtimeToken });
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
      const firstToken = runtimeToken;
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
      { apiKey: runtimeToken, transport: "auto" },
    ).result();

    expect(result.stopReason).toBe("stop");
    expect(fetchMock).toHaveBeenCalledWith(
      "/backend-api/codex/responses",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
