import { AsyncLocalStorage } from "node:async_hooks";
import { createServer, type Server } from "node:http";
import type { AssistantMessage } from "@openclaw/llm-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { makeUserMessage } from "../../../../test/helpers/user-message.js";
import {
  configureAiTransportHost,
  getAiTransportHost,
  type AiInlineContentBlock,
} from "../host.js";
import { anthropicServerSideFallbackCases } from "../providers/anthropic-server-fallback.test-support.js";
import { createZeroUsage } from "../usage.test-support.js";
import { onLlmRequestActivity } from "../utils/llm-request-activity.js";
import type { AnthropicTransportOptions } from "./anthropic-transport-options.js";
import {
  anthropicContentBlockDelta,
  anthropicContentBlockStart,
  anthropicMessageDelta,
  anthropicMessageStart,
  createSseResponse,
  installAnthropicTransportTestHost,
  makeAnthropicTransportModel,
  serializeSseEvents,
  type AnthropicMessagesModel,
} from "./anthropic-transport-stream.test-support.js";
import { withProviderAcceptanceObserver } from "./transport-stream-shared.js";

const { buildGuardedModelFetchMock, guardedFetchMock } = vi.hoisted(() => ({
  buildGuardedModelFetchMock: vi.fn(),
  guardedFetchMock: vi.fn(),
}));

const coreTransportHost = getAiTransportHost();

function configureTestAnthropicImageNormalizer(): void {
  configureAiTransportHost({
    ...getAiTransportHost(),
    normalizeAnthropicInlineContentBlocks: async (content) =>
      content.map((block) =>
        block.type === "image" ? { ...block, mimeType: "image/jpeg" } : block,
      ),
  });
}

let createAnthropicMessagesTransportStreamFn: typeof import("./anthropic-transport-stream.js").createAnthropicMessagesTransportStreamFn;

type AnthropicStreamFn = ReturnType<typeof createAnthropicMessagesTransportStreamFn>;
type AnthropicStreamContext = Parameters<AnthropicStreamFn>[1];
type AnthropicStreamOptions = NonNullable<Parameters<AnthropicStreamFn>[2]> &
  AnthropicTransportOptions;

function mockSse(events: Record<string, unknown>[]): void {
  guardedFetchMock.mockResolvedValueOnce(createSseResponse(events));
}

const text = (value: string) => ({ type: "text" as const, text: value });
const thinking = (value: string, thinkingSignature: string) => ({
  type: "thinking" as const,
  thinking: value,
  thinkingSignature,
});
const toolBlock = (id: string, name: string, args: Record<string, unknown>) => ({
  type: "toolCall" as const,
  id,
  name,
  arguments: args,
});
const tool = (name: string, parameters: Record<string, unknown>, description = name) => ({
  name,
  description,
  parameters,
});
const deployment = (canonicalModelId: string, overrides: Partial<AnthropicMessagesModel> = {}) => ({
  id: "production-claude",
  name: "Production Claude",
  params: { canonicalModelId },
  reasoning: false,
  maxTokens: 8192,
  ...overrides,
});

function startMessage(id: string, input: number, model?: string) {
  return anthropicMessageStart({
    id,
    usage: { input_tokens: input, output_tokens: 0 },
    ...(model === undefined ? {} : { model }),
  });
}
function endMessage(stop_reason: string, input: number, output: number) {
  return anthropicMessageDelta({ stop_reason }, { input_tokens: input, output_tokens: output });
}
function startTool(index: number, id: string, name: string, input: Record<string, unknown>) {
  return anthropicContentBlockStart(index, { type: "tool_use", id, name, input });
}
const blockStop = (index: number) => ({ type: "content_block_stop", index });
const textDelta = (index: number, value: string) =>
  anthropicContentBlockDelta(index, { type: "text_delta", text: value });
const signatureDelta = (index: number, signature: string) =>
  anthropicContentBlockDelta(index, { type: "signature_delta", signature });
const jsonDelta = (index: number, partial_json: string) =>
  anthropicContentBlockDelta(index, { type: "input_json_delta", partial_json });
const thinkingStart = (index: number, value: string, signature: string) =>
  anthropicContentBlockStart(index, { type: "thinking", thinking: value, signature });

function createInterruptedThinkingEvents(): Record<string, unknown>[] {
  return [
    startMessage("msg_1", 6),
    thinkingStart(0, "step by step", ""),
    signatureDelta(0, "partial-signature"),
  ];
}

function createOpenRawSseResponse(params: {
  body: string;
  onCancel: (reason: unknown) => void | Promise<void>;
}): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(params.body));
    },
    cancel(reason) {
      return params.onCancel(reason);
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function latestAnthropicRequest() {
  const [, init] = guardedFetchMock.mock.calls.at(-1) ?? [];
  const body = init?.body;
  return {
    init,
    payload: typeof body === "string" ? (JSON.parse(body) as Record<string, unknown>) : {},
  };
}

function latestAnthropicRequestHeaders() {
  return new Headers(latestAnthropicRequest().init?.headers);
}

function guardedFetchCall(
  callIndex = 0,
): [unknown, { method?: unknown; headers?: HeadersInit } | undefined] {
  const call = guardedFetchMock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`expected guarded fetch call ${callIndex + 1}`);
  }
  return call as [unknown, { method?: unknown; headers?: HeadersInit } | undefined];
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected ${label}`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Expected ${label}`);
  }
  return value;
}

function findRecord(items: unknown, predicate: (record: Record<string, unknown>) => boolean) {
  for (const item of requireArray(items, "items")) {
    const record = requireRecord(item, "item");
    if (predicate(record)) {
      return record;
    }
  }
  throw new Error("Expected matching record");
}

function latestAnthropicUserMessage() {
  return findRecord(latestAnthropicRequest().payload.messages, (record) => record.role === "user");
}

function makeAnthropicToolUseMessage(
  content: AssistantMessage["content"],
  model: Pick<AnthropicMessagesModel, "id" | "provider"> = makeAnthropicTransportModel(),
): AssistantMessage {
  return {
    role: "assistant",
    provider: model.provider,
    api: "anthropic-messages",
    model: model.id,
    stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
    timestamp: 0,
    usage: createZeroUsage(),
    content,
  };
}

function makeSonnet5PrefillContext(): AnthropicStreamContext {
  return {
    messages: [
      { role: "user", content: "Return JSON." },
      {
        ...makeAnthropicToolUseMessage([text("{")]),
        model: "claude-sonnet-5",
        timestamp: 1,
      },
    ],
    tools: [tool("lookup", { type: "object" }, "Lookup")],
  } as AnthropicStreamContext;
}

async function startTransportStream(
  model: AnthropicMessagesModel = makeAnthropicTransportModel(),
  context: AnthropicStreamContext = { messages: [makeUserMessage("hello", 0)] },
  options: AnthropicStreamOptions = { apiKey: "sk-ant-api" },
) {
  return createAnthropicMessagesTransportStreamFn()(model, context, options);
}

async function runTransportStream(...args: Parameters<typeof startTransportStream>) {
  return (await startTransportStream(...args)).result();
}

async function consumeTransportStream(...args: Parameters<typeof startTransportStream>) {
  const stream = await startTransportStream(...args);
  const events = [];
  for await (const event of stream) {
    events.push(event);
  }
  return { events, eventTypes: events.map((event) => event.type), result: await stream.result() };
}

