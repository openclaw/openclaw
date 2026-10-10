import { AsyncLocalStorage } from "node:async_hooks";
import { createServer, type Server } from "node:http";
import type { AssistantMessage, Model } from "@openclaw/llm-core";
/**
 * Tests Anthropic Messages transport streaming.
 * Covers request construction, SSE parsing, aborts, tool calls, usage, and
 * provider transport hooks.
 */
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
import { createCompactionCapture } from "./anthropic-compaction-replay.js";
import type { AnthropicTransportOptions } from "./anthropic-transport-options.js";
import { resolveCompactionReplayPressure } from "./provider-compaction-replay.js";
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

function resolveTestEndpointClass(baseUrl?: string): string {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return "default";
  }
  try {
    const url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    const hostname = url.hostname.toLowerCase();
    if (hostname === "api.anthropic.com") {
      return "anthropic-public";
    }
    if (hostname === "openrouter.ai") {
      return "openrouter";
    }
    if (hostname === "api.xiaomimimo.com" || hostname.endsWith(".xiaomimimo.com")) {
      return "xiaomi-native";
    }
    return "custom";
  } catch {
    return "invalid";
  }
}

let createAnthropicMessagesTransportStreamFn: typeof import("./anthropic-transport-stream.js").createAnthropicMessagesTransportStreamFn;

type AnthropicMessagesModel = Model<"anthropic-messages">;
type AnthropicStreamFn = ReturnType<typeof createAnthropicMessagesTransportStreamFn>;
type AnthropicStreamContext = Parameters<AnthropicStreamFn>[1];
type AnthropicStreamOptions = NonNullable<Parameters<AnthropicStreamFn>[2]> &
  AnthropicTransportOptions;
function createSseResponse(events: Record<string, unknown>[] = []): Response {
  return createRawSseResponse(serializeSseEvents(events));
}

function mockSse(events: Record<string, unknown>[]): void {
  guardedFetchMock.mockResolvedValueOnce(createSseResponse(events));
}

function wireUsage(input: number | string, output: number, read = 0, write: number | null = 0) {
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: read,
    cache_creation_input_tokens: write,
  };
}

function anthropicMessageStart(message: Record<string, unknown>) {
  return { type: "message_start", message };
}

function anthropicMessageDelta(delta: Record<string, unknown>, usage?: Record<string, unknown>) {
  // An absent usage object serializes the event without the key, matching proxies that
  // close a turn with stop_reason alone.
  return { type: "message_delta", delta, usage };
}

function anthropicContentBlockStart(index: number, content_block: Record<string, unknown>) {
  return { type: "content_block_start", index, content_block };
}

function anthropicContentBlockDelta(index: number, delta: Record<string, unknown>) {
  return { type: "content_block_delta", index, delta };
}

function serializeSseEvents(events: Record<string, unknown>[]): string {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

function createFailingSseResponse(events: Record<string, unknown>[], error: Error): Response {
  const encoder = new TextEncoder();
  let sentEvents = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sentEvents) {
        sentEvents = true;
        controller.enqueue(encoder.encode(serializeSseEvents(events)));
        return;
      }
      controller.error(error);
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function createInterruptedThinkingEvents(): Record<string, unknown>[] {
  return [
    anthropicMessageStart({ id: "msg_1", usage: { input_tokens: 6, output_tokens: 0 } }),
    anthropicContentBlockStart(0, { type: "thinking", thinking: "step by step", signature: "" }),
    anthropicContentBlockDelta(0, { type: "signature_delta", signature: "partial-signature" }),
  ];
}

function createRawSseResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
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

function makeAnthropicTransportModel(
  overrides: Partial<AnthropicMessagesModel> = {},
): AnthropicMessagesModel {
  return {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 8192,
    ...overrides,
  };
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
        role: "assistant",
        content: [{ type: "text", text: "{" }],
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-sonnet-5",
        usage: createZeroUsage(),
        stopReason: "stop",
        timestamp: 1,
      },
    ],
    tools: [{ name: "lookup", description: "Lookup", parameters: { type: "object" } }],
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

