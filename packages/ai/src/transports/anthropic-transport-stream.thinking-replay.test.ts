/**
 * Tests completed-turn thinking replay in Anthropic Messages transport requests.
 */
import type { AssistantMessage, Model } from "@openclaw/llm-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUserMessage } from "../../../../test/helpers/user-message.js";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import { createZeroUsage } from "../usage.test-support.js";

const { buildGuardedModelFetchMock, guardedFetchMock } = vi.hoisted(() => ({
  buildGuardedModelFetchMock: vi.fn(),
  guardedFetchMock: vi.fn(),
}));

const coreTransportHost = getAiTransportHost();

let createAnthropicMessagesTransportStreamFn: typeof import("./anthropic-transport-stream.js").createAnthropicMessagesTransportStreamFn;

type AnthropicMessagesModel = Model<"anthropic-messages">;

function resolveTestEndpointClass(baseUrl?: string): string {
  const hostname = new URL(baseUrl ?? "https://api.anthropic.com").hostname.toLowerCase();
  if (hostname === "api.anthropic.com") {
    return "anthropic-public";
  }
  if (hostname === "api.xiaomimimo.com" || hostname.endsWith(".xiaomimimo.com")) {
    return "xiaomi-native";
  }
  return "custom";
}

function createSseResponse(events: Record<string, unknown>[]): Response {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function latestAnthropicRequest() {
  const [, init] = guardedFetchMock.mock.calls.at(-1) ?? [];
  const body = init?.body;
  return {
    payload: typeof body === "string" ? (JSON.parse(body) as Record<string, unknown>) : {},
  };
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

async function runTransportStream(
  model: AnthropicMessagesModel,
  context: Parameters<ReturnType<typeof createAnthropicMessagesTransportStreamFn>>[1],
  options: { apiKey: string } = { apiKey: "sk-ant-api" },
) {
  return (await createAnthropicMessagesTransportStreamFn()(model, context, options)).result();
}

describe("anthropic transport thinking replay", () => {
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
          usesExplicitProxyLikeEndpoint: endpointClass === "custom",
          allowsAnthropicServiceTier: endpointClass === "anthropic-public",
        };
      },
    });
    guardedFetchMock.mockResolvedValue(
      createSseResponse([
        {
          type: "message_start",
          message: { id: "msg_default", usage: { input_tokens: 0, output_tokens: 0 } },
        },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { input_tokens: 0, output_tokens: 0 },
        },
        { type: "message_stop" },
      ]),
    );
  });

  afterAll(() => {
    configureAiTransportHost(coreTransportHost);
  });

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
      [
        {
          type: "text",
          text: "[assistant reasoning omitted]",
          cache_control: { type: "ephemeral" },
        },
      ],
      [{ type: "text", text: "Visible reply.", cache_control: { type: "ephemeral" } }],
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
      {
        type: "tool_use",
        id: "call_1",
        name: "lookup",
        input: {},
        cache_control: { type: "ephemeral" },
      },
    ]);
    expect(assistants[1]).not.toHaveProperty("reasoning_content");
    expect(payload).not.toHaveProperty("thinking");
  });
});