describe("anthropic transport stream", () => {
  beforeAll(async () => {
    ({ createAnthropicMessagesTransportStreamFn } =
      await import("./anthropic-transport-stream.js"));
  });

  beforeEach(() => {
    installAnthropicTransportTestHost({
      coreTransportHost,
      buildModelFetch: buildGuardedModelFetchMock,
      guardedFetch: guardedFetchMock,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(() => {
    configureAiTransportHost(coreTransportHost);
  });

  it.each<{
    name: string;
    model: Partial<AnthropicMessagesModel>;
    options: AnthropicStreamOptions;
    headers: Record<string, string | null>;
    guarded?: boolean;
  }>([
    {
      name: "guarded API-key transport",
      model: { headers: { "user-agent": "configured-client/1.0", "X-Provider": "anthropic" } },
      options: {
        apiKey: "sk-ant-api",
        headers: { "User-Agent": "openclaw/2026.9.1", "X-Call": "1" },
        stop: ["User:", "Assistant:"],
      },
      headers: {
        "x-api-key": "sk-ant-api",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        accept: "application/json",
        "anthropic-dangerous-direct-browser-access": "true",
        "user-agent": "openclaw/2026.9.1",
        "X-Provider": "anthropic",
        "X-Call": "1",
        "anthropic-beta": "fine-grained-tool-streaming-2025-05-14",
      },
      guarded: true,
    },
    {
      name: "Foundry bearer auth without stale API-key headers",
      model: {
        provider: "microsoft-foundry",
        baseUrl: "https://example.services.ai.azure.com/anthropic",
        authHeader: true,
        headers: {
          "api-key": "stale-foundry-key",
          "x-api-key": "stale-resource-key",
          "X-Provider": "foundry",
        },
      },
      options: { apiKey: "entra-access-token" },
      headers: {
        authorization: "Bearer entra-access-token",
        "api-key": null,
        "x-api-key": null,
        "X-Provider": "foundry",
      },
    },
    {
      name: "compatible OAuth endpoint without implicit beta headers",
      model: { provider: "anthropic", baseUrl: "https://custom-proxy.example" },
      options: { apiKey: "sk-ant-oat-token" },
      headers: { authorization: "Bearer sk-ant-oat-token", "anthropic-beta": null },
    },
  ])("uses $name", async ({ model: overrides, options, headers, guarded }) => {
    const model = {
      ...makeAnthropicTransportModel(overrides),
      ...(guarded
        ? {
            [Symbol.for("openclaw.modelProviderRequestTransport")]: {
              proxy: { mode: "explicit-proxy", url: "http://proxy.example:8443" },
              tls: { ca: "synthetic-ca-pem" },
            },
          }
        : {}),
    };
    await runTransportStream(model, undefined, options);
    for (const [name, value] of Object.entries(headers)) {
      expect(latestAnthropicRequestHeaders().get(name)).toBe(value);
    }
    if (guarded) {
      expect(buildGuardedModelFetchMock).toHaveBeenCalledWith(model);
      const [url, init] = guardedFetchCall();
      expect(url).toBe("https://api.anthropic.com/v1/messages");
      expect(init?.method).toBe("POST");
      expect(latestAnthropicRequest().payload).toMatchObject({
        model: "claude-sonnet-4-6",
        stream: true,
        stop_sequences: ["User:", "Assistant:"],
      });
    }
  });

  it.each(
    anthropicServerSideFallbackCases.filter(
      ({ name }) => name === "Claude Sonnet 5.5" || name === "Opus 5.5 with model betas",
    ),
  )(
    "sends default server-side fallback params for direct $name API-key requests",
    async ({ optionHeaders, customBeta, ...model }) => {
      mockSse([startMessage("msg_fb", 1), endMessage("end_turn", 1, 1), { type: "message_stop" }]);

      await runTransportStream(makeAnthropicTransportModel(model), undefined, {
        apiKey: "sk-ant-api",
        headers: optionHeaders,
      } as AnthropicStreamOptions);

      expect(latestAnthropicRequest().payload.fallbacks).toBe("default");
      expect(latestAnthropicRequestHeaders().get("anthropic-beta")).toBe(
        `${customBeta ? "files-api-2025-04-14" : "fine-grained-tool-streaming-2025-05-14"},server-side-fallback-2026-07-01,thinking-binding-controls-2026-08-01`,
      );
    },
  );

  it.each([
    {
      label: "OAuth requests",
      apiKey: "sk-ant-oat01-synthetic",
      baseUrl: "https://api.anthropic.com",
    },
    {
      label: "custom proxy endpoints",
      apiKey: "sk-ant-api",
      baseUrl: "https://proxy.example.com/v1",
    },
  ])("omits server-side fallback params for $label", async ({ apiKey, baseUrl }) => {
    const result = await runTransportStream(
      makeAnthropicTransportModel({ ...anthropicServerSideFallbackCases[0], baseUrl }),
      undefined,
      { apiKey },
    );

    expect(result.stopReason).toBe("stop");
    expect(guardedFetchMock).toHaveBeenCalledOnce();
    expect(latestAnthropicRequest().payload).not.toHaveProperty("fallbacks");
    expect(latestAnthropicRequestHeaders().get("anthropic-beta") ?? "").not.toContain(
      "server-side-fallback",
    );
  });

  it("rebuilds Fable output at a mid-stream server-side fallback boundary", async () => {
    mockSse([
      startMessage("msg_fb", 5, "claude-fable-5"),
      anthropicContentBlockStart(0, { type: "thinking", thinking: "" }),
      anthropicContentBlockDelta(0, {
        type: "thinking_delta",
        thinking: "pre-boundary reasoning",
      }),
      blockStop(0),
      anthropicContentBlockStart(1, text("partial ")),
      blockStop(1),
      startTool(2, "call_1", "lookup", {}),
      blockStop(2),
      anthropicContentBlockStart(3, {
        type: "fallback",
        from: { model: "claude-fable-5" },
        to: { model: "claude-opus-4-8" },
      }),
      blockStop(3),
      anthropicContentBlockStart(4, text("")),
      textDelta(4, "continued"),
      blockStop(4),
      endMessage("end_turn", 5, 9),
      { type: "message_stop" },
    ]);

    const model = makeAnthropicTransportModel({ id: "claude-fable-5", name: "Claude Fable 5" });
    model.cost = { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 };
    const result = await runTransportStream(model);

    expect(result.stopReason).toBe("stop");
    expect(result.content).toEqual([text("partial "), text("continued")]);
    expect(result.responseModel).toBe("claude-opus-4-8");
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        type: "provider_fallback",
        details: {
          provider: "anthropic",
          fromModel: "claude-fable-5",
          toModel: "claude-opus-4-8",
        },
      }),
    ]);
    expect(result.usage.cost.total).toBeCloseTo(0.00025, 10);
  });

  it("preserves HTTP status and Retry-After in Anthropic error messages", async () => {
    guardedFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          type: "error",
          error: {
            type: "rate_limit_error",
            message: "Number of request tokens exceeded the per-minute rate limit.",
          },
        }),
        {
          status: 429,
          headers: { "retry-after": "30" },
        },
      ),
    );

    const acceptanceObserver = vi.fn();
    const onResponse = vi.fn();
    const options = withProviderAcceptanceObserver(
      { apiKey: "test-api-key", onResponse } as AnthropicStreamOptions,
      acceptanceObserver,
    );
    const result = await runTransportStream(makeAnthropicTransportModel(), undefined, options);

    expect(result).toMatchObject({ stopReason: "error", errorCode: "429" });
    expect(result.errorMessage).toMatch(/^429: .*; Retry-After: 30 seconds$/);
    expect(JSON.parse(result.errorBody ?? "null")).toEqual({
      type: "error",
      error: {
        type: "rate_limit_error",
        message: "Number of request tokens exceeded the per-minute rate limit.",
      },
    });
    expect(acceptanceObserver).not.toHaveBeenCalled();
    expect(onResponse).toHaveBeenCalledWith(
      { status: 429, headers: expect.objectContaining({ "retry-after": "30" }) },
      expect.objectContaining({ provider: "anthropic" }),
    );
  });

  it("bounds streamed Anthropic error responses without content-length", async () => {
    const encoder = new TextEncoder();
    let pullCount = 0;
    let cancelCount = 0;
    guardedFetchMock.mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pullCount += 1;
            if (pullCount === 1) {
              controller.enqueue(encoder.encode("x".repeat(8 * 1024)));
              return;
            }
            controller.enqueue(encoder.encode("y"));
          },
          cancel() {
            cancelCount += 1;
          },
        }),
        { status: 500 },
      ),
    );

    const result = await runTransportStream();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe(`500: ${"x".repeat(400)}…`);
    expect(pullCount).toBeGreaterThanOrEqual(2);
    expect(cancelCount).toBe(1);
  });

  it("preserves nested Anthropic proxy rejection details beyond the preview limit", async () => {
    const message = "A maximum of 4 blocks with cache_control may be provided. Found 5.";
    const credential = "synthetic-proxy-credential";
    const media = "c3ludGhldGljLXByaXZhdGUtaW1hZ2U=";
    const body = {
      error: {
        message: "All target providers failed.",
        attempts: Array.from({ length: 4 }, (_, index) => ({
          status: 400,
          details: {
            type: "error",
            error: { type: "invalid_request_error", message },
            request_id: `req_synthetic_${index}`,
          },
          request: {
            headers: { authorization: `Bearer ${credential}`, api_key: credential },
            image: { type: "image", data: media },
          },
        })),
      },
    };
    guardedFetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 400 }));

    const result = await runTransportStream(
      makeAnthropicTransportModel({ id: "claude-sonnet-4-5" }),
      undefined,
      { apiKey: "test-api-key" } as AnthropicStreamOptions,
    );

    expect(result).toMatchObject({ stopReason: "error", errorCode: "400" });
    expect(result.errorMessage).toContain(message);
    expect(JSON.parse(result.errorMessage?.slice("400: ".length) ?? "null")).toMatchObject({
      error: {
        message: "All target providers failed.",
        attempts: body.error.attempts.map(({ status, details }) => ({ status, details })),
      },
    });
    expect(result.errorBody?.length).toBeLessThanOrEqual(515);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(credential);
    expect(serialized).not.toContain(media);
    expect(serialized).not.toContain("Malformed diagnostic JSON");
  });

  it("retains Anthropic HTTP status when an oversized JSON error body must be redacted", async () => {
    guardedFetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: "x".repeat(9 * 1024) } }), {
        status: 400,
      }),
    );

    const result = await runTransportStream(
      makeAnthropicTransportModel({ id: "claude-sonnet-4-5" }),
      undefined,
      { apiKey: "test-api-key" } as AnthropicStreamOptions,
    );

    expect(result).toMatchObject({ stopReason: "error", errorCode: "400" });
    expect(result.errorMessage).toContain("400");
    expect(result.errorMessage).not.toContain("x".repeat(400));
  });

  it("aborts stalled streamed Anthropic error responses", async () => {
    vi.useFakeTimers();
    const encoder = new TextEncoder();
    let cancelReason: unknown;
    guardedFetchMock.mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode("partial failure detail"));
          },
          cancel(reason) {
            cancelReason = reason;
          },
        }),
        { status: 500 },
      ),
    );

    const resultPromise = runTransportStream();

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await resultPromise;

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe(
      "500: Anthropic Messages error response stalled: no data received for 10000ms",
    );
    expect(cancelReason).toBeInstanceOf(Error);
    expect((cancelReason as Error).message).toBe(
      "Anthropic Messages error response stalled: no data received for 10000ms",
    );
  });

  it("rejects oversized Anthropic SSE frames before buffering without bound", async () => {
    const encoder = new TextEncoder();
    let cancelCalled = false;
    guardedFetchMock.mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          start(streamController) {
            streamController.enqueue(encoder.encode("x".repeat(16 * 1024 * 1024 + 1)));
          },
          cancel() {
            cancelCalled = true;
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
    );

    const result = await runTransportStream();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe(
      "Anthropic Messages SSE response exceeded max pending buffer size (16777216 chars) without event boundary",
    );
    expect(cancelCalled).toBe(true);
  });

  it("resolves an environment endpoint for an empty model base URL", async () => {
    const endpoint = "https://anthropic-proxy.example/v1";
    vi.stubEnv("ANTHROPIC_BASE_URL", ` ${endpoint} `);
    await runTransportStream(makeAnthropicTransportModel({ baseUrl: "" }));
    expect(guardedFetchCall()[0]).toBe(`${endpoint}/messages`);
    expect(buildGuardedModelFetchMock.mock.calls[0]?.[0]).toMatchObject({ baseUrl: endpoint });
    expect(latestAnthropicRequest().payload.model).toBe("claude-sonnet-4-6");
    expect(latestAnthropicRequestHeaders().get("anthropic-beta")).toBeNull();
  });

  it.each([
    {
      label: "defaults missing catalog limits",
      maxTokens: undefined,
      contextWindow: 200_000,
      expected: 4_096,
    },
    {
      label: "rejects an invalid catalog limit",
      maxTokens: 0,
      contextWindow: 4_096,
      expected: undefined,
    },
  ])("$label", async ({ maxTokens, contextWindow, expected }) => {
    const model = makeAnthropicTransportModel({
      id: "custom-model",
      provider: "custom-anthropic",
      baseUrl: "https://custom.example/anthropic",
      reasoning: false,
      contextWindow,
      ...(maxTokens === undefined ? {} : { maxTokens }),
    });
    if (maxTokens === undefined) {
      Reflect.deleteProperty(model, "maxTokens");
    }
    const result = await runTransportStream(model, undefined, { apiKey: "fake" });
    if (expected === undefined) {
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toContain(
        "Anthropic Messages transport requires a positive maxTokens value",
      );
      expect(guardedFetchMock).not.toHaveBeenCalled();
    } else {
      expect(result.stopReason).toBe("stop");
      expect(latestAnthropicRequest().payload).toMatchObject({
        model: model.id,
        max_tokens: expected,
        stream: true,
      });
    }
  });

  it("reports every parsed Anthropic event as request activity", async () => {
    const events = [
      anthropicMessageStart({ id: "msg_activity", usage: {} }),
      { type: "ping" },
      { type: "message_stop" },
    ];
    guardedFetchMock.mockResolvedValueOnce(createSseResponse(events));
    const controller = new AbortController();
    const onActivity = vi.fn();
    const unsubscribe = onLlmRequestActivity(controller.signal, onActivity);

    try {
      await runTransportStream(makeAnthropicTransportModel(), undefined, {
        apiKey: "sk-ant-api",
        signal: controller.signal,
      } as AnthropicStreamOptions);
    } finally {
      unsubscribe();
    }

    expect(onActivity).toHaveBeenCalledTimes(events.length);
  });

  it.each([["claude-fable-5", "Claude Fable 5", "anthropic"]])(
    "surfaces structured %s streaming refusals for %s",
    async (id, name, provider) => {
      mockSse([
        startMessage("msg_refusal", 3),
        anthropicContentBlockStart(0, text("")),
        textDelta(0, "discard this partial output"),
        blockStop(0),
        anthropicMessageDelta(
          {
            stop_reason: "refusal",
            stop_details: {
              type: "refusal",
              category: "bio",
              explanation: "This request is not allowed.",
            },
          },
          { input_tokens: 3, output_tokens: 2 },
        ),
        { type: "message_stop" },
      ]);

      const { eventTypes, result } = await consumeTransportStream(
        makeAnthropicTransportModel({
          id,
          name,
          provider,
        }),
      );
      expect(eventTypes).toEqual(["error"]);
      expect(result.stopReason).toBe("error");
      expect(result.content).toEqual([]);
      expect(result.errorMessage).toBe(
        "Anthropic refusal (category: bio): This request is not allowed.",
      );
      expect(result.usage).toMatchObject({ input: 3, output: 2 });
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          type: "provider_refusal",
          details: {
            provider,
            category: "bio",
            explanation: "This request is not allowed.",
          },
        }),
      ]);
    },
  );

  it.each([
    {
      name: "buffered output without terminal status",
      model: { id: "claude-fable-5", name: "Claude Fable 5" },
      events: [
        anthropicContentBlockStart(0, { type: "text", text: "" }),
        anthropicContentBlockDelta(0, { type: "text_delta", text: "unsafe partial output" }),
      ],
      buffered: true,
      unsealed: false,
    },
    {
      name: "ordinary output without message_stop",
      model: {},
      events: [
        anthropicMessageStart({ id: "msg_partial", usage: { input_tokens: 3, output_tokens: 0 } }),
        anthropicContentBlockStart(0, { type: "text", text: "" }),
        anthropicContentBlockDelta(0, { type: "text_delta", text: "truncated answer" }),
        { type: "content_block_stop", index: 0 },
        anthropicMessageDelta({ stop_reason: "end_turn" }, { input_tokens: 3, output_tokens: 2 }),
      ],
      buffered: false,
      unsealed: false,
    },
    {
      name: "active tool call without content_block_stop",
      model: {},
      events: [
        startMessage("msg_unsealed", 2),
        startTool(0, "call_unsealed", "read", {}),
        jsonDelta(0, '{"path":"README.md"'),
        endMessage("tool_use", 2, 1),
        { type: "message_stop" },
      ],
      buffered: false,
      unsealed: true,
    },
  ])("rejects $name", async ({ model, events, buffered, unsealed }) => {
    mockSse(events);
    const { eventTypes, result } = await consumeTransportStream(makeAnthropicTransportModel(model));
    expect(result.stopReason).toBe("error");
    expect(eventTypes.at(-1)).toBe("error");
    expect(eventTypes).not.toContain("done");
    if (unsealed) {
      expect(eventTypes).not.toContain("toolcall_end");
      expect(result.content.some((block) => block.type === "toolCall")).toBe(false);
    } else {
      expect(result.errorMessage).toBe("Anthropic stream ended before message_stop");
    }
    if (buffered) {
      expect(eventTypes).toEqual(["error"]);
      expect(result.content).toEqual([]);
    }
  });

  it("preserves a pre-tool text block without inferring a commentary phase", async () => {
    mockSse([
      startMessage("msg_defer", 5),
      anthropicContentBlockStart(0, text("")),
      textDelta(0, "I'll check the repo."),
      blockStop(0),
      startTool(1, "tool_1", "exec", {}),
      blockStop(1),
      endMessage("end_turn", 5, 7),
    ]);
    const stream = await startTransportStream();
    const order: string[] = [];
    const textSignatures: unknown[] = [];
    for await (const event of stream as AsyncIterable<{
      type: string;
      contentIndex?: number;
      partial?: { content?: Array<{ textSignature?: string }> };
    }>) {
      order.push(event.type);
      if (event.type === "text_end" || event.type === "toolcall_start") {
        textSignatures.push(event.partial?.content?.[0]?.textSignature);
      }
    }
    expect(textSignatures).toEqual([undefined, undefined]);
    expect((await stream.result()).content[0]).toEqual(text("I'll check the repo."));
    expect(order.filter((type) => type === "text_end")).toHaveLength(1);
    expect(order.indexOf("text_end")).toBeLessThan(order.indexOf("toolcall_start"));
  });

  it("refreshes streamed tool argument previews on geometric checkpoints instead of every delta", async () => {
    const argsJson = `{"content":"${"x".repeat(1150)}","to":1481220477346119781,"safe":42,"maxSafe":9007199254740991,"nested":{"ids":[9007199254740993,-9007199254740992]}}`;
    const chunks = Array.from({ length: Math.ceil(argsJson.length / 100) }, (_, index) =>
      argsJson.slice(index * 100, index * 100 + 100),
    );
    const gates = chunks.map(() => createDeferred());
    const events = [
      startMessage("msg_preview", 2),
      startTool(0, "call_preview", "write", {}),
      ...chunks.map((partial_json) => jsonDelta(0, partial_json)),
      blockStop(0),
      endMessage("tool_use", 2, 2),
      { type: "message_stop" },
    ];
    const encoder = new TextEncoder();
    let nextFrame = 0;
    guardedFetchMock.mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            const event = events[nextFrame];
            if (!event) {
              controller.close();
              return;
            }
            // Later frames must wait until the consumer snapshots mutable preview arguments.
            if (nextFrame > 2) {
              await gates[Math.min(nextFrame - 3, gates.length - 1)]?.promise;
            }
            controller.enqueue(encoder.encode(serializeSseEvents([event])));
            nextFrame++;
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
    );
    const stream = await startTransportStream();
    const previews: Array<Record<string, unknown>> = [];
    for await (const event of stream as AsyncIterable<{
      type: string;
      partial?: { content?: Array<{ type: string; arguments?: Record<string, unknown> }> };
    }>) {
      if (event.type !== "toolcall_delta") {
        continue;
      }
      const block = event.partial?.content?.find((entry) => entry.type === "toolCall");
      previews.push(structuredClone(block?.arguments ?? {}));
      gates[previews.length - 1]?.resolve();
    }
    const result = await stream.result();

    expect(previews.length).toBe(chunks.length);
    for (const snapshot of previews.slice(0, 5)) {
      expect(snapshot).toEqual({});
    }
    expect(previews[5]).not.toEqual({});
    expect(result.stopReason).toBe("toolUse");
    const toolCall = result.content.find((block) => block.type === "toolCall");
    expect(toolCall).toMatchObject({
      type: "toolCall",
      name: "write",
      arguments: {
        content: "x".repeat(1150),
        to: "1481220477346119781",
        safe: 42,
        maxSafe: 9007199254740991,
        nested: { ids: ["9007199254740993", "-9007199254740992"] },
      },
    });
  });

  it("preserves Anthropic OAuth identity and tool-name remapping through the transport", async () => {
    mockSse([
      startMessage("msg_1", 10),
      startTool(0, "tool_1", "Read", { path: "/tmp/a" }),
      blockStop(0),
      endMessage("tool_use", 10, 5),
      { type: "message_stop" },
    ]);
    const model = makeAnthropicTransportModel({});
    const result = await runTransportStream(
      model,
      {
        systemPrompt: "Follow policy.",
        messages: [{ role: "user", content: "Read the file" }],
        tools: [
          tool("Read", { type: "object", properties: false }),
          tool("read", {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          }),
        ],
      } as unknown as AnthropicStreamContext,
      {
        apiKey: "sk-ant-oat-example",
        toolChoice: { type: "tool", name: "read" },
      } as AnthropicStreamOptions,
    );
    const [url, init] = guardedFetchCall();
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer sk-ant-oat-example");
    expect(headers.get("x-app")).toBe("cli");
    expect(headers.get("anthropic-beta")).toBe(
      "claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14",
    );
    expect(headers.get("user-agent")).toContain("claude-cli/");
    const firstCallParams = latestAnthropicRequest().payload;
    const system = requireArray(firstCallParams.system, "system").map(
      (item) => requireRecord(item, "system item").text,
    );
    expect(system[0]).toBe(
      "x-anthropic-billing-header: cc_version=2.1.280; cc_entrypoint=sdk-cli;",
    );
    expect(system).toEqual(
      expect.arrayContaining([
        "You are Claude Code, Anthropic's official CLI for Claude.",
        "Follow policy.",
      ]),
    );
    expect(
      requireArray(firstCallParams.tools, "tools").map((item) => requireRecord(item, "tool").name),
    ).toEqual(["Read"]);
    expect(firstCallParams.tool_choice).toEqual({ type: "tool", name: "Read" });
    expect(result).toMatchObject({
      stopReason: "toolUse",
      content: expect.arrayContaining([
        expect.objectContaining({ type: "toolCall", name: "read" }),
      ]),
    });
  });

  it.each<{
    name: string;
    events: () => Record<string, unknown>[];
    content?: unknown[];
    textEvents?: string[];
  }>([
    {
      name: "preserves signed bytes and replaces only completed seed signatures",
      events: () => [
        startMessage("msg_1", 6),
        thinkingStart(0, `keep${String.fromCharCode(0xd83d)}signed`, "sig_1"),
        signatureDelta(0, "sig_2"),
        signatureDelta(0, "sig_3"),
        blockStop(0),
        thinkingStart(1, "seeded", "seed_signature"),
        anthropicContentBlockStart(2, text("NO_REPLY")),
        blockStop(2),
        blockStop(1),
        endMessage("end_turn", 6, 9),
      ],
      content: [
        expect.objectContaining(thinking(`keep${String.fromCharCode(0xd83d)}signed`, "sig_2sig_3")),
        thinking("seeded", "seed_signature"),
        text("NO_REPLY"),
      ],
      textEvents: ["NO_REPLY", "NO_REPLY"],
    },
    {
      name: "commits only stopped signatures across interleaved thinking blocks",
      events: () => [
        startMessage("msg_1", 6),
        thinkingStart(0, "first", ""),
        thinkingStart(1, "second", ""),
        signatureDelta(1, "complete-second"),
        signatureDelta(0, "partial-first"),
        blockStop(1),
      ],
      content: [
        expect.objectContaining(thinking("first", "")),
        expect.objectContaining(thinking("second", "complete-second")),
      ],
    },
  ])("$name", async ({ events, content, textEvents: expectedText }) => {
    guardedFetchMock.mockResolvedValueOnce(createSseResponse(events()));
    const stream = await startTransportStream();
    const textEvents: string[] = [];
    for await (const event of stream) {
      if (event.type === "text_delta") {
        textEvents.push(event.delta);
      } else if (event.type === "text_end") {
        textEvents.push(event.content);
      }
    }
    const result = await stream.result();
    if (content) {
      expect(result.content).toEqual(content);
    }
    if (expectedText) {
      expect(textEvents).toEqual(expectedText);
    }
  });

  it.each([
    {
      name: "OpenAI-style sidecars",
      native: false,
      events: [
        anthropicContentBlockDelta(0, { content: "", reasoning_content: "Need " }),
        anthropicContentBlockDelta(0, { content: "", reasoning_content: "context." }),
        anthropicContentBlockDelta(0, { content: "Visible answer.", reasoning_content: "" }),
        anthropicContentBlockDelta(0, { content: " Continued.", reasoning_content: null }),
      ],
      content: [thinking("Need context.", "reasoning_content"), text("Visible answer. Continued.")],
    },
    {
      name: "native text deltas with reasoning sidecars",
      native: true,
      events: [
        anthropicContentBlockStart(0, text("")),
        anthropicContentBlockDelta(0, {
          type: "text_delta",
          content: "Visible ",
          text: "Visible ",
          reasoning_content: "Need ",
        }),
        anthropicContentBlockDelta(0, { content: "answer", reasoning_content: null }),
        textDelta(0, "."),
      ],
      content: [text("Visible answer."), thinking("Need ", "reasoning_content")],
    },
  ])("preserves compatible $name", async ({ native, events, content }) => {
    mockSse([startMessage("msg_1", 6), ...events, blockStop(0), endMessage("end_turn", 6, 2)]);
    const model = makeAnthropicTransportModel({
      id: "mimo-v2.5",
      name: "MiMo V2.5",
      provider: "xiaomi-token-plan-ams",
      baseUrl: "https://token-plan-ams.xiaomimimo.com/anthropic",
    });
    const options: AnthropicStreamOptions = { apiKey: "sk-xiaomi-test", reasoning: "high" };
    const firstResult = await runTransportStream(model, undefined, options);
    expect(firstResult.content).toEqual(content);
    if (!native) {
      await runTransportStream(
        model,
        {
          messages: [
            { role: "user", content: "think", timestamp: 0 },
            { ...firstResult, timestamp: 0 },
            { role: "user", content: "continue", timestamp: 0 },
          ],
        },
        options,
      );
      const assistantMessage = findRecord(
        latestAnthropicRequest().payload.messages,
        (record) => record.role === "assistant",
      );
      expect(assistantMessage.reasoning_content).toBe("Need context.");
      expect(assistantMessage.content).toEqual([
        { type: "thinking", thinking: "Need context.", signature: "reasoning_content" },
        text("Visible answer. Continued."),
      ]);
    }
  });

  it("recovers orphan text deltas when an Anthropic-compatible provider omits block start", async () => {
    mockSse([
      startMessage("msg_1", 6),
      textDelta(0, "你好"),
      blockStop(0),
      endMessage("end_turn", 6, 1),
    ]);
    const { events, result } = await consumeTransportStream(
      makeAnthropicTransportModel({
        provider: "kimi-coding",
        baseUrl: "https://api.kimi.com/coding/",
      }),
      undefined,
      {
        apiKey: "kimi-key",
      } as AnthropicStreamOptions,
    );
    expect(result.content).toEqual([text("你好")]);
    expect(result.stopReason).toBe("stop");
    expect(events.some((event) => event.type === "text_start")).toBe(true);
    expect(events.some((event) => event.type === "text_delta" && event.delta === "你好")).toBe(
      true,
    );
    expect(events.some((event) => event.type === "text_end" && event.content === "你好")).toBe(
      true,
    );
  });

  it.each([false, true])("quarantines malformed schemas (valid sibling=%s)", async (withValid) => {
    const validSchema = {
      type: "object",
      properties: { query: { $ref: "#/$defs/Query" } },
      $defs: { Query: { type: "string", minLength: 1 } },
      required: ["query"],
      additionalProperties: false,
    };
    const result = await runTransportStream(
      makeAnthropicTransportModel(),
      {
        messages: [{ role: "user", content: "hello" }],
        tools: [
          tool("invalid_required_tool", { type: "object", required: "query" }),
          ...(withValid
            ? [
                {
                  name: "bad_plugin_tool",
                  description: "missing schema",
                  execute: async () => ({ content: [text("bad")] }),
                },
                tool("invalid_properties_tool", { type: "object", properties: false }),
                tool("good_plugin_tool", validSchema),
              ]
            : []),
        ],
      } as unknown as AnthropicStreamContext,
      { apiKey: "sk-ant-api", ...(!withValid ? { toolChoice: "auto" } : {}) },
    );

    if (!withValid) {
      expect(result.stopReason).toBe("stop");
      expect(latestAnthropicRequest().payload).not.toHaveProperty("tools");
      expect(latestAnthropicRequest().payload).not.toHaveProperty("tool_choice");
      return;
    }

    expect(latestAnthropicRequest().payload.tools).toEqual([
      expect.objectContaining({
        name: "good_plugin_tool",
        input_schema: {
          type: "object",
          properties: { query: { $ref: "#/$defs/Query" } },
          $defs: { Query: { type: "string", minLength: 1 } },
          required: ["query"],
          additionalProperties: false,
        },
      }),
    ]);
  });

  it.each([
    { invalidOriginal: false, error: 'Anthropic tool names "Read" and "read" both map to "Read"' },
    { invalidOriginal: true, error: 'Anthropic tool_choice requested unavailable tool "Read"' },
  ])(
    "rejects ambiguous OAuth tool names (skipped original=$invalidOriginal)",
    async ({ invalidOriginal, error }) => {
      const result = await runTransportStream(
        makeAnthropicTransportModel(),
        {
          messages: [makeUserMessage("hello", 0)],
          tools: [
            tool("Read", { type: "object", properties: invalidOriginal ? false : {} }),
            tool("read", { type: "object", properties: {} }),
          ],
        } as unknown as AnthropicStreamContext,
        {
          apiKey: "sk-ant-oat-example",
          ...(invalidOriginal ? { toolChoice: { type: "tool", name: "Read" } } : {}),
        },
      );
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toContain(error);
      expect(guardedFetchMock).not.toHaveBeenCalled();
    },
  );

  it("coerces replayed malformed tool-call args to an object for Anthropic payloads", async () => {
    const model = makeAnthropicTransportModel({});

    const stream = await startTransportStream(model, {
      messages: [
        {
          role: "assistant",
          provider: "openai",
          api: "openai-responses",
          model: "gpt-5.4",
          stopReason: "toolUse",
          timestamp: 0,
          content: [
            { type: "toolCall", id: "call_1", name: "lookup", arguments: "{not valid json" },
          ],
        },
      ],
    } as never);
    await stream.result();

    const firstCallParams = latestAnthropicRequest().payload;
    const assistantMessage = findRecord(
      firstCallParams.messages,
      (record) => record.role === "assistant",
    );
    const toolUse = findRecord(
      assistantMessage.content,
      (record) => record.type === "tool_use" && record.name === "lookup",
    );
    expect(toolUse.input).toEqual({});
  });

  it.each([false])(
    "replays empty signatures according to allowEmptySignature=%s",
    async (allowEmptySignature) => {
      await runTransportStream(
        makeAnthropicTransportModel({
          id: "k3",
          provider: "kimi",
          baseUrl: "https://api.kimi.com/coding",
          compat: { allowEmptySignature },
        }),
        {
          messages: [
            makeAnthropicToolUseMessage([thinking("Retained thought", "")], {
              provider: "kimi",
              id: "k3",
            }),
          ],
        },
        { apiKey: "synthetic-kimi-key", reasoning: "high" },
      );
      const assistant = findRecord(
        latestAnthropicRequest().payload.messages,
        (msg) => msg.role === "assistant",
      );
      expect(assistant.content).toEqual([text("Retained thought")]);
    },
  );

  it("omits completed thinking while preserving the active tool turn when thinking is disabled", async () => {
    await runTransportStream(makeAnthropicTransportModel(), {
      messages: [
        makeUserMessage("hello", 0),
        {
          ...makeAnthropicToolUseMessage([
            thinking("private reasoning", "sig_1"),
            {
              type: "thinking",
              thinking: "[Reasoning redacted]",
              thinkingSignature: "opaque_1",
              redacted: true,
            },
          ]),
          stopReason: "stop",
        },
        makeUserMessage("again", 1),
        {
          ...makeAnthropicToolUseMessage([
            thinking("Private replay text.", "reasoning_content"),
            text("Visible reply."),
          ]),
          stopReason: "stop",
        },
        makeUserMessage("look it up", 2),
        makeAnthropicToolUseMessage([
          thinking("call lookup", "sig_tool"),
          toolBlock("call_1", "lookup", {}),
        ]),
        {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "lookup",
          content: [text("42")],
          isError: false,
          timestamp: 3,
        },
      ],
    });
    const payload = latestAnthropicRequest().payload;
    const assistants = requireArray(payload.messages, "messages")
      .map((msg) => requireRecord(msg, "message"))
      .filter((msg) => msg.role === "assistant");
    expect(assistants.map((msg) => msg.content)).toEqual([
      [text("[assistant reasoning omitted]")],
      [text("Visible reply.")],
      [
        { type: "thinking", thinking: "call lookup", signature: "sig_tool" },
        { type: "tool_use", id: "call_1", name: "lookup", input: {} },
      ],
    ]);
    expect(assistants[1]).not.toHaveProperty("reasoning_content");
    expect(payload.thinking).toEqual({ type: "disabled" });
  });

  it("replays compatible reasoning and backfills tool turns even when thinking is off", async () => {
    const replayModel = { provider: "xiaomi", id: "mimo-v2-flash" };
    await runTransportStream(
      makeAnthropicTransportModel({
        id: "mimo-v2-flash",
        provider: "xiaomi",
        baseUrl: "https://api.xiaomimimo.com/anthropic",
        reasoning: false,
      }),
      {
        messages: [
          makeUserMessage("hello", 0),
          {
            ...makeAnthropicToolUseMessage(
              [
                thinking(
                  `Need${String.fromCharCode(0xd83d)} to answer politely.`,
                  "reasoning_content",
                ),
                text("Hello!"),
                thinking("Then ask a follow-up.", "reasoning_content"),
              ],
              replayModel,
            ),
            stopReason: "stop",
          },
          makeUserMessage("look this up", 1),
          makeAnthropicToolUseMessage([toolBlock("call_1", "lookup", {})], replayModel),
          {
            role: "toolResult",
            toolCallId: "call_1",
            toolName: "lookup",
            content: [text("found")],
            isError: false,
            timestamp: 2,
          },
          makeUserMessage("continue", 3),
        ],
      },
      { apiKey: "sk-xiaomi-test" },
    );
    const payload = latestAnthropicRequest().payload;
    const assistants = requireArray(payload.messages, "messages")
      .map((msg) => requireRecord(msg, "message"))
      .filter((msg) => msg.role === "assistant");
    expect(assistants[0]).toMatchObject({
      reasoning_content: "Need to answer politely.\nThen ask a follow-up.",
      content: [
        { type: "thinking", thinking: "Need to answer politely.", signature: "reasoning_content" },
        text("Hello!"),
        { type: "thinking", thinking: "Then ask a follow-up.", signature: "reasoning_content" },
      ],
    });
    expect(assistants[0]).not.toHaveProperty("reasoning");
    expect(assistants[0]).not.toHaveProperty("reasoning_text");
    expect(assistants[1]?.content).toEqual([
      { type: "thinking", thinking: "", signature: "reasoning_content" },
      { type: "tool_use", id: "call_1", name: "lookup", input: {} },
    ]);
    expect(assistants[1]).not.toHaveProperty("reasoning_content");
    expect(payload).not.toHaveProperty("thinking");
  });

  it("sends a minimal user fallback when message conversion has no content", async () => {
    await runTransportStream(makeAnthropicTransportModel(), {
      messages: [makeUserMessage(" \n\t ", 0)],
    });
    expect(latestAnthropicRequest().payload.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: ".", cache_control: { type: "ephemeral" } }],
      },
    ]);
  });

  it("normalizes user images before encoding the request", async () => {
    configureTestAnthropicImageNormalizer();
    await runTransportStream(makeAnthropicTransportModel({ input: ["text", "image"] }), {
      messages: [
        {
          role: "user",
          timestamp: 0,
          content: [text("look"), { type: "image", data: "aW1hZ2U=", mimeType: "image/heic" }],
        },
      ],
    });
    expect(
      findRecord(latestAnthropicUserMessage().content, (block) => block.type === "image"),
    ).toMatchObject({ source: { type: "base64", media_type: "image/jpeg", data: "aW1hZ2U=" } });
  });

  it("preserves ordered tool results while normalizing empty, image, and structured content", async () => {
    configureTestAnthropicImageNormalizer();
    const image = { type: "image", data: "aW1hZ2U=", mimeType: "image/tiff" };
    const resource = {
      type: "resource",
      resource: {
        uri: "https://example.com/data.json",
        mimeType: "application/json",
        text: '{"key":"value"}',
      },
    };
    const results = [
      [text(String.fromCharCode(0xd83d))],
      [{ ...image, data: "" }],
      [text(""), image],
      [resource],
      [text("before image"), image, resource, text("after image")],
    ];
    await runTransportStream(makeAnthropicTransportModel({ input: ["text", "image"] }), {
      messages: [
        makeAnthropicToolUseMessage(
          results.map((_, index) => toolBlock(`tool_${index}`, "lookup", {})),
        ),
        ...results.map((content, index) => ({
          role: "toolResult",
          toolCallId: `tool_${index}`,
          toolName: "lookup",
          content,
          isError: false,
          timestamp: 0,
        })),
      ],
    } as AnthropicStreamContext);
    const blocks = requireArray(latestAnthropicUserMessage().content, "tool results");
    expect(blocks).toHaveLength(5);
    const projected = blocks.map((block, index) => {
      expect(block).toMatchObject({
        type: "tool_result",
        tool_use_id: `tool_${index}`,
        is_error: false,
      });
      return requireRecord(block, "tool result").content;
    });
    const wireImage = {
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: "aW1hZ2U=" },
    };
    expect(projected.slice(0, 2)).toEqual(["(no output)", "(no output)"]);
    expect(projected[2]).toEqual([text("(see attached image)"), wireImage]);
    expect(projected[3]).toBe(JSON.stringify(resource));
    expect(projected[4]).toEqual([
      text("before image"),
      wireImage,
      text(JSON.stringify(resource)),
      text("after image"),
    ]);
  });

  it("omits images from user and tool turns on text-only models without decoding them", async () => {
    const normalizer = vi.fn(async (content: readonly AiInlineContentBlock[]) => [...content]);
    configureAiTransportHost({
      ...getAiTransportHost(),
      normalizeAnthropicInlineContentBlocks: normalizer,
    });
    const image = { type: "image" as const, data: "not-base64", mimeType: "image/heic" };
    const result = await runTransportStream(makeAnthropicTransportModel(), {
      messages: [
        { role: "user", content: [image], timestamp: 0 },
        makeAnthropicToolUseMessage([toolBlock("tool_1", "screenshot", {})]),
        {
          role: "toolResult",
          toolCallId: "tool_1",
          toolName: "screenshot",
          content: [image, text("captured screen")],
          isError: false,
          timestamp: 0,
        },
      ],
    });
    expect(result.stopReason).toBe("stop");
    expect(normalizer).not.toHaveBeenCalled();
    expect(JSON.stringify(latestAnthropicUserMessage().content)).toContain("image omitted");
    const toolResult = findRecord(
      findRecord(
        latestAnthropicRequest().payload.messages,
        (msg) =>
          Array.isArray(msg.content) &&
          msg.content.some((block) => requireRecord(block, "block").type === "tool_result"),
      ).content,
      (block) => block.type === "tool_result",
    );
    expect(toolResult).toMatchObject({
      content: "(tool image omitted: model does not support images)\ncaptured screen",
      is_error: false,
    });
  });

  it("owns rejected cancellation and incomplete signatures when aborted from another context", async () => {
    const context = new AsyncLocalStorage<string>();
    const controller = new AbortController();
    const abortReason = new Error("anthropic test abort");
    const finishCancellation = createDeferred();
    const ready = createDeferred();
    const observed: Promise<unknown>[] = [];
    const ownerContexts: Array<string | undefined> = [];
    let cancelReason: unknown;
    let cancellationFinished = false;
    configureAiTransportHost({
      ...getAiTransportHost(),
      observePendingProviderWork: (pending) => {
        ownerContexts.push(context.getStore());
        observed.push(pending);
      },
    });
    guardedFetchMock.mockResolvedValueOnce(
      createOpenRawSseResponse({
        body: serializeSseEvents(createInterruptedThinkingEvents()),
        onCancel: (reason) => {
          cancelReason = reason;
          ownerContexts.push(context.getStore());
          return finishCancellation.promise.finally(() => {
            cancellationFinished = true;
          });
        },
      }),
    );
    let events = 0;
    const unsubscribe = onLlmRequestActivity(controller.signal, () => {
      if (++events === 3) {
        ready.resolve();
      }
    });
    const completion = context.run("origin", () =>
      runTransportStream(undefined, undefined, {
        apiKey: "fixture",
        signal: controller.signal,
      }),
    );
    try {
      await ready.promise;
      context.run("foreign", () => controller.abort(abortReason));
      const result = await completion;
      expect(result).toMatchObject({ stopReason: "aborted", errorMessage: "anthropic test abort" });
      expect(result.content[0]).toMatchObject({ type: "thinking", thinkingSignature: "" });
      expect(cancelReason).toBe(abortReason);
      expect(cancellationFinished).toBe(false);
      expect(observed.length).toBeGreaterThan(0);
      expect(ownerContexts.every((owner) => owner === "origin")).toBe(true);
      let joined = false;
      const joining = Promise.allSettled(observed).then(() => {
        joined = true;
      });
      await Promise.resolve();
      expect(joined).toBe(false);
      finishCancellation.reject(new Error("cancellation cleanup failed"));
      await joining;
      expect(cancellationFinished).toBe(true);
      expect((await completion).errorMessage).toBe("anthropic test abort");
    } finally {
      unsubscribe();
      finishCancellation.resolve();
      await completion;
      await Promise.allSettled(observed);
    }
  });

  it("treats already-aborted signals as abort errors before reading SSE chunks", async () => {
    const controller = new AbortController();
    const abortReason = new Error("pre-aborted stream");
    let cancelReason: unknown;
    guardedFetchMock.mockResolvedValueOnce(
      createOpenRawSseResponse({
        body: serializeSseEvents([startMessage("msg_1", 1)]),
        onCancel: (reason) => {
          cancelReason = reason;
        },
      }),
    );
    controller.abort(abortReason);

    const result = await runTransportStream(makeAnthropicTransportModel(), undefined, {
      apiKey: "sk-ant-api",
      signal: controller.signal,
    } as AnthropicStreamOptions);

    expect(result.stopReason).toBe("aborted");
    expect(result.errorMessage).toBe("pre-aborted stream");
    expect(cancelReason).toBe(abortReason);
  });

  it("cancels an unread SSE body when acceptance observation fails", async () => {
    const cancelled = createDeferred();
    guardedFetchMock.mockResolvedValueOnce(
      createOpenRawSseResponse({
        body: "",
        onCancel: () => {
          cancelled.resolve();
        },
      }),
    );
    const options = withProviderAcceptanceObserver({ apiKey: "sk-ant-api" }, () => {
      throw new Error("acceptance observer failed");
    });

    const result = await runTransportStream(makeAnthropicTransportModel(), undefined, options);

    expect(result).toMatchObject({
      stopReason: "error",
      errorMessage: "acceptance observer failed",
    });
    await cancelled.promise;
  });

  it("joins open SSE body cancellation when a non-abort stream consumer throws", async () => {
    const cancelStarted = createDeferred();
    const finishCancellation = createDeferred();
    guardedFetchMock.mockResolvedValueOnce(
      createOpenRawSseResponse({
        body: 'data: {"type":"error","error":{"message":"stream exploded"}}\n\n',
        onCancel: () => {
          cancelStarted.resolve();
          return finishCancellation.promise;
        },
      }),
    );
    let settled = false;
    const completion = runTransportStream(makeAnthropicTransportModel(), undefined, {
      apiKey: "fixture",
    } as AnthropicStreamOptions).then((result) => {
      settled = true;
      return result;
    });
    try {
      await cancelStarted.promise;
      await Promise.resolve();
      expect(settled).toBe(false);
      finishCancellation.resolve();
      const result = await completion;
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toBe("stream exploded");
    } finally {
      finishCancellation.resolve();
      await completion;
    }
  });

  it.each<{
    name: string;
    model: Partial<AnthropicMessagesModel>;
    message?: string;
    context?: AnthropicStreamContext;
    options: AnthropicStreamOptions;
    expected?: Record<string, unknown>;
    exact?: Record<string, unknown>;
    absent?: string[];
    responseModel?: string;
  }>([
    {
      name: "does not infer adaptive thinking from forward-compatible effort maps",
      model: {
        id: "claude-future",
        name: "Future Claude",
        provider: "github-copilot",
        reasoning: true,
        thinkingLevelMap: { xhigh: null, max: "max" },
      },
      message: "Think as much as supported.",
      options: { apiKey: "copilot-token", reasoning: "max" },
      expected: { thinking: { type: "enabled", budget_tokens: 7168 } },
      absent: ["output_config"],
    },
    {
      name: "resolves thinking as disabled when the legacy budget is positive but sub-minimum",
      model: { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", reasoning: true, maxTokens: 1500 },
      message: "hello",
      options: { apiKey: "test-token", reasoning: "low" },
      expected: { thinking: { type: "disabled" } },
    },
    {
      name: "uses canonical Claude policy for transport deployment aliases",
      model: deployment("claude-opus-4-8", { thinkingLevelMap: { xhigh: "xhigh", max: "max" } }),
      message: "Think extra hard.",
      options: { apiKey: "sk-ant-api", reasoning: "xhigh", temperature: 0.2 },
      expected: {
        model: "production-claude",
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: "xhigh" },
      },
      absent: ["temperature"],
    },
    {
      name: "preserves alias temperature when thinking is off",
      model: deployment("claude-opus-4-6", { thinkingLevelMap: { xhigh: "xhigh", max: "max" } }),
      options: { apiKey: "sk-ant-api", temperature: 0.2 },
      exact: { temperature: 0.2 },
    },
    {
      name: "supports explicit off for the newer optional-thinking model",
      model: { id: "claude-opus-5", name: "Claude Opus 5", maxTokens: 128_000 },
      context: makeSonnet5PrefillContext(),
      options: { apiKey: "sk-ant-api", reasoning: "off", temperature: 0.2, toolChoice: "any" },
      expected: {
        max_tokens: 128_000,
        messages: [{ role: "user" }],
        thinking: { type: "disabled" },
        tool_choice: { type: "any" },
      },
      absent: ["temperature", "output_config"],
    },
    {
      name: "uses default mandatory adaptive thinking for a deployment alias",
      model: deployment("claude-fable-5", {
        id: "prod-primary",
        provider: "microsoft-foundry",
        baseUrl: "https://example.services.ai.azure.com/anthropic",
        maxTokens: 128_000,
      }),
      options: {
        apiKey: "sk-ant-api",
        temperature: 0.2,
        toolChoice: { type: "tool", name: "read_file" },
      },
      exact: {
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: "medium" },
        tool_choice: { type: "auto" },
      },
      absent: ["temperature"],
      responseModel: "claude-fable-5",
    },
    {
      name: "normalizes explicit off and sampling for a mandatory-thinking alias",
      model: deployment("claude-mythos-5", {
        id: "prod-mythos",
        provider: "microsoft-foundry",
        baseUrl: "https://example.services.ai.azure.com/anthropic",
        maxTokens: 128_000,
      }),
      options: {
        apiKey: "sk-ant-api",
        reasoning: "off",
        temperature: 0.2,
        onPayload: (payload) => ({ ...requireRecord(payload, "payload"), top_p: 0.9, top_k: 40 }),
      },
      exact: {
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: "low" },
      },
      absent: ["temperature", "top_p", "top_k"],
    },
    {
      name: "honors provider routes that exclude native max effort",
      model: {
        id: "claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        provider: "github-copilot",
        maxTokens: 8192,
        thinkingLevelMap: { xhigh: null, max: null },
      },
      options: { apiKey: "sk-ant-api", reasoning: "max" },
      exact: {
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: "high" },
      },
    },
  ])(
    "$name",
    async ({ model, message, context, options, expected, exact, absent, responseModel }) => {
      if (responseModel) {
        mockSse([
          startMessage("msg_1", 1, responseModel),
          endMessage("end_turn", 1, 1),
          { type: "message_stop" },
        ]);
      }
      const result = await runTransportStream(
        makeAnthropicTransportModel(model),
        context ?? (message ? { messages: [makeUserMessage(message, 0)] } : undefined),
        options,
      );
      const payload = latestAnthropicRequest().payload;
      if (expected) {
        expect(payload).toMatchObject(expected);
      }
      for (const [property, value] of Object.entries(exact ?? {})) {
        expect(payload[property]).toEqual(value);
      }
      for (const property of absent ?? []) {
        expect(payload).not.toHaveProperty(property);
      }
      if (responseModel) {
        expect(result.responseModel).toBe(responseModel);
      }
    },
  );

  it("emits error without a preceding start event when SSE error arrives before message_start", async () => {
    const errorMessage = "messages.1.content.63: Invalid signature in thinking block";
    mockSse([{ type: "error", error: { type: "invalid_request_error", message: errorMessage } }]);
    const acceptanceObserver = vi.fn();
    const onResponse = vi.fn();
    const options = withProviderAcceptanceObserver(
      { apiKey: "sk-ant-api", onResponse } as AnthropicStreamOptions,
      acceptanceObserver,
    );
    const { eventTypes, result } = await consumeTransportStream(undefined, undefined, options);
    expect(eventTypes).toEqual(["error"]);
    expect(result).toMatchObject({ stopReason: "error", errorMessage });
    expect(acceptanceObserver).toHaveBeenCalledWith({
      kind: "http_response",
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    expect(onResponse).toHaveBeenCalledWith(
      { status: 200, headers: { "content-type": "text/event-stream" } },
      expect.objectContaining({ provider: "anthropic" }),
    );
  });
  describe("terminal tool-argument repair over loopback HTTP", () => {
    let server: Server | undefined;
    beforeEach(() =>
      configureAiTransportHost({
        ...getAiTransportHost(),
        buildModelFetch: () => globalThis.fetch,
      }),
    );
    afterEach(async () => {
      if (server) {
        await new Promise<void>((resolve, reject) => {
          server?.close((error) => (error ? reject(error) : resolve()));
        });
        server = undefined;
      }
    });
    async function startRepairServer(events: Record<string, unknown>[]) {
      server = createServer((request, response) => {
        let payload = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => {
          payload += chunk;
        });
        request.on("end", () => {
          expect(request.method).toBe("POST");
          expect(request.url).toBe("/v1/messages");
          expect(JSON.parse(payload)).toMatchObject({ model: "claude-opus-5", stream: true });
          response.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
          });
          response.end(
            events
              .map((event) => `event: ${String(event.type)}\n${serializeSseEvents([event])}`)
              .join(""),
          );
        });
      });
      await new Promise<void>((resolve) => {
        server?.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected loopback address");
      }
      return { server, baseUrl: `http://127.0.0.1:${address.port}` };
    }
    function repairEvents(blocks: Array<{ id: string; name: string; partialJson: string }>) {
      return [
        startMessage("msg_loopback", 4, "claude-opus-5"),
        ...blocks.flatMap(({ id, name, partialJson }, index) => [
          anthropicContentBlockStart(index, { type: "tool_use", id, name, input: {} }),
          jsonDelta(index, partialJson),
          blockStop(index),
        ]),
        anthropicMessageDelta({ stop_reason: "tool_use" }, { output_tokens: 8 }),
        { type: "message_stop" },
      ];
    }
    async function runRepairStream(baseUrl: string) {
      const stream = await startTransportStream(
        makeAnthropicTransportModel({ id: "claude-opus-5", baseUrl }),
      );
      const eventTypes: string[] = [];
      const toolCallEnds: Record<string, unknown>[] = [];
      for await (const event of stream) {
        eventTypes.push(event.type);
        if (event.type === "toolcall_end") {
          toolCallEnds.push(event.toolCall.arguments);
        }
      }
      return { eventTypes, toolCallEnds, result: await stream.result() };
    }
    it.each([
      {
        name: "repairs a raw newline while preserving a valid escape in its sibling",
        block: {
          id: "call_edit",
          name: "edit",
          // oldText has a valid escape; newText has a raw newline.
          partialJson: '{"path":"a.py","oldText":"C:\\nnext","newText":"x = 1\ny = 2"}',
        },
        repaired: true,
      },
      {
        name: "fails closed on a truncated sibling with bounded diagnostics",
        block: { id: "call_truncated", name: "read", partialJson: '{"path":"SECRET.md"' },
        repaired: false,
      },
    ])("$name", async ({ block, repaired }) => {
      const started = await startRepairServer(
        repairEvents([
          { id: "call_read", name: "read", partialJson: '{"path":"README.md"}' },
          block,
        ]),
      );
      server = started.server;
      const { eventTypes, toolCallEnds, result } = await runRepairStream(started.baseUrl);
      if (repaired) {
        expect(result.stopReason).toBe("toolUse");
        expect(result.errorMessage).toBeUndefined();
        expect(eventTypes.filter((type) => type === "toolcall_end")).toHaveLength(2);
        expect(eventTypes.at(-1)).toBe("done");
        expect(toolCallEnds).toEqual([
          { path: "README.md" },
          { path: "a.py", oldText: "C:\nnext", newText: "x = 1\ny = 2" },
        ]);
      } else {
        expect(result.stopReason).toBe("error");
        expect(result.errorMessage).toBe(
          "Provider completed tool call with malformed JSON arguments",
        );
        expect(result.errorCode).toBe("malformed_tool_call_arguments");
        expect(JSON.parse(result.errorBody ?? "{}")).toMatchObject({
          code: "malformed_tool_call_arguments",
          argumentChars: block.partialJson.length,
          repairAttempted: true,
        });
        expect(`${result.errorMessage}${result.errorBody}`).not.toContain("SECRET.md");
        expect(toolCallEnds).toEqual([]);
        expect(eventTypes).not.toContain("toolcall_end");
        expect(eventTypes).not.toContain("done");
      }
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
