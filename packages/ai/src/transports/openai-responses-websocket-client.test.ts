import {
  PROVIDER_POST_DISPATCH_AMBIGUITY_ERROR_CODE as AMBIGUOUS_DISPATCH,
  type AssistantMessage,
  type Context,
  type Model,
} from "@openclaw/llm-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { WebSocketError } from "openai/resources/responses/internal-base.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../../../../src/config/plugin-auto-enable.test-helpers.js";
import { isRetryableAssistantError } from "../../../../src/llm/utils/retry.js";
import { createEmptyPluginRegistry } from "../../../../src/plugins/registry-empty.js";
import { withPluginRuntimeGenerationScope } from "../../../../src/plugins/runtime/generation-scope.js";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import { cleanupSessionResources } from "../session-resources.js";
import {
  OpenAIResponsesWebSocketSafeRetryError,
  responsesPromptObserver,
  responsesServiceTierObserver,
  type OpenAIResponsesOptions,
  type ResponsesPromptObservation,
  type ResponsesServiceTierObservation,
} from "./openai-responses-contracts.js";
import {
  withProviderAcceptanceObserver,
  type ProviderAcceptance,
} from "./transport-stream-shared.js";

type StreamMessage =
  | { type: "open" }
  | { type: "error"; error: Error }
  | { type: "close"; code: number }
  | { type: "delay"; ms: number }
  | { type: "message"; message: Record<string, unknown> };
type SdkResponse = { data: AsyncIterable<unknown>; response: Response };

const transport = vi.hoisted(() => ({
  handshakeMessages: [] as StreamMessage[],
  responseBatches: [] as StreamMessage[][],
  sdkOutcomes: [] as Array<Error | SdkResponse>,
  sdkRequests: [] as Array<Record<string, unknown>>,
  closeCount: 0,
  wsClients: [] as Array<{ apiKey?: string; baseURL?: string }>,
  wsOptions: [] as Array<{ headers?: Record<string, string> }>,
  wsRequests: [] as Array<Record<string, unknown>>,
}));

vi.mock("openai", () => {
  class MockOpenAI {
    apiKey: string;
    baseURL: string;
    responses = {
      create: (request: Record<string, unknown>) => {
        transport.sdkRequests.push(request);
        const outcome = transport.sdkOutcomes.shift() ?? new Error("Unexpected SSE request");
        return {
          withResponse: async () => {
            if (outcome instanceof Error) {
              throw outcome;
            }
            return outcome;
          },
        };
      },
    };

    constructor(options: { apiKey?: string; baseURL?: string }) {
      this.apiKey = options.apiKey ?? "";
      this.baseURL = options.baseURL ?? "https://api.openai.com/v1";
    }

    withOptions(options: { apiKey?: string }) {
      return new MockOpenAI({ apiKey: options.apiKey ?? this.apiKey, baseURL: this.baseURL });
    }
  }

  return { default: MockOpenAI, AzureOpenAI: MockOpenAI };
});

vi.mock("openai/resources/responses/ws.js", () => ({
  ResponsesWS: class MockResponsesWS {
    socket = { readyState: 1 };
    private responseMessages: StreamMessage[] = [];

    constructor(
      client: { apiKey?: string; baseURL?: string },
      options: { headers?: Record<string, string> },
    ) {
      transport.wsClients.push(client);
      transport.wsOptions.push(options);
    }

    send(request: Record<string, unknown>) {
      transport.wsRequests.push(request);
      this.responseMessages = transport.responseBatches.shift() ?? [];
    }

    close() {
      transport.closeCount += 1;
      this.socket.readyState = 3;
    }

    on(_event: string, _listener: (error: Error) => void) {
      return this;
    }

    stream() {
      const handshake = transport.handshakeMessages.shift() ?? { type: "open" as const };
      const readResponses = () => this.responseMessages;
      return (async function* () {
        yield handshake;
        if (handshake.type !== "open") {
          return;
        }
        for (const streamMessage of readResponses()) {
          if (streamMessage.type === "delay") {
            await new Promise<void>((resolve) => {
              setTimeout(resolve, streamMessage.ms);
            });
            continue;
          }
          yield streamMessage;
        }
      })();
    }
  },
}));