describe("anthropic transport stream", () => {
  beforeAll(async () => {
    ({ createAnthropicMessagesTransportStreamFn } =
      await import("./anthropic-transport-stream.js"));
  });

  beforeEach(() => {
    vi.unstubAllEnvs();
    buildGuardedModelFetchMock.mockReset();
    guardedFetchMock.mockReset();
    buildGuardedModelFetchMock.mockReturnValue(guardedFetchMock);
    configureAiTransportHost({
      ...coreTransportHost,
      buildModelFetch: buildGuardedModelFetchMock,
      resolveProviderRequestCapabilities: (input) => {
        const endpointClass = resolveTestEndpointClass(input.baseUrl);
        return {
          endpointClass,
          knownProviderFamily: endpointClass === "xiaomi-native" ? "xiaomi" : "",
          supportsNativeStreamingUsageCompat: false,
          supportsOpenAICompletionsStreamingUsageCompat: false,
          usesExplicitProxyLikeEndpoint: endpointClass === "custom" || endpointClass === "invalid",
          allowsAnthropicServiceTier: endpointClass === "anthropic-public",
        };
      },
    });
    guardedFetchMock.mockResolvedValue(
      createSseResponse([
        anthropicMessageStart({ id: "msg_default", usage: { input_tokens: 0, output_tokens: 0 } }),
        anthropicMessageDelta({ stop_reason: "end_turn" }, { input_tokens: 0, output_tokens: 0 }),
        { type: "message_stop" },
      ]),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(() => {
    configureAiTransportHost(coreTransportHost);
  });

  it.each([
    {
      name: "includes compaction iterations in billed usage while keeping final context usage",
      id: "msg_usage",
      model: "claude-fable-5",
      initial: wireUsage(12, 0, 120_000, null),
      final: {
        input_tokens: 12,
        output_tokens: 15_104,
        cache_read_input_tokens: 819_661,
        cache_creation_input_tokens: 93_130,
        iterations: [
          {
            type: "compaction",
            input_tokens: 12,
            output_tokens: 1_000,
            cache_read_input_tokens: 819_661,
            cache_creation_input_tokens: 93_130,
          },
          {
            type: "message",
            input_tokens: 12,
            output_tokens: 15_104,
            cache_read_input_tokens: 148_862,
            cache_creation_input_tokens: 0,
          },
        ],
      },
      content: true,
      expected: {
        input: 24,
        output: 16_104,
        cacheRead: 968_523,
        cacheWrite: 93_130,
        totalTokens: 1_077_781,
      },
      context: { state: "available", promptTokens: 148_874, totalTokens: 163_978 },
    },
    {
      name: "does not fall back to aggregate usage when the final iteration is malformed",
      id: "msg_invalid_iteration",
      model: "claude-fable-5",
      initial: wireUsage(12, 0, 120_000, 0),
      final: {
        input_tokens: 12,
        output_tokens: 15_104,
        cache_read_input_tokens: 819_661,
        cache_creation_input_tokens: 93_130,
        iterations: [
          {
            type: "message",
            input_tokens: "malformed",
            output_tokens: 15_104,
            cache_read_input_tokens: 148_862,
            cache_creation_input_tokens: 0,
          },
        ],
      },
      expected: { totalTokens: 927_907 },
      context: { state: "unavailable" },
    },
    {
      name: "uses complete final usage when message-start prompt buckets are zero placeholders",
      id: "msg_zero_start",
      model: "claude-fable-5",
      initial: wireUsage(0, 0, 0, 0),
      final: wireUsage(12, 15_104, 148_862, 0),
      context: { state: "available", promptTokens: 148_874, totalTokens: 163_978 },
    },
    {
      name: "does not treat zero start placeholders as complete final prompt usage",
      id: "msg_zero_start_partial_delta",
      model: "claude-fable-5",
      initial: wireUsage(0, 0, 0, 0),
      final: { output_tokens: 15_104 },
      context: { state: "unavailable" },
    },
  ])("$name", async (testCase) => {
    const textEvents = testCase.content
      ? [
          anthropicContentBlockStart(0, { type: "text", text: "" }),
          anthropicContentBlockDelta(0, { type: "text_delta", text: "Done." }),
          { type: "content_block_stop", index: 0 },
        ]
      : [];
    mockSse([
      anthropicMessageStart({ id: testCase.id, model: testCase.model, usage: testCase.initial }),
      ...textEvents,
      anthropicMessageDelta({ stop_reason: "end_turn" }, testCase.final),
      { type: "message_stop" },
    ]);
    const result = await runTransportStream(
      makeAnthropicTransportModel({
        id: testCase.model,
        name: testCase.model === "claude-fable-5" ? "Claude Fable 5" : "Claude Sonnet 4.6",
      }),
    );
    if (testCase.expected) {
      expect(result.usage).toMatchObject(testCase.expected);
    }
    expect(result.usage.contextUsage).toEqual(testCase.context);
  });

  it("replays captured compaction after restart without trusting usage from disabled replay", async () => {
    guardedFetchMock
      .mockResolvedValueOnce(
        createSseResponse([
          anthropicMessageStart({
            id: "msg_compaction",
            model: "claude-sonnet-4-6",
            usage: { input_tokens: 50_001, output_tokens: 0 },
          }),
          anthropicContentBlockStart(0, {
            type: "compaction",
            content: null,
            encrypted_content: "opaque-initial-compaction",
          }),
          anthropicContentBlockDelta(0, {
            type: "compaction_delta",
            content: "summary ",
            encrypted_content: "opaque-partial-compaction",
          }),
          anthropicContentBlockDelta(0, {
            type: "compaction_delta",
            content: "checkpoint",
            encrypted_content: "opaque-final-compaction",
          }),
          { type: "content_block_stop", index: 0 },
          anthropicContentBlockStart(1, { type: "text", text: "Done." }),
          { type: "content_block_stop", index: 1 },
          anthropicMessageDelta({ stop_reason: "end_turn" }, { input_tokens: 1, output_tokens: 1 }),
          { type: "message_stop" },
        ]),
      )
      .mockResolvedValueOnce(
        createSseResponse([
          anthropicMessageStart({
            id: "msg_disabled",
            usage: { input_tokens: 1, output_tokens: 0 },
          }),
          anthropicContentBlockStart(0, { type: "text", text: "Replay was disabled." }),
          { type: "content_block_stop", index: 0 },
          anthropicMessageDelta({ stop_reason: "end_turn" }, { input_tokens: 1, output_tokens: 1 }),
          { type: "message_stop" },
        ]),
      )
      .mockResolvedValueOnce(
        createSseResponse([
          anthropicMessageStart({ id: "msg_replay", usage: { input_tokens: 1, output_tokens: 0 } }),
          anthropicMessageDelta({ stop_reason: "end_turn" }, { input_tokens: 1, output_tokens: 1 }),
          { type: "message_stop" },
        ]),
      );
    const model = makeAnthropicTransportModel();
    const replayOptions = {
      apiKey: "sk-ant-api",
      anthropicServerCompaction: true,
      authProfileId: "anthropic:work",
      sessionId: "session-1",
    } as unknown as AnthropicStreamOptions;
    const firstUser = { role: "user" as const, content: "old question", timestamp: 1 };
    const first = await runTransportStream(
      model,
      { messages: [firstUser] } as AnthropicStreamContext,
      replayOptions,
    );

    expect(first.providerReplay).toMatchObject({
      type: "anthropic-compaction",
      data: "summary checkpoint",
      replayIndex: 0,
    });

    const offContext = {
      messages: [
        firstUser,
        first,
        { role: "user" as const, content: "while disabled", timestamp: 2 },
      ],
    };
    const offOptions = { ...replayOptions, anthropicServerCompaction: false };
    const offResult = await runTransportStream(model, offContext, offOptions);
    expect(JSON.stringify(latestAnthropicRequest().payload.messages)).not.toContain(
      '"type":"compaction"',
    );
    expect(offResult.usage.contextUsage).toEqual({
      state: "available",
      promptTokens: 1,
      totalTokens: 2,
    });
    // oxlint-disable-next-line unicorn/prefer-structured-clone -- Exercise persisted JSON reload, not an in-memory clone.
    const resumed: AnthropicStreamContext["messages"] = JSON.parse(
      JSON.stringify([
        ...offContext.messages,
        offResult,
        { role: "user", content: "new question", timestamp: 3 },
      ]),
    );

    await runTransportStream(model, { messages: resumed }, replayOptions);

    const replayMessages = latestAnthropicRequest().payload.messages as Array<
      Record<string, unknown>
    >;
    expect(replayMessages.map((message) => message.role)).toEqual([
      "assistant",
      "user",
      "assistant",
      "user",
    ]);
    expect(replayMessages[0]?.content).toEqual([
      {
        type: "compaction",
        content: "summary checkpoint",
        encrypted_content: "opaque-final-compaction",
      },
      { type: "text", text: "Done." },
    ]);
    const pressure = resolveCompactionReplayPressure(
      resumed,
      model,
      { ...replayOptions, enabled: true },
      {
        text: (text) => text.length,
        image: () => 100,
        json: (value) => JSON.stringify(value).length,
      },
    );
    expect(pressure?.prefixTokens).toBe("summary checkpoint".length);
    expect(pressure?.messages[2]).not.toHaveProperty("usage.contextUsage");
    expect(pressure?.messages[2]).toMatchObject({
      usage: { totalTokens: offResult.usage.totalTokens, cost: offResult.usage.cost },
    });
    expect(offResult.usage.contextUsage?.state).toBe("available");
  });

  it("records suppression when Anthropic rejects a replayed compaction block", async () => {
    const model = makeAnthropicTransportModel();
    const replayIdentity = {
      authProfileId: "anthropic:work",
      sessionId: "session-1",
    };
    const checkpoint: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "answer after compaction" }],
      api: "anthropic-messages",
      provider: "anthropic",
      model: model.id,
      usage: createZeroUsage(),
      stopReason: "stop",
      timestamp: 1,
    };
    const capture = createCompactionCapture(checkpoint, model, replayIdentity);
    capture.begin(0, { type: "compaction", content: "summary checkpoint" }, 0);
    capture.complete(0);
    guardedFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: { message: "context_management compaction block is invalid" } }),
        { status: 400, headers: { "content-type": "application/json" } },
      ),
    );

    const result = await runTransportStream(
      model,
      {
        messages: [
          { role: "user", content: "old question" },
          checkpoint,
          { role: "user", content: "new question" },
        ],
      } as AnthropicStreamContext,
      {
        apiKey: "sk-ant-api",
        anthropicServerCompaction: true,
        ...replayIdentity,
      } as unknown as AnthropicStreamOptions,
    );

    expect(result.stopReason).toBe("error");
    expect(result.providerReplay).toMatchObject({
      type: "anthropic-compaction-suppression",
      data: "rejected",
    });
    expect(guardedFetchMock).toHaveBeenCalledTimes(1);
  });

  it("prices one-hour cache writes at the same rate as the direct Anthropic provider", async () => {
    mockSse([
      anthropicMessageStart({
        id: "msg_cache_ttl_usage",
        usage: {
          input_tokens: 100,
          output_tokens: 0,
          cache_creation_input_tokens: 1_000_000,
          cache_creation: {
            ephemeral_5m_input_tokens: 600_000,
            ephemeral_1h_input_tokens: 400_000,
          },
        },
      }),
      anthropicMessageDelta({ stop_reason: "end_turn" }, { output_tokens: 5 }),
      { type: "message_stop" },
    ]);

    const result = await runTransportStream({
      ...makeAnthropicTransportModel(),
      cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    });

    expect(result.usage).toMatchObject({ cacheWrite: 1_000_000, cacheWrite1h: 400_000 });
    expect(result.usage.cost.cacheWrite).toBeCloseTo(7.75, 10);
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
      });
    }
  });

  it.each(anthropicServerSideFallbackCases)(
    "sends default server-side fallback params for direct $name API-key requests",
    async ({ optionHeaders, customBeta, ...model }) => {
      mockSse([
        anthropicMessageStart({ id: "msg_fb", usage: { input_tokens: 1, output_tokens: 0 } }),
        anthropicMessageDelta({ stop_reason: "end_turn" }, { input_tokens: 1, output_tokens: 1 }),
        { type: "message_stop" },
      ]);

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
      anthropicMessageStart({
        id: "msg_fb",
        model: "claude-fable-5",
        usage: { input_tokens: 5, output_tokens: 0 },
      }),
      anthropicContentBlockStart(0, { type: "thinking", thinking: "" }),
      anthropicContentBlockDelta(0, {
        type: "thinking_delta",
        thinking: "pre-boundary reasoning",
      }),
      { type: "content_block_stop", index: 0 },
      anthropicContentBlockStart(1, { type: "text", text: "partial " }),
      { type: "content_block_stop", index: 1 },
      // Starting a tool call tags the preceding text as commentary before
      // the classifier declines mid-turn.
      anthropicContentBlockStart(2, {
        type: "tool_use",
        id: "call_1",
        name: "lookup",
        input: {},
      }),
      { type: "content_block_stop", index: 2 },
      anthropicContentBlockStart(3, {
        type: "fallback",
        from: { model: "claude-fable-5" },
        to: { model: "claude-opus-4-8" },
      }),
      { type: "content_block_stop", index: 3 },
      anthropicContentBlockStart(4, { type: "text", text: "" }),
      anthropicContentBlockDelta(4, { type: "text_delta", text: "continued" }),
      { type: "content_block_stop", index: 4 },
      anthropicMessageDelta({ stop_reason: "end_turn" }, { input_tokens: 5, output_tokens: 9 }),
      { type: "message_stop" },
    ]);

    const model = makeAnthropicTransportModel({ id: "claude-fable-5", name: "Claude Fable 5" });
    model.cost = { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 };
    const result = await runTransportStream(model);

    expect(result.stopReason).toBe("stop");
    expect(result.content).toEqual([
      { type: "text", text: "partial " },
      { type: "text", text: "continued" },
    ]);
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

  it.each([
    {
      baseUrl: "",
      env: true,
      endpoint: "https://anthropic-proxy.example/v1",
      id: "claude-sonnet-4-6",
      wireId: "claude-sonnet-4-6",
    },
    {
      baseUrl: "https://configured.example",
      env: true,
      endpoint: "https://configured.example",
      id: "claude-sonnet-4-6",
      wireId: "claude-sonnet-4-6",
    },
    {
      baseUrl: "https://api.anthropic.com",
      env: false,
      endpoint: "https://api.anthropic.com",
      id: "anthropic/claude-sonnet-4-6",
      wireId: "claude-sonnet-4-6",
    },
    {
      baseUrl: "https://anthropic-proxy.internal",
      env: false,
      endpoint: "https://anthropic-proxy.internal",
      id: "anthropic/claude-sonnet-4-6",
      wireId: "anthropic/claude-sonnet-4-6",
    },
  ])(
    "resolves endpoint and model ID for $baseUrl (environment=$env)",
    async ({ baseUrl, env, endpoint, id, wireId }) => {
      if (env) {
        vi.stubEnv("ANTHROPIC_BASE_URL", " https://anthropic-proxy.example/v1 ");
      }
      await runTransportStream(makeAnthropicTransportModel({ baseUrl, id }), undefined, {
        apiKey: "sk-ant-api",
        ...(baseUrl === "https://api.anthropic.com"
          ? { toolChoice: { type: "tool", name: "read_file" } }
          : {}),
      });
      expect(guardedFetchCall()[0]).toBe(
        `${endpoint}${endpoint.endsWith("/v1") ? "" : "/v1"}/messages`,
      );
      expect(buildGuardedModelFetchMock.mock.calls[0]?.[0]).toMatchObject({ baseUrl: endpoint });
      expect(latestAnthropicRequest().payload.model).toBe(wireId);
      if (env) {
        expect(latestAnthropicRequestHeaders().get("anthropic-beta")).toBeNull();
      }
    },
  );

  it("bypasses the OpenAI SSE sanitizer for Kimi Anthropic thinking streams", async () => {
    const model = makeAnthropicTransportModel({
      id: "kimi-for-coding",
      name: "Kimi Code",
      provider: "kimi",
      baseUrl: "https://api.kimi.com/coding",
      maxTokens: 32768,
    });

    await runTransportStream(model, undefined, {
      apiKey: "sk-kimi-api",
      reasoning: "high",
    } as AnthropicStreamOptions);

    expect(buildGuardedModelFetchMock).toHaveBeenCalledWith(model, undefined, {
      sanitizeSse: false,
    });
    expect(latestAnthropicRequest().payload.thinking).toEqual({
      type: "enabled",
      budget_tokens: 16384,
    });
  });

  it("forwards stop sequences as Anthropic stop_sequences", async () => {
    await runTransportStream(makeAnthropicTransportModel(), undefined, {
      apiKey: "sk-ant-api",
      stop: ["User:", "Assistant:"],
    } as AnthropicStreamOptions);

    expect(latestAnthropicRequest().payload.stop_sequences).toEqual(["User:", "Assistant:"]);
  });

  it.each([
    {
      label: "floors a sub-unit override",
      custom: false,
      maxTokens: 8192,
      contextWindow: 200_000,
      requested: 0.5,
      expected: 8192,
    },
    {
      label: "caps large catalog limits",
      custom: true,
      maxTokens: 196_608,
      contextWindow: 200_000,
      requested: undefined,
      expected: 32_000,
    },
    {
      label: "defaults missing catalog limits",
      custom: true,
      maxTokens: undefined,
      contextWindow: 200_000,
      requested: undefined,
      expected: 4_096,
    },
    {
      label: "clamps the fallback to the context window",
      custom: true,
      maxTokens: undefined,
      contextWindow: 4_096,
      requested: undefined,
      expected: 1_024,
    },
    {
      label: "rejects an invalid catalog limit",
      custom: true,
      maxTokens: 0,
      contextWindow: 4_096,
      requested: undefined,
      expected: undefined,
    },
  ])("$label", async ({ custom, maxTokens, contextWindow, requested, expected }) => {
    const model = makeAnthropicTransportModel({
      ...(custom
        ? {
            id: "custom-model",
            provider: "custom-anthropic",
            baseUrl: "https://custom.example/anthropic",
            reasoning: false,
          }
        : {}),
      contextWindow,
      ...(maxTokens === undefined ? {} : { maxTokens }),
    });
    if (maxTokens === undefined) {
      Reflect.deleteProperty(model, "maxTokens");
    }
    const result = await runTransportStream(model, undefined, {
      apiKey: "fake",
      maxTokens: requested,
    });
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
        anthropicMessageStart({
          id: "msg_refusal",
          usage: { input_tokens: 3, output_tokens: 0 },
        }),
        anthropicContentBlockStart(0, { type: "text", text: "" }),
        anthropicContentBlockDelta(0, {
          type: "text_delta",
          text: "discard this partial output",
        }),
        { type: "content_block_stop", index: 0 },
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

      const stream = await startTransportStream(
        makeAnthropicTransportModel({
          id,
          name,
          provider,
        }),
      );
      const eventTypes: string[] = [];
      for await (const event of stream as AsyncIterable<{ type: string }>) {
        eventTypes.push(event.type);
      }
      const result = await stream.result();

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
        anthropicMessageStart({ id: "msg_unsealed", usage: { input_tokens: 2, output_tokens: 0 } }),
        anthropicContentBlockStart(0, {
          type: "tool_use",
          id: "call_unsealed",
          name: "read",
          input: {},
        }),
        anthropicContentBlockDelta(0, {
          type: "input_json_delta",
          partial_json: '{"path":"README.md"',
        }),
        anthropicMessageDelta({ stop_reason: "tool_use" }, { input_tokens: 2, output_tokens: 1 }),
        { type: "message_stop" },
      ],
      buffered: false,
      unsealed: true,
    },
  ])("rejects $name", async ({ model, events, buffered, unsealed }) => {
    mockSse(events);
    const stream = await startTransportStream(makeAnthropicTransportModel(model));
    const eventTypes: string[] = [];
    for await (const event of stream) {
      eventTypes.push(event.type);
    }
    const result = await stream.result();
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

  it("defers a pre-tool text block's text_end until it carries the commentary phase", async () => {
    mockSse([
      anthropicMessageStart({ id: "msg_defer", usage: { input_tokens: 5, output_tokens: 0 } }),
      anthropicContentBlockStart(0, { type: "text", text: "" }),
      anthropicContentBlockDelta(0, { type: "text_delta", text: "I'll check the repo." }),
      { type: "content_block_stop", index: 0 },
      anthropicContentBlockStart(1, { type: "tool_use", id: "tool_1", name: "exec", input: {} }),
      { type: "content_block_stop", index: 1 },
      anthropicMessageDelta({ stop_reason: "end_turn" }, { input_tokens: 5, output_tokens: 7 }),
    ]);
    const stream = await startTransportStream();
    const order: string[] = [];
    let textEndPhase: unknown;
    for await (const event of stream as AsyncIterable<{
      type: string;
      contentIndex?: number;
      partial?: { content?: Array<{ textSignature?: string }> };
    }>) {
      order.push(event.type);
      if (event.type === "text_end" && typeof event.contentIndex === "number") {
        const signature = event.partial?.content?.[event.contentIndex]?.textSignature;
        textEndPhase =
          typeof signature === "string"
            ? (JSON.parse(signature) as { phase?: string }).phase
            : undefined;
      }
    }
    expect(textEndPhase).toBe("commentary");
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
      anthropicMessageStart({ id: "msg_preview", usage: { input_tokens: 2, output_tokens: 0 } }),
      anthropicContentBlockStart(0, {
        type: "tool_use",
        id: "call_preview",
        name: "write",
        input: {},
      }),
      ...chunks.map((partial_json) =>
        anthropicContentBlockDelta(0, { type: "input_json_delta", partial_json }),
      ),
      { type: "content_block_stop", index: 0 },
      anthropicMessageDelta({ stop_reason: "tool_use" }, { input_tokens: 2, output_tokens: 2 }),
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
      anthropicMessageStart({ id: "msg_1", usage: { input_tokens: 10, output_tokens: 0 } }),
      anthropicContentBlockStart(0, {
        type: "tool_use",
        id: "tool_1",
        name: "Read",
        input: { path: "/tmp/a" },
      }),
      {
        type: "content_block_stop",
        index: 0,
      },
      anthropicMessageDelta({ stop_reason: "tool_use" }, { input_tokens: 10, output_tokens: 5 }),
      { type: "message_stop" },
    ]);
    const model = makeAnthropicTransportModel({});
    const stream = await startTransportStream(
      model,
      {
        systemPrompt: "Follow policy.",
        messages: [{ role: "user", content: "Read the file" }],
        tools: [
          {
            name: "Read",
            description: "Invalid case-colliding tool",
            parameters: {
              type: "object",
              properties: false,
            },
          },
          {
            name: "read",
            description: "Read a file",
            parameters: {
              type: "object",
              properties: {
                path: { type: "string" },
              },
              required: ["path"],
            },
          },
        ],
      } as unknown as AnthropicStreamContext,
      {
        apiKey: "sk-ant-oat-example",
        toolChoice: { type: "tool", name: "read" },
      } as AnthropicStreamOptions,
    );
    const result = await stream.result();

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
    const system = requireArray(firstCallParams.system, "system");
    expect(requireRecord(system[0], "billing system item").text).toBe(
      "x-anthropic-billing-header: cc_version=2.1.280; cc_entrypoint=sdk-cli;",
    );
    expect(
      system.some(
        (item) =>
          requireRecord(item, "system item").text ===
          "You are Claude Code, Anthropic's official CLI for Claude.",
      ),
    ).toBe(true);
    expect(
      system.some((item) => requireRecord(item, "system item").text === "Follow policy."),
    ).toBe(true);
    expect(
      requireArray(firstCallParams.tools, "tools").map((item) => requireRecord(item, "tool").name),
    ).toEqual(["Read"]);
    expect(firstCallParams.tool_choice).toEqual({ type: "tool", name: "Read" });
    expect(result.stopReason).toBe("toolUse");
    expect(result.content.some((item) => item.type === "toolCall" && item.name === "read")).toBe(
      true,
    );
  });

  it.each<{
    name: string;
    events: () => Record<string, unknown>[];
    fail?: boolean;
    content?: unknown[];
    firstBlock?: Record<string, unknown>;
    textEvents?: string[];
  }>([
    {
      name: "preserves signed bytes and replaces only completed seed signatures",
      events: () => [
        anthropicMessageStart({ id: "msg_1", usage: { input_tokens: 6, output_tokens: 0 } }),
        anthropicContentBlockStart(0, {
          type: "thinking",
          thinking: `keep${String.fromCharCode(0xd83d)}signed`,
          signature: "sig_1",
        }),
        anthropicContentBlockDelta(0, { type: "signature_delta", signature: "sig_2" }),
        anthropicContentBlockDelta(0, { type: "signature_delta", signature: "sig_3" }),
        { type: "content_block_stop", index: 0 },
        anthropicContentBlockStart(1, {
          type: "thinking",
          thinking: "seeded",
          signature: "seed_signature",
        }),
        anthropicContentBlockStart(2, { type: "text", text: "NO_REPLY" }),
        { type: "content_block_stop", index: 2 },
        { type: "content_block_stop", index: 1 },
        anthropicMessageDelta({ stop_reason: "end_turn" }, { input_tokens: 6, output_tokens: 9 }),
      ],
      content: [
        expect.objectContaining({
          type: "thinking",
          thinking: `keep${String.fromCharCode(0xd83d)}signed`,
          thinkingSignature: "sig_2sig_3",
        }),
        { type: "thinking", thinking: "seeded", thinkingSignature: "seed_signature" },
        { type: "text", text: "NO_REPLY" },
      ],
      textEvents: ["NO_REPLY", "NO_REPLY"],
    },
    {
      name: "does not persist partial signatures when the response body fails",
      events: createInterruptedThinkingEvents,
      fail: true,
      firstBlock: { type: "thinking", thinking: "step by step", thinkingSignature: "" },
    },
    {
      name: "commits only stopped signatures across interleaved thinking blocks",
      events: () => [
        anthropicMessageStart({ id: "msg_1", usage: { input_tokens: 6, output_tokens: 0 } }),
        anthropicContentBlockStart(0, { type: "thinking", thinking: "first", signature: "" }),
        anthropicContentBlockStart(1, { type: "thinking", thinking: "second", signature: "" }),
        anthropicContentBlockDelta(1, { type: "signature_delta", signature: "complete-second" }),
        anthropicContentBlockDelta(0, { type: "signature_delta", signature: "partial-first" }),
        { type: "content_block_stop", index: 1 },
      ],
      content: [
        expect.objectContaining({ type: "thinking", thinking: "first", thinkingSignature: "" }),
        expect.objectContaining({
          type: "thinking",
          thinking: "second",
          thinkingSignature: "complete-second",
        }),
      ],
    },
  ])("$name", async ({ events, fail, content, firstBlock, textEvents: expectedText }) => {
    guardedFetchMock.mockResolvedValueOnce(
      fail
        ? createFailingSseResponse(events(), new Error("response body failed"))
        : createSseResponse(events()),
    );
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
    if (firstBlock) {
      expect(result.content[0]).toMatchObject(firstBlock);
    }
    if (expectedText) {
      expect(textEvents).toEqual(expectedText);
    }
    if (fail) {
      expect(result.stopReason).toBe("error");
    }
  });

  it("captures OpenAI-style reasoning_content deltas from Anthropic-compatible streams", async () => {
    mockSse([
      anthropicMessageStart({ id: "msg_1", usage: { input_tokens: 6, output_tokens: 0 } }),
      anthropicContentBlockDelta(0, { content: "", reasoning_content: "Need " }),
      anthropicContentBlockDelta(0, { content: "", reasoning_content: "context." }),
      anthropicContentBlockDelta(0, { content: "Visible answer.", reasoning_content: "" }),
      anthropicContentBlockDelta(0, { content: " Continued.", reasoning_content: null }),
      {
        type: "content_block_stop",
        index: 0,
      },
      anthropicMessageDelta({ stop_reason: "end_turn" }, { input_tokens: 6, output_tokens: 2 }),
    ]);
    const model = makeAnthropicTransportModel({
      id: "mimo-v2.5",
      name: "MiMo V2.5",
      provider: "xiaomi-token-plan-ams",
      baseUrl: "https://token-plan-ams.xiaomimimo.com/anthropic",
    });

    const firstResult = await runTransportStream(model, undefined, {
      apiKey: "sk-xiaomi-test",
      reasoning: "high",
    } as AnthropicStreamOptions);

    expect(firstResult.content).toEqual([
      {
        type: "thinking",
        thinking: "Need context.",
        thinkingSignature: "reasoning_content",
      },
      {
        type: "text",
        text: "Visible answer. Continued.",
      },
    ]);

    await runTransportStream(
      model,
      {
        messages: [
          { role: "user", content: "think" },
          {
            ...firstResult,
            timestamp: 0,
          },
          { role: "user", content: "continue" },
        ],
      } as AnthropicStreamContext,
      {
        apiKey: "sk-xiaomi-test",
        reasoning: "high",
      } as AnthropicStreamOptions,
    );

    const assistantMessage = findRecord(
      latestAnthropicRequest().payload.messages,
      (record) => record.role === "assistant",
    );
    expect(assistantMessage.reasoning_content).toBe("Need context.");
    expect(assistantMessage.content).toEqual([
      {
        type: "thinking",
        thinking: "Need context.",
        signature: "reasoning_content",
      },
      { type: "text", text: "Visible answer. Continued." },
    ]);
  });

  it("preserves native text_delta chunks that also carry reasoning_content", async () => {
    mockSse([
      anthropicMessageStart({ id: "msg_1", usage: { input_tokens: 6, output_tokens: 0 } }),
      anthropicContentBlockStart(0, { type: "text", text: "" }),
      anthropicContentBlockDelta(0, {
        type: "text_delta",
        content: "Visible ",
        text: "Visible ",
        reasoning_content: "Need ",
      }),
      anthropicContentBlockDelta(0, { content: "answer", reasoning_content: null }),
      anthropicContentBlockDelta(0, { type: "text_delta", text: "." }),
      {
        type: "content_block_stop",
        index: 0,
      },
      anthropicMessageDelta({ stop_reason: "end_turn" }, { input_tokens: 6, output_tokens: 2 }),
    ]);

    const result = await runTransportStream(
      makeAnthropicTransportModel({
        id: "mimo-v2.5",
        name: "MiMo V2.5",
        provider: "xiaomi-token-plan-ams",
        baseUrl: "https://token-plan-ams.xiaomimimo.com/anthropic",
      }),
      undefined,
      {
        apiKey: "sk-xiaomi-test",
        reasoning: "high",
      } as AnthropicStreamOptions,
    );

    expect(result.content).toEqual([
      {
        type: "text",
        text: "Visible answer.",
      },
      {
        type: "thinking",
        thinking: "Need ",
        thinkingSignature: "reasoning_content",
      },
    ]);
  });

  it("recovers orphan text deltas when an Anthropic-compatible provider omits block start", async () => {
    mockSse([
      anthropicMessageStart({ id: "msg_1", usage: { input_tokens: 6, output_tokens: 0 } }),
      anthropicContentBlockDelta(0, { type: "text_delta", text: "你好" }),
      {
        type: "content_block_stop",
        index: 0,
      },
      anthropicMessageDelta({ stop_reason: "end_turn" }, { input_tokens: 6, output_tokens: 1 }),
    ]);
    const stream = await startTransportStream(
      makeAnthropicTransportModel({
        provider: "kimi-coding",
        baseUrl: "https://api.kimi.com/coding/",
      }),
      undefined,
      {
        apiKey: "kimi-key",
      } as AnthropicStreamOptions,
    );
    const events: Array<{ type?: string; delta?: string; content?: string }> = [];
    for await (const event of stream as AsyncIterable<{
      type?: string;
      delta?: string;
      content?: string;
    }>) {
      events.push(event);
    }
    const result = await stream.result();

    expect(result.content).toEqual([{ type: "text", text: "你好" }]);
    expect(result.stopReason).toBe("stop");
    expect(events.some((event) => event.type === "text_start")).toBe(true);
    expect(events.some((event) => event.type === "text_delta" && event.delta === "你好")).toBe(
      true,
    );
    expect(events.some((event) => event.type === "text_end" && event.content === "你好")).toBe(
      true,
    );
  });

  it.each([false, true])("quarantines malformed tools (valid sibling=%s)", async (withValid) => {
    const result = await runTransportStream(
      makeAnthropicTransportModel(),
      {
        messages: [{ role: "user", content: "hello" }],
        tools: [
          {
            name: "unreadable_plugin_tool",
            description: "unreadable schema",
            get parameters() {
              throw new Error("fuzz parameters getter exploded");
            },
          },
          ...(withValid
            ? [
                {
                  name: "bad_plugin_tool",
                  description: "missing schema",
                  execute: async () => ({ content: [{ type: "text", text: "bad" }] }),
                },
                {
                  name: "invalid_properties_tool",
                  description: "invalid properties",
                  parameters: { type: "object", properties: false },
                },
                {
                  name: "good_plugin_tool",
                  description: "valid schema",
                  parameters: {
                    type: "object",
                    properties: {
                      query: { $ref: "#/$defs/Query" },
                    },
                    $defs: { Query: { type: "string", minLength: 1 } },
                    required: ["query"],
                    additionalProperties: false,
                  },
                },
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

    const tools = requireArray(latestAnthropicRequest().payload.tools, "tools");
    expect(tools).toHaveLength(1);
    const tool = requireRecord(tools[0], "tool");
    expect(tool.name).toBe("good_plugin_tool");
    expect(tool.input_schema).toEqual({
      type: "object",
      properties: { query: { $ref: "#/$defs/Query" } },
      $defs: { Query: { type: "string", minLength: 1 } },
      required: ["query"],
      additionalProperties: false,
    });
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
            {
              name: "Read",
              description: "Uppercase tool",
              parameters: { type: "object", properties: invalidOriginal ? false : {} },
            },
            {
              name: "read",
              description: "Lowercase tool",
              parameters: { type: "object", properties: {} },
            },
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
            {
              type: "toolCall",
              id: "call_1",
              name: "lookup",
              arguments: "{not valid json",
            },
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

  it.each([false, true])(
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
            makeAnthropicToolUseMessage(
              [{ type: "thinking", thinking: "Retained thought", thinkingSignature: "" }],
              { provider: "kimi", id: "k3" },
            ),
          ],
        },
        { apiKey: "synthetic-kimi-key", reasoning: "high" },
      );
      const assistant = findRecord(
        latestAnthropicRequest().payload.messages,
        (msg) => msg.role === "assistant",
      );
      expect(assistant.content).toEqual(
        allowEmptySignature
          ? [{ type: "thinking", thinking: "Retained thought", signature: "" }]
          : [{ type: "text", text: "Retained thought" }],
      );
    },
  );

  it.each(["claude-sonnet-4-6", "claude-fable-5"])(
    "preserves signed thinking bytes and empty signed blocks on %s replay",
    async (modelId) => {
      const signed = `keep${String.fromCharCode(0xd83d)}signed`;
      const model = makeAnthropicTransportModel({ id: modelId });
      await runTransportStream(
        model,
        {
          messages: [
            makeAnthropicToolUseMessage(
              [
                { type: "thinking", thinking: signed, thinkingSignature: "sig_1" },
                { type: "thinking", thinking: "", thinkingSignature: "sig_omitted" },
              ],
              model,
            ),
          ],
        },
        { apiKey: "sk-ant-api", reasoning: "high" },
      );
      const assistant = findRecord(
        latestAnthropicRequest().payload.messages,
        (msg) => msg.role === "assistant",
      );
      expect(assistant.content).toEqual([
        { type: "thinking", thinking: signed, signature: "sig_1" },
        { type: "thinking", thinking: "", signature: "sig_omitted" },
      ]);
    },
  );

  it("omits completed thinking while preserving the active tool turn when thinking is disabled", async () => {
    await runTransportStream(makeAnthropicTransportModel(), {
      messages: [
        makeUserMessage("hello", 0),
        {
          ...makeAnthropicToolUseMessage([
            { type: "thinking", thinking: "private reasoning", thinkingSignature: "sig_1" },
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
            {
              type: "thinking",
              thinking: "Private replay text.",
              thinkingSignature: "reasoning_content",
            },
            { type: "text", text: "Visible reply." },
          ]),
          stopReason: "stop",
        },
        makeUserMessage("look it up", 2),
        makeAnthropicToolUseMessage([
          { type: "thinking", thinking: "call lookup", thinkingSignature: "sig_tool" },
          { type: "toolCall", id: "call_1", name: "lookup", arguments: {} },
        ]),
        {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "lookup",
          content: [{ type: "text", text: "42" }],
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
      [{ type: "text", text: "[assistant reasoning omitted]" }],
      [{ type: "text", text: "Visible reply." }],
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
                {
                  type: "thinking",
                  thinking: `Need${String.fromCharCode(0xd83d)} to answer politely.`,
                  thinkingSignature: "reasoning_content",
                },
                { type: "text", text: "Hello!" },
                {
                  type: "thinking",
                  thinking: "Then ask a follow-up.",
                  thinkingSignature: "reasoning_content",
                },
              ],
              replayModel,
            ),
            stopReason: "stop",
          },
          makeUserMessage("look this up", 1),
          makeAnthropicToolUseMessage(
            [{ type: "toolCall", id: "call_1", name: "lookup", arguments: {} }],
            replayModel,
          ),
          {
            role: "toolResult",
            toolCallId: "call_1",
            toolName: "lookup",
            content: [{ type: "text", text: "found" }],
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
        { type: "text", text: "Hello!" },
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
          content: [
            { type: "text", text: "look" },
            { type: "image", data: "aW1hZ2U=", mimeType: "image/heic" },
          ],
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
      [{ type: "text", text: String.fromCharCode(0xd83d) }],
      [{ ...image, data: "" }],
      [{ type: "text", text: "" }, image],
      [resource],
      [
        { type: "text", text: "before image" },
        image,
        resource,
        { type: "text", text: "after image" },
      ],
    ];
    await runTransportStream(makeAnthropicTransportModel({ input: ["text", "image"] }), {
      messages: [
        makeAnthropicToolUseMessage(
          results.map((_, index) => ({
            type: "toolCall",
            id: `tool_${index}`,
            name: "lookup",
            arguments: {},
          })),
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
    expect(projected[2]).toEqual([{ type: "text", text: "(see attached image)" }, wireImage]);
    expect(projected[3]).toBe(JSON.stringify(resource));
    expect(projected[4]).toEqual([
      { type: "text", text: "before image" },
      wireImage,
      { type: "text", text: JSON.stringify(resource) },
      { type: "text", text: "after image" },
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
        makeAnthropicToolUseMessage([
          { type: "toolCall", id: "tool_1", name: "screenshot", arguments: {} },
        ]),
        {
          role: "toolResult",
          toolCallId: "tool_1",
          toolName: "screenshot",
          content: [image, { type: "text", text: "captured screen" }],
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
        body: serializeSseEvents([
          anthropicMessageStart({ id: "msg_1", usage: { input_tokens: 1, output_tokens: 0 } }),
        ]),
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
      name: "maps unsupported xhigh to high effort for Claude 4.6 transport runs",
      model: { id: "claude-opus-4-6", name: "Claude Opus 4.6", maxTokens: 8192 },
      message: "Think deeply.",
      options: { apiKey: "sk-ant-api", reasoning: "xhigh" },
      expected: {
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: "high" },
      },
      absent: ["tool_choice"],
    },
    {
      name: "honors provider effort restrictions for mandatory adaptive thinking",
      model: {
        id: "claude-fable-5",
        name: "Claude Fable 5",
        provider: "github-copilot",
        reasoning: false,
        thinkingLevelMap: { xhigh: null, max: null },
        maxTokens: 128_000,
      },
      message: "Think carefully.",
      options: { apiKey: "copilot-token", reasoning: "xhigh" },
      expected: {
        thinking: { type: "adaptive", display: "summarized" },
        output_config: { effort: "high" },
      },
    },
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
      model: {
        id: "production-claude",
        name: "Production Claude",
        params: { canonicalModelId: "claude-opus-4-8" },
        reasoning: false,
        thinkingLevelMap: { xhigh: "xhigh", max: "max" },
        maxTokens: 8192,
      },
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
      model: {
        id: "production-claude",
        name: "Production Claude",
        params: { canonicalModelId: "claude-opus-4-6" },
        reasoning: false,
        thinkingLevelMap: { xhigh: "xhigh", max: "max" },
        maxTokens: 8192,
      },
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
      name: "defaults the newer optional-thinking model to adaptive high",
      model: { id: "claude-sonnet-5", name: "Claude Sonnet 5", maxTokens: 128_000 },
      context: makeSonnet5PrefillContext(),
      options: { apiKey: "sk-ant-api", temperature: 0.2, toolChoice: "any" },
      expected: {
        max_tokens: 128_000,
        messages: [{ role: "user" }],
        thinking: { type: "adaptive", display: "summarized" },
        tool_choice: { type: "auto" },
      },
      exact: { output_config: { effort: "high" } },
      absent: ["temperature"],
    },
    {
      name: "uses default mandatory adaptive thinking for a deployment alias",
      model: {
        id: "prod-primary",
        name: "Production Claude",
        provider: "microsoft-foundry",
        params: { canonicalModelId: "claude-fable-5" },
        reasoning: false,
        baseUrl: "https://example.services.ai.azure.com/anthropic",
        maxTokens: 128_000,
      },
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
      model: {
        id: "prod-mythos",
        name: "Production Claude",
        provider: "microsoft-foundry",
        params: { canonicalModelId: "claude-mythos-5" },
        reasoning: false,
        baseUrl: "https://example.services.ai.azure.com/anthropic",
        maxTokens: 128_000,
      },
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
      name: "restores default sampling after payload hooks",
      model: { id: "claude-opus-4-8", name: "claude-opus-4-8", maxTokens: 128_000 },
      options: {
        apiKey: "sk-ant-api",
        reasoning: "high",
        temperature: 0.2,
        onPayload: (payload) => ({
          ...requireRecord(payload, "payload"),
          temperature: 0.2,
          top_p: 0.9,
          top_k: 40,
        }),
      },
      absent: ["temperature", "top_p", "top_k"],
    },
    {
      name: "preserves supported native max effort",
      model: {
        id: "claude-opus-4-8",
        name: "Claude Opus 4.8",
        maxTokens: 8192,
        thinkingLevelMap: { xhigh: "xhigh", max: "max" },
      },
      message: "Think as much as needed.",
      options: { apiKey: "sk-ant-api", reasoning: "max" },
      exact: {
        thinking: {
          type: "adaptive",
          display: "summarized",
          block_binding: { prefix_mismatch_behavior: "drop_block" },
        },
        output_config: { effort: "max" },
      },
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
          anthropicMessageStart({
            id: "msg_1",
            model: responseModel,
            usage: { input_tokens: 1, output_tokens: 0 },
          }),
          anthropicMessageDelta({ stop_reason: "end_turn" }, { input_tokens: 1, output_tokens: 1 }),
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
    const stream = await startTransportStream(makeAnthropicTransportModel(), undefined, options);

    const eventTypes: string[] = [];
    for await (const event of stream) {
      eventTypes.push(event.type);
    }

    expect(eventTypes).toEqual(["error"]);
    await expect(stream.result()).resolves.toMatchObject({ stopReason: "error", errorMessage });
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
        anthropicMessageStart({
          id: "msg_loopback",
          model: "claude-opus-5",
          usage: { input_tokens: 4, output_tokens: 0 },
        }),
        ...blocks.flatMap(({ id, name, partialJson }, index) => [
          anthropicContentBlockStart(index, { type: "tool_use", id, name, input: {} }),
          anthropicContentBlockDelta(index, {
            type: "input_json_delta",
            partial_json: partialJson,
          }),
          { type: "content_block_stop", index },
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