import {
  createOpenAIResponsesClient as createClient,
  createOpenAIResponsesTransportStreamFn as createStreamFn,
} from "./openai-responses-client.js";
import { createOpenAIResponsesWebSocketStream as createSocketStream } from "./openai-responses-websocket.js";

const initialHost = getAiTransportHost();
const model = {
  id: "gpt-5.6-luna",
  name: "GPT-5.6 Luna",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8192,
} satisfies Model<"openai-responses">;

function history(...messages: Context["messages"]): Context {
  return { messages, tools: [] };
}

function user(text: string, timestamp: number) {
  return { role: "user" as const, content: text, timestamp };
}

function completedEvent(responseId: string, content?: string | Array<Record<string, unknown>>) {
  const output =
    typeof content === "string"
      ? [
          {
            id: `msg_${responseId}`,
            type: "message",
            status: "completed",
            content: [
              {
                text: content,
                type: "output_text",
                annotations: [{ type: "url_citation", url: "https://example.test/source" }],
                logprobs: [{ token: content, logprob: -0.1 }],
              },
            ],
            role: "assistant",
            phase: "final_answer",
          },
        ]
      : (content ?? []);
  return {
    type: "response.completed",
    response: {
      id: responseId,
      status: "completed",
      output,
      usage: {
        input_tokens: 5,
        output_tokens: output.length > 0 ? 3 : 0,
        total_tokens: output.length > 0 ? 8 : 5,
      },
    },
  };
}

function message(event: Record<string, unknown>): StreamMessage {
  return { type: "message", message: event };
}

function reply(responseId: string, content?: string | Array<Record<string, unknown>>) {
  return [message(completedEvent(responseId, content))];
}

function rejectionBatch(code: string, text: string, param?: string): StreamMessage[] {
  return [{ type: "error", error: wrappedSdkServerError({ code, message: text, param }) }];
}

function expectCounts(websocket: number, sse: number, clients?: number) {
  expect(transport.wsRequests).toHaveLength(websocket);
  expect(transport.sdkRequests).toHaveLength(sse);
  if (clients !== undefined) {
    expect(transport.wsOptions).toHaveLength(clients);
  }
}

function promptPaths(observations: ResponsesPromptObservation[]) {
  return observations.map(({ egress, payloadVariant }) => ({ egress, payloadVariant }));
}

function wrappedSdkServerError(params: {
  code: string;
  message: string;
  param?: string;
}): WebSocketError {
  const event = {
    type: "error",
    error: {
      type: "invalid_request_error",
      code: params.code,
      message: params.message,
      param: params.param ?? null,
    },
    status: 400,
  };
  return new WebSocketError(JSON.stringify(event), event as never);
}

function toolCallResponse(responseId: string): StreamMessage[] {
  const functionCall = {
    type: "function_call",
    id: "fc_read",
    call_id: "call_read",
    name: "read",
    arguments: '{"path":"README.md"}',
    status: "completed",
  };
  const position = { output_index: 0, item_id: functionCall.id };
  return [
    message({
      type: "response.output_item.added",
      output_index: 0,
      item: { ...functionCall, arguments: "", status: "in_progress" },
    }),
    message({
      type: "response.function_call_arguments.delta",
      ...position,
      delta: functionCall.arguments,
    }),
    message({
      type: "response.function_call_arguments.done",
      ...position,
      name: functionCall.name,
      arguments: functionCall.arguments,
    }),
    message({ type: "response.output_item.done", output_index: 0, item: functionCall }),
    message(completedEvent(responseId, [functionCall])),
  ];
}

function sdkCompletion(responseId: string): SdkResponse {
  return sdkEvent(completedEvent(responseId));
}

function sdkEvent(event: Record<string, unknown>): SdkResponse {
  return {
    data: (async function* () {
      yield event;
    })(),
    response: new Response(null, { status: 200 }),
  };
}

async function run(
  context: Context,
  overrides: OpenAIResponsesOptions & {
    model?: Model<"openai-responses">;
    observations?: ResponsesPromptObservation[];
    acceptanceObserver?: (acceptance: ProviderAcceptance) => void;
  } = {},
): Promise<AssistantMessage> {
  const {
    model: selected = model,
    observations,
    acceptanceObserver,
    ...requestOptions
  } = overrides;
  const options = {
    apiKey: "test-key",
    sessionId: "session-1",
    transport: "websocket-cached" as const,
    reasoningEffort: "low" as const,
    ...requestOptions,
  };
  if (acceptanceObserver) {
    withProviderAcceptanceObserver(options, acceptanceObserver);
  }
  if (observations) {
    responsesPromptObserver.set(options, (observation) => observations.push(observation));
  }
  const stream = await createStreamFn()(selected, context, options);
  return stream.result();
}

describe("native OpenAI Responses WebSocket client integration", () => {
  beforeEach(() => {
    cleanupSessionResources();
    transport.handshakeMessages.length = 0;
    transport.responseBatches.length = 0;
    transport.sdkOutcomes.length = 0;
    transport.sdkRequests.length = 0;
    transport.closeCount = 0;
    transport.wsClients.length = 0;
    transport.wsOptions.length = 0;
    transport.wsRequests.length = 0;
    let turn = 0;
    configureAiTransportHost({
      ...initialHost,
      plugin: {
        ...initialHost.plugin,
        resolveTransportTurnState: ({ context }) => {
          turn += 1;
          return {
            headers: {
              "x-openclaw-session-id": context.sessionId ?? "",
              "x-openclaw-turn-id": `turn-${turn}`,
              "x-openclaw-turn-attempt": "1",
            },
            metadata: {
              openclaw_session_id: context.sessionId ?? "",
              openclaw_turn_id: `turn-${turn}`,
              openclaw_turn_attempt: "1",
              openclaw_transport: context.transport,
            },
            websocket: {
              headers: {
                "x-client-request-id": context.sessionId ?? "",
                "x-openclaw-session-id": context.sessionId ?? "",
                "x-provider-route": "route-a",
              },
              degradeCooldownMs: 1_000,
            },
          };
        },
      },
    });
  });

  afterEach(() => {
    cleanupSessionResources();
    configureAiTransportHost(initialHost);
  });

  it("observes the dispatched WebSocket service tier and raw terminal downgrade", async () => {
    const completed = completedEvent("resp_tier", "ok");
    transport.responseBatches.push([
      message({
        ...completed,
        response: {
          ...completed.response,
          model: "fixture-served",
          service_tier: "default",
          usage: {
            ...completed.response.usage,
            input_tokens_details: { cached_tokens: 3, cache_write_tokens: 0 },
          },
        },
      }),
    ]);
    const observations: ResponsesServiceTierObservation[] = [];
    const options = {
      apiKey: "test-key",
      transport: "websocket" as const,
      onPayload: (payload: unknown) => ({
        ...(payload as Record<string, unknown>),
        service_tier: "ultrafast",
      }),
    };
    responsesServiceTierObserver.set(options, (observation) => observations.push(observation));
    const stream = await createStreamFn()(model, history(user("hello", 1)), options);
    expect((await stream.result()).stopReason).toBe("stop");
    expect(transport.wsRequests[0]?.service_tier).toBe("ultrafast");
    expect(observations).toEqual([
      {
        requestedTier: "ultrafast",
        responseTier: "default",
        responseId: "resp_tier",
        responseModel: "fixture-served",
        inputTokens: 5,
        cachedTokens: 3,
      },
    ]);
  });

  it.each(["after-output", "registered-hook", "active-hook"] as const)(
    "recovers tier rejection only before output: %s",
    async (shape) => {
      const onActiveResponse = vi.fn();
      const rejection = {
        code: "invalid_request_error",
        type: "invalid_request_error",
        param: "service_tier",
        message: "Invalid service_tier argument",
      };
      transport.responseBatches.push([
        ...(shape === "active-hook"
          ? [message({ type: "response.created", response: { id: "resp_active" } })]
          : []),
        ...(shape === "after-output"
          ? [
              message({
                type: "response.output_item.added",
                output_index: 0,
                item: { type: "web_search_call", id: "ws_started", status: "in_progress" },
              }),
            ]
          : []),
        message({
          type: "response.failed",
          response: { id: "resp_tier_error", status: "failed", error: rejection, output: [] },
        }),
      ]);
      transport.sdkOutcomes.push(sdkCompletion("resp_tier_recovered"));
      const observations: ResponsesServiceTierObservation[] = [];
      const options = {
        apiKey: "synthetic-key",
        transport: "websocket-cached" as const,
        sessionId: "tier-recovery-session",
        ...(shape.endsWith("hook") ? { onActiveResponse } : {}),
        onPayload: (payload: unknown) => {
          if (!isRecord(payload)) {
            throw new Error("Expected a request object");
          }
          payload.service_tier = "ultrafast";
        },
      };
      responsesServiceTierObserver.set(options, (observation) => observations.push(observation));
      const stream = await createStreamFn()(
        { ...model, id: "gpt-6-astra" },
        history(user("hello", 1)),
        options,
      );
      const result = await stream.result();
      expect(onActiveResponse).toHaveBeenCalledTimes(shape === "active-hook" ? 1 : 0);
      if (shape === "after-output" || shape === "active-hook") {
        expect(result.stopReason).toBe("error");
        expect(transport.sdkRequests).toHaveLength(0);
        expect(observations).not.toContainEqual({ requestedTier: "ultrafast", rejected: true });
      } else {
        expect(result.stopReason).toBe("stop");
        expect(transport.sdkRequests).toHaveLength(1);
        expect(transport.sdkRequests[0]?.service_tier).toBe("priority");
        expect(observations).toContainEqual({ requestedTier: "ultrafast", rejected: true });
      }
    },
  );

  it.each(["short", "none"] as const)(
    "preserves affinity policy and WebSocket acceptance with %s retention",
    async (cacheRetention) => {
      transport.responseBatches.push(reply("resp_accepted", "ok"));
      const acceptanceObserver = vi.fn();

      const result = await run(history(user("hello", 1)), {
        acceptanceObserver,
        cacheRetention,
        model: { ...model, compat: { sendSessionIdHeader: true } },
      });

      expect(result.stopReason).toBe("stop");
      expect(acceptanceObserver).toHaveBeenCalledWith({ kind: "provider_stream_opened" });
      expect(transport.wsOptions[0]?.headers?.session_id).toBe(
        cacheRetention === "short" ? "session-1" : undefined,
      );
      expect(transport.wsOptions[0]?.headers?.["x-client-request-id"]).toBe("session-1");
    },
  );

  it("preserves nonconflicting turn headers with an explicit OpenCode session", async () => {
    transport.responseBatches.push(reply("resp_accepted", "ok"));

    const result = await run(history(user("hello", 1)), {
      model: { ...model, headers: { "X-OpenCode-Session": "configured-session" } },
    });

    expect(result.stopReason).toBe("stop");
    expect(transport.wsOptions[0]?.headers).toMatchObject({
      "X-OpenCode-Session": "configured-session",
      "x-client-request-id": "session-1",
      "x-openclaw-session-id": "session-1",
      "x-provider-route": "route-a",
    });
  });

  it("closes the WebSocket when acceptance observation fails", async () => {
    transport.responseBatches.push(reply("resp_rejected", "ignored"));
    const hookError = new Error("acceptance observer failed");

    const result = await run(history(user("hello", 1)), {
      acceptanceObserver: () => {
        throw hookError;
      },
    });

    expect(result).toMatchObject({
      stopReason: "error",
      errorMessage: "acceptance observer failed",
    });
    expect(transport.closeCount).toBe(1);
  });

  it("continues a tool loop without treating synthetic missing results as provider output", async () => {
    transport.responseBatches.push(toolCallResponse("resp_tool"), reply("resp_answer", "done"));
    const firstUser = user("read the file", 1);
    const toolCall = await run(history(firstUser));
    const block = toolCall.content.find((item) => item.type === "toolCall");
    if (!block || block.type !== "toolCall") {
      throw new Error("Expected a tool call");
    }

    const answer = await run(
      history(firstUser, toolCall, {
        role: "toolResult",
        toolCallId: block.id,
        toolName: block.name,
        content: [{ type: "text", text: "file contents" }],
        isError: false,
        timestamp: 2,
      }),
    );

    expect(answer.stopReason).toBe("stop");
    expect(transport.wsOptions).toHaveLength(1);
    expect(transport.wsRequests[1]).toMatchObject({
      previous_response_id: "resp_tool",
      input: [{ type: "function_call_output", call_id: "call_read", output: "file contents" }],
    });
  });

  it("awaits the SSE response hook before start after a WebSocket fallback", async () => {
    transport.handshakeMessages.push({ type: "error", error: new Error("connect failed") });
    transport.sdkOutcomes.push(sdkCompletion("resp_sse"));
    const order: string[] = [];
    const { promise: hookPending, resolve: releaseHook } = Promise.withResolvers<void>();
    const onResponse = vi.fn(async () => {
      order.push("hook:start");
      await hookPending;
      order.push("hook:end");
    });
    const responseStream = await createStreamFn()(model, history(user("hello", 1)), {
      apiKey: "test-key",
      sessionId: "session-1",
      transport: "auto",
      onResponse,
    });
    const consume = (async () => {
      for await (const event of responseStream) {
        order.push(event.type);
      }
    })();

    await vi.waitFor(() => expect(onResponse).toHaveBeenCalledOnce());
    expect(order).toEqual(["hook:start"]);

    releaseHook();
    await consume;
    expect((await responseStream.result()).stopReason).toBe("stop");
    expect(order.slice(0, 3)).toEqual(["hook:start", "hook:end", "start"]);
  });

  it("skips repeated WebSocket setup during the provider degradation cooldown", async () => {
    transport.handshakeMessages.push({ type: "error", error: new Error("connect failed") });
    transport.sdkOutcomes.push(sdkCompletion("resp_sse_1"), sdkCompletion("resp_sse_2"));

    const first = await run(history(user("first", 1)));
    const second = await run(history(user("second", 2)));

    expect([first.stopReason, second.stopReason]).toEqual(["stop", "stop"]);
    expectCounts(0, 2, 1);
  });

  it.each([
    {
      code: "websocket_connection_limit_reached",
      param: undefined,
      compact: false,
      rejection: "safe rejection: websocket_connection_limit_reached",
    },
    {
      code: "unsupported_parameter",
      param: "previous_response_id",
      compact: false,
      rejection:
        "Previous response cannot be used for this organization due to Zero Data Retention.",
    },
    {
      code: "invalid_encrypted_content",
      param: "input[0].encrypted_content",
      compact: true,
      rejection: "compaction checkpoint could not be decrypted",
    },
  ])("recovers $code over full-history SSE", async ({ code, param, compact, rejection }) => {
    const options = compact ? { transport: "websocket" as const } : {};
    const onCompactionRejected = vi.fn();
    transport.responseBatches.push(
      reply(
        "resp_1",
        compact
          ? [
              {
                type: "compaction",
                id: "cmp_rejected",
                encrypted_content: "opaque-rejected-compaction",
              },
            ]
          : "first answer",
      ),
      rejectionBatch(code, rejection, param),
      reply("resp_3", compact ? undefined : "third answer"),
    );
    transport.sdkOutcomes.push(sdkCompletion("resp_sse"));
    const firstUser = user(compact ? "full history before compaction" : "first question", 1);
    const first = await run(history(firstUser), options);
    if (compact) {
      expect(first.providerReplay).toMatchObject({ type: "openai-responses-compaction" });
      transport.wsRequests.length = 0;
    }
    const secondUser = user(compact ? "continue after compaction" : "second question", 2);
    const context = history(firstUser, first, secondUser);
    const observations: ResponsesPromptObservation[] = [];
    const second = await run(context, {
      ...options,
      observations,
      ...(compact ? { onCompactionRejected } : {}),
    });
    expect(second.stopReason).toBe("stop");
    expect(transport.sdkRequests).toHaveLength(1);
    if (compact) {
      expect(second.providerReplay).toMatchObject({
        type: "openai-responses-compaction-suppression",
        data: "rejected",
      });
      expect(onCompactionRejected).toHaveBeenCalledOnce();
      const checkpointInput = JSON.stringify(transport.wsRequests[0]?.input);
      const fullInput = JSON.stringify(transport.sdkRequests[0]?.input);
      expect(checkpointInput).toContain('"type":"compaction"');
      expect(checkpointInput).not.toContain("full history before compaction");
      expect(fullInput).not.toContain('"type":"compaction"');
      expect(fullInput).toContain("full history before compaction");
    } else {
      expect(transport.wsRequests[1]).toMatchObject({
        previous_response_id: "resp_1",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "second question" }],
          },
        ],
      });
      expect(transport.closeCount).toBe(1);
      expect(transport.sdkRequests[0]).not.toHaveProperty("previous_response_id");
      expect(transport.sdkRequests[0]?.input).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: "user" }),
          expect.objectContaining({ role: "assistant" }),
          expect.objectContaining({ role: "user" }),
        ]),
      );
    }
    const third = await run(
      history(...context.messages, second, user(compact ? "continue again" : "third question", 3)),
      { ...options, ...(compact ? { observations } : {}) },
    );
    expect(third.stopReason).toBe("stop");
    if (compact) {
      expect(transport.wsRequests).toHaveLength(2);
      expect(transport.sdkRequests).toHaveLength(1);
      expect(JSON.stringify(transport.wsRequests[1]?.input)).not.toContain('"type":"compaction"');
    } else {
      expectCounts(3, 1, 2);
    }
    expect(promptPaths(observations)).toEqual([
      { egress: "responses-websocket", payloadVariant: "initial" },
      {
        egress: "responses-sdk",
        payloadVariant: compact ? "compaction-stripped" : "continuation-rejected",
      },
      ...(compact ? [{ egress: "responses-websocket", payloadVariant: "initial" }] : []),
    ]);
  });

  it("preserves the wrapped server error details and original SDK cause", async () => {
    const cause = wrappedSdkServerError({
      code: "previous_response_not_found",
      message: "previous response missing",
      param: "previous_response_id",
    });
    transport.responseBatches.push([{ type: "error", error: cause }]);
    const response = createSocketStream({
      client: createClient(model, "test-key", {}),
      request: { model: model.id, input: [] },
      mode: "websocket",
    });

    let error: unknown;
    try {
      for await (const event of response.stream) {
        void event;
      }
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(OpenAIResponsesWebSocketSafeRetryError);
    expect(error).toMatchObject({
      code: "previous_response_not_found",
      message: "previous response missing",
      param: "previous_response_id",
      status: 400,
    });
    expect((error as Error).cause).toBe(cause);
    expect(transport.closeCount).toBe(1);
  });

  it.each([
    ["invalid_websocket_request", "request may have been dispatched", AMBIGUOUS_DISPATCH],
    ["connection-close", "", AMBIGUOUS_DISPATCH],
    [
      "thinking_signature_invalid",
      "thinking signature was rejected without replayable reasoning",
      "thinking_signature_invalid",
    ],
  ])(
    "does not replay over SSE after a post-dispatch %s without compaction",
    async (code, text, expectedCode) => {
      transport.responseBatches.push(
        code === "connection-close"
          ? [{ type: "close", code: 1006 }]
          : rejectionBatch(code, text, "input"),
      );

      const result = await run(history(user("hello", 1)));

      expect(result).toMatchObject({ stopReason: "error", errorCode: expectedCode });
      expectCounts(1, 0);
      if (code === "connection-close") {
        expect(isRetryableAssistantError(result)).toBe(false);
      }
    },
  );

  it("applies the request timeout after dispatch without falling back", async () => {
    transport.responseBatches.push([{ type: "delay", ms: 25 }]);

    const result = await run(history(user("hello", 1)), { timeoutMs: 5 });

    expect(result.stopReason).toBe("error");
    expectCounts(1, 0);
    expect(transport.closeCount).toBe(1);

    transport.sdkOutcomes.push(sdkCompletion("resp_sse"));
    const next = await run(history(user("next", 2)));
    expect(next.stopReason).toBe("stop");
    expect(transport.wsOptions).toHaveLength(1);
    expect(transport.sdkRequests).toHaveLength(1);
  });

  it("preserves failed terminal semantics across WebSocket and SSE without degradation", async () => {
    const failedEvent = {
      type: "response.failed",
      response: {
        id: "resp_failed",
        status: "failed",
        model: "gpt-5.6-luna-2026-08-01",
        service_tier: "priority",
        error: { code: "server_error", message: "503 temporary provider response" },
        output: [],
        usage: {
          input_tokens: 21,
          output_tokens: 4,
          total_tokens: 25,
          input_tokens_details: { cached_tokens: 6, cache_write_tokens: 2 },
          output_tokens_details: { reasoning_tokens: 3 },
        },
      },
    };
    const pricedModel = {
      ...model,
      cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
    } satisfies Model<"openai-responses">;
    transport.responseBatches.push([message(failedEvent)], reply("resp_next"));
    transport.sdkOutcomes.push(sdkEvent(failedEvent));

    const websocket = await run(history(user("websocket", 1)), { model: pricedModel });
    const sse = await run(history(user("sse", 2)), { model: pricedModel, transport: "sse" });

    const terminalFacts = {
      provider: "openai",
      stopReason: "error",
      errorMessage: "server_error: 503 temporary provider response",
      errorCode: "server_error",
      responseId: "resp_failed",
      responseModel: "gpt-5.6-luna-2026-08-01",
      usage: {
        input: 13,
        output: 4,
        cacheRead: 6,
        cacheWrite: 2,
        reasoningTokens: 3,
        totalTokens: 25,
      },
    };
    expect(websocket).toMatchObject(terminalFacts);
    expect(sse).toMatchObject(terminalFacts);
    expect(websocket.usage.cost.total).toBeCloseTo(0.000401, 10);
    expect(sse.usage.cost.total).toBeCloseTo(0.000401, 10);
    const classifyFailoverReason = vi.fn(() => undefined);
    const pluginRegistry = createEmptyPluginRegistry();
    pluginRegistry.providers.push({
      pluginId: "openai",
      source: "test",
      provider: { id: "openai", label: "OpenAI fixture", auth: [], classifyFailoverReason },
    });
    withPluginRuntimeGenerationScope(
      {
        metadataSnapshot: createPluginMetadataSnapshot({
          manifestRegistry: makeRegistry([{ id: "openai", channels: [], providers: ["openai"] }]),
        }),
        pluginRegistry,
      },
      () => {
        expect(isRetryableAssistantError(websocket)).toBe(true);
        expect(isRetryableAssistantError(sse)).toBe(true);
      },
    );
    const expectedProviderSignal = {
      provider: "openai",
      code: "server_error",
      errorMessage: terminalFacts.errorMessage,
      errorType: undefined,
      status: undefined,
    };
    expect(classifyFailoverReason.mock.calls).toEqual([
      [expectedProviderSignal],
      [expectedProviderSignal],
    ]);

    const next = await run(history(user("next", 3)), { model: pricedModel });
    expect(next.stopReason).toBe("stop");
    expectCounts(2, 1, 2);
    expect(transport.wsRequests[1]).not.toHaveProperty("previous_response_id");
  });

  it.each(["custom endpoint", "host-managed proxy and TLS"])(
    "keeps %s on guarded SSE",
    async (route) => {
      const requestModel =
        route === "custom endpoint"
          ? { ...model, baseUrl: "https://compatible.example/v1" }
          : model;
      if (route !== "custom endpoint") {
        configureAiTransportHost({ ...getAiTransportHost(), requiresManagedTransport: () => true });
      }
      transport.sdkOutcomes.push(sdkCompletion("resp_sse"));
      const result = await run(history(user("hello", 1)), { model: requestModel });
      expect(result.stopReason).toBe("stop");
      expect(transport.wsClients).toEqual([]);
      expect(transport.sdkRequests).toHaveLength(1);
    },
  );
});
