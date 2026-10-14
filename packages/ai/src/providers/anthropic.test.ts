// Anthropic provider tests cover stream events, tools, and message mapping.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost } from "../host.js";
import type { AssistantMessage, Context, Model, Tool } from "../types.js";
import {
  SYSTEM_PROMPT_CACHE_BOUNDARY,
  SYSTEM_PROMPT_RELOCATABLE_BOUNDARY,
  SYSTEM_PROMPT_RELOCATABLE_BOUNDARY_END,
} from "../utils/system-prompt-cache-boundary.js";

const anthropicMockState = vi.hoisted(() => ({
  configs: [] as unknown[],
  requestOptions: [] as unknown[],
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = {
      create: vi.fn((_payload: unknown, requestOptions: unknown) => {
        anthropicMockState.requestOptions.push(requestOptions);
        throw new Error("stop after constructor");
      }),
    };

    constructor(config: unknown) {
      anthropicMockState.configs.push(config);
    }
  },
}));

import { makeTextToolResult } from "../../../../test/helpers/text-tool-result.js";
import { createZeroUsage } from "../usage.test-support.js";
import { streamAnthropic, streamSimpleAnthropic } from "./anthropic.js";

function user(
  content: Extract<Context["messages"][number], { role: "user" }>["content"],
  timestamp = 0,
): Extract<Context["messages"][number], { role: "user" }> {
  return { role: "user", content, timestamp };
}
function conversation(...messages: Context["messages"]): Context {
  return { messages };
}
function thinking(
  text: string,
  thinkingSignature: string,
): Extract<AssistantMessage["content"][number], { type: "thinking" }> {
  return { type: "thinking", thinking: text, thinkingSignature };
}

function createSseResponse(events: Record<string, unknown>[] = []): Response {
  const body = events
    .map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function createAnthropicSseClient(events: Record<string, unknown>[]) {
  return {
    messages: {
      create: vi.fn(() => ({
        asResponse: () => Promise.resolve(createSseResponse(events)),
      })),
    },
  };
}

function startStream(
  client: ReturnType<typeof createAnthropicSseClient>,
  model: Partial<Model<"anthropic-messages">> = {},
  context: Context = { messages: [user("hello")] },
  options: NonNullable<Parameters<typeof streamAnthropic>[2]> = {},
) {
  return streamAnthropic(makeAnthropicModel(model), context, {
    apiKey: "sk-ant-provider",
    client: client as never,
    ...options,
  });
}
async function consumeStream(stream: ReturnType<typeof streamAnthropic>) {
  const eventTypes: string[] = [];
  for await (const event of stream) {
    eventTypes.push(event.type);
  }
  return { eventTypes, result: await stream.result() };
}

function wireUsage(input: number, output: number, cacheRead: number, cacheWrite: number | null) {
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
  };
}

function messageStart(usage: Record<string, unknown>, model?: string) {
  return { type: "message_start", message: { id: "msg_test", model, usage } };
}
function blockStart(index: number, content_block: Record<string, unknown>) {
  return { type: "content_block_start", index, content_block };
}
function blockDelta(index: number, delta: Record<string, unknown>) {
  return { type: "content_block_delta", index, delta };
}
function blockStop(index: number) {
  return { type: "content_block_stop", index };
}
function messageDelta(delta: Record<string, unknown>, usage?: Record<string, unknown>) {
  return { type: "message_delta", delta, usage };
}

function makeAnthropicModel(overrides: Partial<Model<"anthropic-messages">> = {}) {
  return {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    provider: "anthropic",
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 4096,
    ...overrides,
  } satisfies Model<"anthropic-messages">;
}

function makeAnthropicAssistantMessage(
  content: AssistantMessage["content"],
  overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
  return {
    role: "assistant",
    provider: "anthropic",
    api: "anthropic-messages",
    model: "claude-sonnet-4-6",
    stopReason: "stop",
    timestamp: 0,
    usage: createZeroUsage(),
    content,
    ...overrides,
  };
}

type ToolResultContent = Extract<Context["messages"][number], { role: "toolResult" }>["content"];
function toolContext(content: ToolResultContent, isError = false, provider = "anthropic"): Context {
  return {
    messages: [
      makeAnthropicAssistantMessage(
        [{ type: "toolCall", id: "call_1", name: "lookup", arguments: {} }],
        { provider, stopReason: "toolUse" },
      ),
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "lookup",
        content,
        isError,
        timestamp: 0,
      },
    ],
  };
}
function wireMessages(payload: Record<string, unknown>) {
  return payload.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
}
function assistantContent(payload: Record<string, unknown>) {
  return wireMessages(payload).find((message) => message.role === "assistant")?.content;
}
function getToolResult(payload: Record<string, unknown>) {
  const result = wireMessages(payload)
    .find((message) => message.role === "user")
    ?.content.find((block) => block.type === "tool_result");
  if (!result) {
    throw new Error("Expected an Anthropic tool result");
  }
  return result;
}

type SimpleAnthropicTestOptions = Omit<
  NonNullable<Parameters<typeof streamSimpleAnthropic>[2]>,
  "onPayload"
> & {
  mode?: "simple";
  injectPayload?: Record<string, unknown>;
  stopBeforeNetwork?: boolean;
};

type RawAnthropicTestOptions = Omit<
  NonNullable<Parameters<typeof streamAnthropic>[2]>,
  "onPayload"
> & {
  mode: "raw";
  injectPayload?: Record<string, unknown>;
  stopBeforeNetwork?: boolean;
};

async function captureSimpleAnthropicPayload(
  model: Partial<Model<"anthropic-messages">>,
  options: SimpleAnthropicTestOptions | RawAnthropicTestOptions = {},
  context: Context = { messages: [user("hello")] },
) {
  const { injectPayload, stopBeforeNetwork, mode, ...streamOptions } = options;
  let capturedPayload: unknown;
  const requestOptions = {
    apiKey: "sk-ant-provider",
    ...streamOptions,
    onPayload: (payload: unknown) => {
      capturedPayload = injectPayload
        ? { ...(payload as Record<string, unknown>), ...injectPayload }
        : payload;
      if (stopBeforeNetwork) {
        throw new Error("stop before network");
      }
      return capturedPayload;
    },
  };
  const resolvedModel = makeAnthropicModel(model);
  const stream =
    mode === "raw"
      ? streamAnthropic(resolvedModel, context, requestOptions)
      : streamSimpleAnthropic(resolvedModel, context, requestOptions);
  const result = await stream.result();
  return { payload: capturedPayload as Record<string, unknown>, result };
}

function tinyJpegBase64(): string {
  return Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  ]).toString("base64");
}

function configureTestAnthropicImageNormalizer(): void {
  configureAiTransportHost({
    normalizeAnthropicInlineContentBlocks: async (content) =>
      content.map((block) =>
        block.type === "image" ? { ...block, mimeType: "image/jpeg" } : block,
      ),
  });
}

describe("Anthropic provider", () => {
  beforeEach(() => {
    anthropicMockState.configs = [];
    anthropicMockState.requestOptions = [];
  });

  afterEach(() => {
    configureAiTransportHost({});
  });

  it("keeps Cloudflare upstream auth on the Anthropic API key", async () => {
    const hostFetch: typeof fetch = async () => new Response(null, { status: 500 });
    configureAiTransportHost({ buildModelFetch: () => hostFetch });
    await streamAnthropic(
      makeAnthropicModel({
        provider: "cloudflare-ai-gateway",
        baseUrl: "https://gateway.ai.cloudflare.com/v1/account/gateway/anthropic/v1/messages",
        headers: { "cf-aig-authorization": "Bearer gateway-token" },
      }),
      conversation(user("hello", 1)),
      { apiKey: "sk-ant-provider" },
    ).result();
    expect(anthropicMockState.configs).toHaveLength(1);
    expect(anthropicMockState.configs[0]).toMatchObject({
      apiKey: "sk-ant-provider",
      authToken: null,
      fetch: hostFetch,
      defaultHeaders: { "cf-aig-authorization": "Bearer gateway-token" },
    });
    expect(anthropicMockState.configs[0]).not.toHaveProperty("defaultHeaders.x-api-key");
  });
  it("keeps sentinel-backed Foundry headers on bearer routing", async () => {
    const sentinel = "oc-sent-v2.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.end";
    configureAiTransportHost({
      buildModelFetch: () => async () => new Response(null, { status: 500 }),
      resolveSecretSentinel: (value) => value.replaceAll(sentinel, "Bearer entra-access-token"),
    });
    await streamAnthropic(
      makeAnthropicModel({
        provider: "microsoft-foundry",
        baseUrl: "https://example.services.ai.azure.com/anthropic",
        headers: { Authorization: sentinel },
      }),
      conversation(user("hello", 1)),
      { apiKey: sentinel },
    ).result();
    expect(anthropicMockState.configs).toHaveLength(1);
    expect(anthropicMockState.configs[0]).toMatchObject({ apiKey: null, authToken: sentinel });
  });

  it.each(["long"] as const)(
    "sends the OpenCode session header with %s cache retention",
    async (cacheRetention) => {
      streamAnthropic(
        makeAnthropicModel({ baseUrl: "https://opencode.ai/zen/go" }),
        conversation(user("hello", 1)),
        { apiKey: "sk-ant-provider", sessionId: "session-123", cacheRetention },
      );
      await vi.waitFor(() => expect(anthropicMockState.configs).toHaveLength(1));
      const config = anthropicMockState.configs[0] as {
        defaultHeaders?: Record<string, string | null>;
      };
      expect(
        Object.fromEntries(
          Object.entries(config.defaultHeaders ?? {}).filter(
            ([key]) => key.startsWith("x-") || key === "session_id",
          ),
        ),
      ).toEqual({ "x-opencode-session": "session-123" });
    },
  );

  it("puts Claude subscription billing identity first for OAuth requests", async () => {
    const { payload: capturedPayload, result } = await captureSimpleAnthropicPayload(
      {},
      { apiKey: "sk-ant-oat01-test-token" },
      conversation(user("hello", 1)),
    );

    expect(result.stopReason).toBe("error");
    expect((capturedPayload as { system?: unknown }).system).toEqual([
      {
        type: "text",
        text: "x-anthropic-billing-header: cc_version=2.1.280; cc_entrypoint=sdk-cli;",
      },
      {
        type: "text",
        text: "You are Claude Code, Anthropic's official CLI for Claude.",
        cache_control: { type: "ephemeral" },
      },
    ]);
  });

  it("includes compaction iterations in billed usage while keeping final context usage", async () => {
    const client = createAnthropicSseClient([
      messageStart(wireUsage(12, 0, 120_000, null), "claude-fable-5"),
      blockStart(0, { type: "text", text: "" }),
      blockDelta(0, { type: "text_delta", text: "Done." }),
      blockStop(0),
      messageDelta(
        { stop_reason: "end_turn" },
        {
          ...wireUsage(12, 15_104, 819_661, 93_130),
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
      ),
      { type: "message_stop" },
    ]);

    const result = await startStream(client, {
      id: "claude-fable-5",
      name: "Claude Fable 5",
      cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    }).result();

    expect(result.usage).toMatchObject({
      input: 24,
      output: 16_104,
      cacheRead: 968_523,
      cacheWrite: 93_130,
      contextUsage: {
        state: "available",
        promptTokens: 148_874,
        totalTokens: 163_978,
      },
      totalTokens: 1_077_781,
    });
    expect(result.usage.cost.total).toBeCloseTo(1.469044, 6);
  });

  it.each([null])(
    "captures streamed Anthropic compaction deltas and replays final opaque metadata %s",
    async (encryptedContent) => {
      const firstClient = createAnthropicSseClient([
        messageStart({ input_tokens: 50_001, output_tokens: 0 }, "claude-sonnet-4-6"),
        blockStart(0, {
          type: "compaction",
          content: null,
          encrypted_content: "opaque-initial-compaction",
        }),
        blockDelta(0, {
          type: "compaction_delta",
          content: "summary ",
          encrypted_content: "opaque-partial-compaction",
        }),
        blockDelta(0, {
          type: "compaction_delta",
          content: "checkpoint",
          encrypted_content: encryptedContent,
        }),
        blockStop(0),
        blockStart(1, { type: "text", text: "" }),
        blockDelta(1, { type: "text_delta", text: "Done." }),
        blockStop(1),
        messageDelta({ stop_reason: "compaction" }, { input_tokens: 1, output_tokens: 1 }),
        { type: "message_stop" },
      ]);
      const replayOptions = {
        anthropicServerCompaction: true,
        authProfileId: "anthropic:work",
        sessionId: "session-1",
      } as const;
      const firstUser = { role: "user" as const, content: "old question", timestamp: 0 };
      const first = await startStream(firstClient, {}, conversation(firstUser), {
        ...replayOptions,
      }).result();

      expect(first.stopReason).toBe("stop");
      expect(first.providerReplay).toMatchObject({
        type: "anthropic-compaction",
        data: "summary checkpoint",
        replayIndex: 0,
      });

      let replayPayload: Record<string, unknown> | undefined;
      const secondClient = createAnthropicSseClient([
        messageStart({ input_tokens: 1 }, "claude-sonnet-4-6"),
        messageDelta({ stop_reason: "end_turn" }, { input_tokens: 1, output_tokens: 1 }),
        { type: "message_stop" },
      ]);
      // oxlint-disable-next-line unicorn/prefer-structured-clone -- Verify persisted provider replay after JSON transcript reload.
      const savedMessages: Context["messages"] = JSON.parse(
        JSON.stringify([firstUser, first, user("new question", 2)]),
      );
      await startStream(
        secondClient,
        {},
        { messages: savedMessages },
        {
          ...replayOptions,
          onPayload: (payload) => {
            replayPayload = payload as Record<string, unknown>;
          },
        },
      ).result();

      const replayMessages = replayPayload?.messages as Array<Record<string, unknown>>;
      expect(replayMessages.map((message) => message.role)).toEqual(["assistant", "user"]);
      expect(replayMessages[0]?.content).toEqual([
        {
          type: "compaction",
          content: "summary checkpoint",
          encrypted_content: encryptedContent,
        },
        { type: "text", text: "Done." },
      ]);
    },
  );

  it.each([
    {
      name: "keeps final context unavailable for a malformed final iteration",
      initial: wireUsage(12, 0, 120_000, 0),
      final: {
        ...wireUsage(12, 15_104, 819_661, 93_130),
        iterations: [
          { type: "message", ...wireUsage(12, 15_104, 148_862, 0), input_tokens: "malformed" },
        ],
      },
      expectedUsage: { totalTokens: 927_907 },
      contextUsage: { state: "unavailable" },
    },
    {
      name: "settles complete final usage after zero message-start placeholders",
      initial: wireUsage(0, 0, 0, 0),
      final: wireUsage(12, 15_104, 148_862, 0),
      expectedUsage: { totalTokens: 163_978 },
      contextUsage: { state: "available", promptTokens: 148_874, totalTokens: 163_978 },
    },
    {
      name: "preserves valid initial billing buckets when a sibling is malformed",
      initial: { ...wireUsage(12, 0, 0, 500), cache_read_input_tokens: "malformed" },
      final: { input_tokens: 12, output_tokens: 15_104, cache_creation_input_tokens: null },
      expectedUsage: {
        input: 12,
        output: 15_104,
        cacheRead: 0,
        cacheWrite: 500,
        totalTokens: 15_616,
      },
      contextUsage: { state: "unavailable" },
    },
  ])("$name", async ({ initial, final, expectedUsage, contextUsage }) => {
    const client = createAnthropicSseClient([
      messageStart(initial, "claude-fable-5"),
      messageDelta({ stop_reason: "end_turn" }, final),
      { type: "message_stop" },
    ]);
    const result = await startStream(client, {
      id: "claude-fable-5",
      name: "Claude Fable 5",
    }).result();
    expect(result.usage).toMatchObject(expectedUsage);
    expect(result.usage.contextUsage).toEqual(contextUsage);
  });

  it("ignores a message_delta whose usage object is omitted", async () => {
    const client = createAnthropicSseClient([
      messageStart(wireUsage(12, 0, 3, 4), "claude-sonnet-4-6"),
      messageDelta({ stop_reason: "end_turn" }),
      { type: "message_stop" },
    ]);

    const result = await startStream(client, {
      cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    }).result();

    expect(result.stopReason).toBe("stop");
    expect(result.usage).toMatchObject({
      input: 12,
      output: 0,
      cacheRead: 3,
      cacheWrite: 4,
      totalTokens: 19,
      contextUsage: { state: "available", promptTokens: 19, totalTokens: 19 },
    });
    expect(result.usage.cost.input).toBeCloseTo(0.00006, 10);
    expect(result.usage.cost.total).toBeGreaterThan(0);
  });

  it("prices reported 1-hour cache writes at twice the input rate", async () => {
    const client = createAnthropicSseClient([
      messageStart(
        {
          ...wireUsage(100, 0, 0, 1_000_000),
          cache_creation: {
            ephemeral_5m_input_tokens: 600_000,
            ephemeral_1h_input_tokens: 400_000,
          },
        },
        "claude-sonnet-4-6",
      ),
      messageDelta({ stop_reason: "end_turn" }, { output_tokens: 5 }),
      { type: "message_stop" },
    ]);

    const result = await startStream(client, {
      cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    }).result();

    expect(result.usage).toMatchObject({
      cacheWrite: 1_000_000,
      cacheWrite1h: 400_000,
    });
    expect(result.usage.cost.cacheWrite).toBeCloseTo(7.75, 10);
  });

  it("pins Anthropic SDK retries to zero", async () => {
    const model = makeAnthropicModel();
    await streamAnthropic(model, conversation(user("hello"))).result();

    expect(anthropicMockState.requestOptions).toEqual([expect.objectContaining({ maxRetries: 0 })]);
    expect(anthropicMockState.configs.at(-1)).toMatchObject({ maxRetries: 0 });
  });

  it.each([
    { allowEmptySignature: undefined, expectedType: "text", expectedSignature: undefined },
    { allowEmptySignature: true, expectedType: "thinking", expectedSignature: "" },
  ])(
    "replays empty thinking signatures as $expectedType",
    async ({ allowEmptySignature, expectedType, expectedSignature }) => {
      const { payload } = await captureSimpleAnthropicPayload(
        allowEmptySignature === undefined ? {} : { compat: { allowEmptySignature } },
        { mode: "raw", thinkingEnabled: true },
        conversation(
          user("first"),
          makeAnthropicAssistantMessage([thinking("private analysis", " ")]),
          user("second"),
        ),
      );
      const [block] = assistantContent(payload) ?? [];
      expect(block).toMatchObject({ type: expectedType });
      expect(block?.signature).toBe(expectedSignature);
    },
  );

  it("preserves provider-signed Anthropic thinking and drops reasoning_content placeholders", async () => {
    const highSurrogate = String.fromCharCode(0xd83d);
    const signedThinking = `keep${highSurrogate}signed`;
    let capturedPayload: unknown;
    const client = createAnthropicSseClient([
      messageStart({ input_tokens: 1, output_tokens: 0 }, "claude-fable-5"),
      messageDelta({ stop_reason: "end_turn" }, { input_tokens: 1, output_tokens: 1 }),
      { type: "message_stop" },
    ]);

    const stream = startStream(
      client,
      {
        id: "claude-fable-5",
        name: "Claude Fable 5",
      },
      conversation(
        user("hello"),
        makeAnthropicAssistantMessage(
          [
            thinking(signedThinking, "sig_1"),
            thinking("", "sig_omitted"),
            thinking(`sanitize${highSurrogate}synthetic`, "reasoning_content"),
          ],
          { model: "claude-fable-5" },
        ),
        user("again"),
      ),
      {
        onPayload: (payload) => {
          capturedPayload = payload;
        },
      },
    );

    const result = await stream.result();

    const payload = capturedPayload as { messages: Array<{ role: string; content: unknown[] }> };
    const assistantMessage = payload.messages.find((message) => message.role === "assistant");
    expect(JSON.stringify(assistantMessage?.content)).not.toContain("reasoning_content");
    expect(assistantMessage?.content).toEqual([
      {
        type: "thinking",
        thinking: signedThinking,
        signature: "sig_1",
      },
      {
        type: "thinking",
        thinking: "",
        signature: "sig_omitted",
      },
    ]);
    expect(result.responseModel).toBe("claude-fable-5");
  });

  it("omits completed-turn thinking when no thinking mode is requested", async () => {
    const { payload } = await captureSimpleAnthropicPayload(
      {},
      { mode: "raw", stopBeforeNetwork: true },
      conversation(
        user("hello"),
        makeAnthropicAssistantMessage([
          thinking("private reasoning", "sig_1"),
          {
            type: "thinking",
            thinking: "[Reasoning redacted]",
            thinkingSignature: "opaque_1",
            redacted: true,
          },
        ]),
        user("again"),
      ),
    );
    expect(payload.thinking).toBeUndefined();
    expect(assistantContent(payload)).toEqual([
      { type: "text", text: "[assistant reasoning omitted]" },
    ]);
  });

  it("preserves signed thinking for an active tool turn when new thinking is disabled", async () => {
    const { payload: capturedPayload } = await captureSimpleAnthropicPayload(
      {},
      { mode: "raw", thinkingEnabled: false, stopBeforeNetwork: true },
      conversation(
        user("look it up"),
        makeAnthropicAssistantMessage(
          [
            thinking("call lookup", "sig_tool"),
            { type: "toolCall", id: "call_1", name: "lookup", arguments: {} },
          ],
          { stopReason: "toolUse" },
        ),
        makeTextToolResult("call_1", "lookup", "42", false, 0),
      ),
    );

    const payload = capturedPayload as {
      messages: Array<{ role: string; content: unknown[] }>;
    };
    expect(payload.messages.find((message) => message.role === "assistant")?.content).toEqual([
      { type: "thinking", thinking: "call lookup", signature: "sig_tool" },
      { type: "tool_use", id: "call_1", name: "lookup", input: {} },
    ]);
  });

  it.each([{ modelMaxTokens: undefined, expectedMaxTokens: 5_000 }])(
    "resolves explicit output requests with model limit $modelMaxTokens",
    async ({ modelMaxTokens, expectedMaxTokens }) => {
      const model = makeAnthropicModel({
        id: "claude-opus-4-5",
        name: "Claude Opus 4.5",
        contextWindow: 4_000,
        maxTokens: modelMaxTokens,
      });
      const { payload: capturedPayload } = await captureSimpleAnthropicPayload(
        model,
        { apiKey: "test-api-key", maxTokens: 5_000, reasoning: "off", stopBeforeNetwork: true },
        conversation(
          makeAnthropicAssistantMessage(
            [
              thinking("private reasoning ".repeat(1_000), "sig_old"),
              { type: "text", text: "Visible answer." },
            ],
            { model: model.id },
          ),
          user("again"),
        ),
      );

      expect(capturedPayload.max_tokens).toBe(expectedMaxTokens);
    },
  );

  it.each([500])(
    "restores the caller output cap when thinking cannot fit with model limit %s",
    async (maxTokens) => {
      const model = makeAnthropicModel({
        id: "claude-haiku-4-5",
        name: "Claude Haiku 4.5",
        contextWindow: 4_000,
        maxTokens,
      });
      const { payload: capturedPayload } = await captureSimpleAnthropicPayload(
        model,
        { apiKey: "test-api-key", maxTokens: 32, reasoning: "low", stopBeforeNetwork: true },
        conversation(
          makeAnthropicAssistantMessage(
            [
              thinking("private reasoning ".repeat(1_000), "sig_tool"),
              { type: "toolCall", id: "call_1", name: "lookup", arguments: {} },
            ],
            { model: model.id, stopReason: "toolUse" },
          ),
          makeTextToolResult("call_1", "lookup", "42", false, 0),
        ),
      );

      expect(capturedPayload as { max_tokens?: number; thinking?: unknown }).toMatchObject({
        max_tokens: 32,
      });
      expect((capturedPayload as { thinking?: unknown }).thinking).toEqual({ type: "disabled" });
    },
  );

  it("preserves mixed text and image tool-result order", async () => {
    const imageData = Buffer.from("image").toString("base64");
    const { payload: capturedPayload } = await captureSimpleAnthropicPayload(
      { input: ["text", "image"] },
      { mode: "raw", stopBeforeNetwork: true },
      toolContext(
        [
          { type: "text", text: "before image" },
          { type: "image", data: imageData, mimeType: "image/png" },
          {
            type: "resource" as const,
            resource: { uri: "https://example.com/data.json", text: '{"key":"value"}' },
          },
          { type: "text", text: "after image" },
        ] as unknown as ToolResultContent,
        false,
      ),
    );

    const toolResult = getToolResult(capturedPayload);

    expect(toolResult.content).toEqual([
      { type: "text", text: "before image" },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: imageData,
        },
      },
      { type: "text", text: expect.stringContaining('{"type":"resource"') },
      { type: "text", text: "after image" },
    ]);
  });

  it("normalizes unsupported user image blocks before Anthropic payloads", async () => {
    configureTestAnthropicImageNormalizer();
    const imageData = tinyJpegBase64();
    const { payload: capturedPayload, result } = await captureSimpleAnthropicPayload(
      { input: ["text", "image"] },
      { mode: "raw", apiKey: "test-api-key", stopBeforeNetwork: true },
      conversation(
        user([
          { type: "text", text: "look" },
          { type: "image", mimeType: "image/heic", data: imageData },
        ]),
      ),
    );

    expect(result.stopReason).toBe("error");
    const [userMessage] = (capturedPayload as { messages: [Record<string, unknown>] }).messages;
    const imageBlock = (userMessage.content as Array<Record<string, unknown>>)[1];
    expect(imageBlock).toMatchObject({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: imageData },
    });
  });

  it("keeps non-vision image downgrade behavior without invoking normalization", async () => {
    configureAiTransportHost({
      normalizeAnthropicInlineContentBlocks: async () => {
        throw new Error("non-vision images should be downgraded before normalization");
      },
    });
    const { payload: capturedPayload, result } = await captureSimpleAnthropicPayload(
      { input: ["text"] },
      { mode: "raw", apiKey: "test-api-key", stopBeforeNetwork: true },
      conversation(
        user([
          { type: "text", text: "look" },
          { type: "image", mimeType: "image/heic", data: "not-base64" },
        ]),
      ),
    );

    expect(result.stopReason).toBe("error");
    const [userMessage] = (capturedPayload as { messages: [Record<string, unknown>] }).messages;
    expect(userMessage.content).toMatchObject([
      { type: "text", text: "look" },
      { type: "text", text: "(image omitted: model does not support images)" },
    ]);
  });

  it("normalizes unsupported tool result image blocks before Anthropic payloads", async () => {
    configureTestAnthropicImageNormalizer();
    const imageData = tinyJpegBase64();
    const { payload: capturedPayload, result } = await captureSimpleAnthropicPayload(
      { input: ["text", "image"] },
      { mode: "raw", apiKey: "test-api-key", stopBeforeNetwork: true },
      toolContext([{ type: "image", data: imageData, mimeType: "image/tiff" }], false),
    );

    expect(result.stopReason).toBe("error");
    const [, userMessage] = (
      capturedPayload as { messages: [Record<string, unknown>, Record<string, unknown>] }
    ).messages;
    const [toolResult] = userMessage.content as [Record<string, unknown>];
    const imageBlock = (toolResult.content as Array<Record<string, unknown>>)[1];
    expect(imageBlock).toMatchObject({
      type: "image",
      source: { type: "base64", media_type: "image/jpeg", data: imageData },
    });
  });

  it("does not emit Anthropic image blocks or placeholders for payload-less tool media", async () => {
    const { payload: capturedPayload } = await captureSimpleAnthropicPayload(
      { input: ["text", "image"] },
      { mode: "raw", apiKey: "fixture", stopBeforeNetwork: true },
      toolContext([{ type: "image", data: "", mimeType: "image/png" }], false),
    );

    const toolResult = getToolResult(capturedPayload);
    expect(toolResult?.content).toBe("");
    expect(JSON.stringify(toolResult)).not.toContain('"source"');
    expect(JSON.stringify(toolResult)).not.toContain("see attached image");
  });

  it.each([["invalid-surrogate-only", String.fromCharCode(0xd83d)]])(
    "replaces %s error tool results with non-empty content",
    async (_label, text) => {
      const { payload: capturedPayload } = await captureSimpleAnthropicPayload(
        { provider: "github-copilot" },
        { mode: "raw", apiKey: "copilot-token", stopBeforeNetwork: true },
        toolContext([{ type: "text", text }], true, "github-copilot"),
      );

      const payload = capturedPayload as {
        messages: Array<{ role: string; content: Array<Record<string, unknown>> }>;
      };
      const userMessage = payload.messages.find((message) => message.role === "user");
      const toolResult = userMessage?.content.find((entry) => entry.type === "tool_result");
      expect(toolResult).toMatchObject({
        content: "[tool error with no output]",
        is_error: true,
      });
    },
  );

  it.each([["claude-mythos-5", "Claude Mythos 5", "anthropic-vertex", "vertex-token"]])(
    "surfaces structured %s streaming refusals for %s",
    async (id, name, provider) => {
      const client = createAnthropicSseClient([
        messageStart({ input_tokens: 3, output_tokens: 0 }),
        blockStart(0, { type: "text", text: "" }),
        blockDelta(0, { type: "text_delta", text: "discard this partial output" }),
        blockStop(0),
        messageDelta(
          {
            stop_reason: "refusal",
            stop_details: {
              type: "refusal",
              category: "cyber",
              explanation: "This request is not allowed.",
            },
          },
          { input_tokens: 3, output_tokens: 2 },
        ),
        { type: "message_stop" },
      ]);

      const stream = startStream(client, {
        id,
        name,
        provider,
      });
      const eventTypes: string[] = [];
      for await (const event of stream) {
        eventTypes.push(event.type);
      }
      const result = await stream.result();

      expect(eventTypes).toEqual(["error"]);
      expect(result.stopReason).toBe("error");
      expect(result.content).toEqual([]);
      expect(result.errorMessage).toBe(
        "Anthropic refusal (category: cyber): This request is not allowed.",
      );
      expect(result.usage).toMatchObject({ input: 3, output: 2 });
      expect(result.diagnostics).toEqual([
        expect.objectContaining({
          type: "provider_refusal",
          details: {
            provider,
            category: "cyber",
            explanation: "This request is not allowed.",
          },
        }),
      ]);
    },
  );

  it.each([
    { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
    {
      id: "claude-opus-5-5",
      name: "Opus 5.5 with model betas",
      headers: { "Anthropic-Beta": "files-api-2025-04-14" },
      customBeta: true,
    },
  ])(
    "sends default server-side fallback params for direct $name API-key requests",
    async ({ customBeta, ...model }) => {
      const { payload: capturedPayload } = await captureSimpleAnthropicPayload(model, {
        mode: "raw",
      });

      expect((capturedPayload as { fallbacks?: unknown }).fallbacks).toBe("default");
      const requestOptions = anthropicMockState.requestOptions[0] as {
        headers?: Record<string, string>;
      };
      const betas = requestOptions.headers?.["anthropic-beta"]?.split(",");
      expect(betas).toContain("server-side-fallback-2026-07-01");
      if (customBeta) {
        expect(betas).toContain("files-api-2025-04-14");
      }
    },
  );

  it("rebuilds Fable output at a mid-stream server-side fallback boundary", async () => {
    const client = createAnthropicSseClient([
      messageStart({ input_tokens: 5, output_tokens: 0 }, "claude-fable-5"),
      blockStart(0, { type: "thinking", thinking: "" }),
      blockDelta(0, { type: "thinking_delta", thinking: "pre-boundary reasoning" }),
      blockStop(0),
      blockStart(1, { type: "text", text: "" }),
      blockDelta(1, { type: "text_delta", text: "partial " }),
      blockStop(1),
      blockStart(2, { type: "tool_use", id: "call_1", name: "lookup", input: {} }),
      blockStop(2),
      blockStart(3, {
        type: "fallback",
        from: { model: "claude-fable-5" },
        to: { model: "claude-opus-4-8" },
      }),
      blockStop(3),
      blockStart(4, { type: "text", text: "" }),
      blockDelta(4, { type: "text_delta", text: "continued" }),
      blockStop(4),
      messageDelta({ stop_reason: "end_turn" }, { input_tokens: 5, output_tokens: 9 }),
      { type: "message_stop" },
    ]);

    const stream = startStream(client, {
      id: "claude-fable-5",
      name: "Claude Fable 5",
      cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
    });
    const { eventTypes, result } = await consumeStream(stream);

    // Pre-boundary thinking/tool blocks must not replay or execute; text is
    // the continuation prefix the fallback model built on.
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
    expect(eventTypes).not.toContain("thinking_start");
    expect(eventTypes).not.toContain("toolcall_start");
    expect(eventTypes.filter((type) => type === "start")).toHaveLength(1);
    // Fallback-served turns bill at the serving model's rates, not Fable's:
    // 5 input tokens at $5/MTok plus 9 output tokens at $25/MTok.
    expect(result.usage.cost.input).toBeCloseTo(0.000025, 10);
    expect(result.usage.cost.output).toBeCloseTo(0.000225, 10);
    expect(result.usage.cost.total).toBeCloseTo(0.00025, 10);
  });

  it("routes interleaved active content blocks by their event indexes", async () => {
    const client = createAnthropicSseClient([
      messageStart({ input_tokens: 1, output_tokens: 0 }),
      blockStart(0, { type: "text" }),
      blockStart(1, { type: "text" }),
      blockDelta(1, { type: "text_delta", text: "second" }),
      blockDelta(0, { type: "text_delta", text: "first" }),
      blockStop(1),
      blockStop(0),
      messageDelta({ stop_reason: "end_turn" }, { input_tokens: 1, output_tokens: 2 }),
      { type: "message_stop" },
    ]);

    const result = await startStream(client).result();

    expect(result.content).toEqual([
      { type: "text", text: "first" },
      { type: "text", text: "second" },
    ]);
  });

  it("rejects a malformed later tool before any sibling becomes executable", async () => {
    const client = createAnthropicSseClient([
      messageStart({ input_tokens: 1, output_tokens: 0 }),
      blockStart(0, { type: "tool_use", id: "call_valid", name: "read", input: {} }),
      blockDelta(0, { type: "input_json_delta", partial_json: '{"path":"README.md"}' }),
      blockStop(0),
      blockStart(1, { type: "tool_use", id: "call_invalid", name: "read", input: {} }),
      blockDelta(1, { type: "input_json_delta", partial_json: '{"path":"SECRET.md"' }),
      blockStop(1),
      messageDelta({ stop_reason: "tool_use" }, { input_tokens: 1, output_tokens: 2 }),
      { type: "message_stop" },
    ]);
    const stream = startStream(client);
    const { eventTypes, result } = await consumeStream(stream);

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe("Provider completed tool call with malformed JSON arguments");
    expect(result.errorMessage).not.toContain("SECRET.md");
    expect(eventTypes).not.toContain("toolcall_end");
    expect(eventTypes).not.toContain("done");
  });

  it("rejects an active tool call that never receives content_block_stop", async () => {
    const client = createAnthropicSseClient([
      messageStart({ input_tokens: 1, output_tokens: 0 }),
      blockStart(0, { type: "tool_use", id: "call_unsealed", name: "read", input: {} }),
      blockDelta(0, { type: "input_json_delta", partial_json: '{"path":"README.md"' }),
      messageDelta({ stop_reason: "tool_use" }, { input_tokens: 1, output_tokens: 1 }),
      { type: "message_stop" },
    ]);
    const stream = startStream(client);
    const { eventTypes, result } = await consumeStream(stream);

    expect(result.stopReason).toBe("error");
    expect(eventTypes.at(-1)).toBe("error");
    expect(eventTypes).not.toContain("toolcall_end");
    expect(eventTypes).not.toContain("done");
    expect(result.content.some((block) => block.type === "toolCall")).toBe(false);
  });

  it("uses a complete tool input seeded at block start when no deltas arrive", async () => {
    const client = createAnthropicSseClient([
      messageStart({ input_tokens: 1, output_tokens: 0 }),
      blockStart(0, {
        type: "tool_use",
        id: "call_seeded",
        name: "read",
        input: { path: "README.md" },
      }),
      blockStop(0),
      messageDelta({ stop_reason: "tool_use" }, { input_tokens: 1, output_tokens: 1 }),
      { type: "message_stop" },
    ]);

    const result = await startStream(client).result();

    expect(result.content).toContainEqual(
      expect.objectContaining({ type: "toolCall", arguments: { path: "README.md" } }),
    );
  });

  it("discards buffered Fable output when the stream fails before terminal status", async () => {
    const client = createAnthropicSseClient([
      blockStart(0, { type: "text", text: "" }),
      blockDelta(0, { type: "text_delta", text: "unsafe partial output" }),
    ]);
    const stream = startStream(client, { id: "claude-fable-5", name: "Claude Fable 5" });
    const { eventTypes, result } = await consumeStream(stream);

    expect(eventTypes).toEqual(["error"]);
    expect(result.stopReason).toBe("error");
    expect(result.content).toEqual([]);
    expect(result.errorMessage).toContain("ended before message_stop");
  });

  it("terminates the stream when the thrown error is a circular structure", async () => {
    // Socket/HTTP layers raise self-referential error objects; a bare
    // JSON.stringify in stream teardown throws and strands the run (#106568).
    const circular: Record<string, unknown> = { code: "ECONNRESET" };
    circular.self = circular;
    // Transport layers reject with plain objects, not Error instances, which is
    // what sends the formatter down the JSON.stringify branch.
    const asResponse = vi.fn().mockRejectedValue(circular);
    const client = {
      messages: {
        create: vi.fn(() => ({ asResponse })),
      },
    };
    const stream = startStream(client, { id: "claude-fable-5", name: "Claude Fable 5" });
    const { eventTypes, result } = await consumeStream(stream);

    expect(eventTypes).toEqual(["error"]);
    expect(result.stopReason).toBe("error");
    // Keep salient transport fields while replacing the cycle, so the terminal
    // diagnostic remains actionable without stranding the stream.
    expect(result.errorMessage).toBe('{"code":"ECONNRESET","self":"[Circular]"}');
  });

  it("terminates the stream when provider terminal accessors throw", async () => {
    const hostile = Object.create(null) as Record<string, unknown>;
    Object.defineProperties(hostile, {
      code: { enumerable: true, value: "ECONNRESET" },
      safe: { enumerable: true, value: "socket failed" },
      status: {
        enumerable: true,
        get: () => {
          throw new Error("status getter");
        },
      },
      body: {
        enumerable: true,
        get: () => {
          throw new Error("body getter");
        },
      },
      message: {
        enumerable: true,
        get: () => {
          throw new Error("message getter");
        },
      },
    });
    const asResponse = vi.fn().mockRejectedValue(hostile);
    const client = { messages: { create: vi.fn(() => ({ asResponse })) } };
    const stream = startStream(client, { id: "claude-fable-5", name: "Claude Fable 5" });
    const { eventTypes, result } = await consumeStream(stream);

    expect(eventTypes).toEqual(["error"]);
    expect(result).toMatchObject({
      stopReason: "error",
      errorCode: "ECONNRESET",
    });
    expect(result.errorMessage).toContain("socket failed");
  });

  it("strips Fable thinking when replay targets Anthropic Vertex", async () => {
    const { payload } = await captureSimpleAnthropicPayload(
      { provider: "anthropic-vertex", id: "claude-opus-4-8", name: "Claude Opus 4.8" },
      { mode: "raw", apiKey: "vertex-token" },
      conversation(
        user("hello"),
        makeAnthropicAssistantMessage(
          [
            thinking("model-bound thought", "sig_model_bound"),
            { type: "text", text: "visible answer" },
          ],
          { model: "claude-fable-5" },
        ),
        user("continue"),
      ),
    );
    const assistant = wireMessages(payload).find((message) => message.role === "assistant");
    expect(assistant?.content).toEqual([{ type: "text", text: "visible answer" }]);
    expect(JSON.stringify(assistant)).not.toContain("sig_model_bound");
  });

  it("normalizes adaptive requests and post-hook sampling for canonical deployment aliases", async () => {
    const { payload } = await captureSimpleAnthropicPayload(
      {
        id: "prod-opus",
        name: "Production Claude",
        provider: "microsoft-foundry",
        params: { canonicalModelId: "claude-opus-5" },
        reasoning: false,
        baseUrl: "https://example.services.ai.azure.com/anthropic",
        maxTokens: 128_000,
      },
      {
        temperature: 0.2,
        injectPayload: { temperature: 0.2, service_tier: "auto", top_p: 0.9, top_k: 40 },
      },
      conversation(
        user("hello"),
        makeAnthropicAssistantMessage([{ type: "text", text: "prefill" }]),
      ),
    );
    expect(payload).toMatchObject({
      messages: [{ role: "user" }],
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "high" },
    });
    for (const key of ["temperature", "top_p", "top_k", "service_tier"]) {
      expect(payload).not.toHaveProperty(key);
    }
  });
  it("does not infer adaptive thinking from forward-compatible effort maps", async () => {
    const { payload } = await captureSimpleAnthropicPayload(
      {
        id: "claude-future",
        name: "Future Claude",
        provider: "github-copilot",
        reasoning: true,
        thinkingLevelMap: { xhigh: null, max: "max" },
      },
      { apiKey: "copilot-token", reasoning: "max", stopBeforeNetwork: true },
    );
    expect(payload).toMatchObject({ thinking: { type: "enabled" } });
    expect(payload).not.toHaveProperty("output_config");
  });

  it.each([{ budgetTokens: 512, maxTokens: 8192 }])(
    "normalizes raw manual thinking budget $budgetTokens below max $maxTokens",
    async ({ budgetTokens, maxTokens }) => {
      const model = makeAnthropicModel({
        id: "claude-haiku-4-5",
        name: "Claude Haiku 4.5",
        maxTokens: 8192,
      });
      const { payload: capturedPayload } = await captureSimpleAnthropicPayload(
        model,
        {
          mode: "raw",
          maxTokens,
          temperature: 0.2,
          thinkingEnabled: true,
          thinkingBudgetTokens: budgetTokens,
          toolChoice: "any",
          stopBeforeNetwork: true,
        },
        {
          messages: [user("hello")],
          tools: [{ name: "lookup", description: "Lookup", parameters: { type: "object" } }],
        },
      );

      expect(capturedPayload).toMatchObject({
        thinking: { type: "disabled" },
        temperature: 0.2,
        tool_choice: { type: "any" },
      });
    },
  );

  it.each([
    { reasoning: "xhigh", thinkingLevelMap: { xhigh: null, max: null }, effort: "high" },
  ] as const)("honors provider effort restrictions for Claude Fable 5: %j", async (testCase) => {
    const { payload } = await captureSimpleAnthropicPayload(
      {
        id: "claude-fable-5",
        name: "Claude Fable 5",
        provider: "github-copilot",
        reasoning: false,
        thinkingLevelMap: testCase.thinkingLevelMap,
      },
      { apiKey: "copilot-token", reasoning: testCase.reasoning },
    );
    expect(payload).toMatchObject({
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: testCase.effort },
    });
  });

  it("forwards simple stop sequences to Anthropic stop_sequences", async () => {
    const { payload, result } = await captureSimpleAnthropicPayload(
      {},
      { stop: ["STOP"], stopBeforeNetwork: true },
    );
    expect(result.stopReason).toBe("error");
    expect(payload.stop_sequences).toEqual(["STOP"]);
  });

  it("skips unreadable Anthropic provider tools while preserving healthy siblings", async () => {
    const unreadableTool = {
      name: "unreadable_plugin_tool",
      description: "unreadable schema",
      get parameters(): Tool["parameters"] {
        throw new Error("fuzz parameters getter exploded");
      },
    } as Tool;
    const { payload: capturedPayload, result } = await captureSimpleAnthropicPayload(
      {},
      { mode: "raw", stopBeforeNetwork: true },
      {
        messages: [user("hello")],
        tools: [
          unreadableTool,
          {
            name: "invalid_required_tool",
            description: "invalid required",
            parameters: {
              type: "object",
              properties: { query: { type: "string" } },
              required: "query",
            },
          } as unknown as Tool,
          {
            name: "healthy_tool",
            description: "healthy schema",
            parameters: {
              type: "object",
              properties: { query: { $ref: "#/$defs/Query" } },
              $defs: { Query: { type: "string", minLength: 1 } },
              required: ["query"],
              additionalProperties: false,
            },
          } as Tool,
        ],
      },
    );

    const payload = capturedPayload as {
      tools?: Array<{ name?: string; input_schema?: unknown }>;
    };

    expect(result.stopReason).toBe("error");
    expect(payload.tools?.map((tool) => tool.name)).toEqual(["healthy_tool"]);
    expect(payload.tools?.[0]?.input_schema).toEqual({
      type: "object",
      properties: { query: { $ref: "#/$defs/Query" } },
      $defs: { Query: { type: "string", minLength: 1 } },
      required: ["query"],
      additionalProperties: false,
    });
  });

  it("fails locally when a pinned Anthropic provider tool is skipped", async () => {
    const unreadableTool = {
      name: "unreadable_plugin_tool",
      description: "unreadable schema",
      get parameters(): Tool["parameters"] {
        throw new Error("fuzz parameters getter exploded");
      },
    } as Tool;
    const onPayload = vi.fn();
    const stream = streamAnthropic(
      makeAnthropicModel(),
      {
        messages: [user("hello")],
        tools: [
          unreadableTool,
          {
            name: "healthy_tool",
            description: "healthy schema",
            parameters: { type: "object", properties: {} },
          } as Tool,
        ],
      },
      {
        apiKey: "sk-ant-provider",
        toolChoice: { type: "tool", name: "unreadable_plugin_tool" },
        onPayload,
      },
    );

    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain(
      'Anthropic tool_choice requested unavailable tool "unreadable_plugin_tool"',
    );
    expect(onPayload).not.toHaveBeenCalled();
  });

  it("keeps Anthropic wire tool bytes and their cache breakpoint stable across discovery orders", async () => {
    const tools = [
      {
        name: "zeta_lookup",
        description: "Look up the last value",
        parameters: { type: "object", properties: { value: { type: "string" } } },
      },
      {
        name: "alpha_lookup",
        description: "Look up the first value",
        parameters: { type: "object", properties: { query: { type: "string" } } },
      },
    ] as Tool[];
    const captureTools = async (orderedTools: Tool[]) => {
      const { payload: capturedPayload } = await captureSimpleAnthropicPayload(
        {},
        { stopBeforeNetwork: true },
        {
          systemPrompt: "stable system",
          messages: [user("hello")],
          tools: orderedTools,
        },
      );
      return (capturedPayload as { tools: unknown[] }).tools;
    };

    const first = await captureTools(tools);
    const reversed = await captureTools(tools.toReversed());

    expect(reversed).toEqual(first);
    expect(first).toEqual([
      expect.objectContaining({ name: "alpha_lookup" }),
      expect.objectContaining({
        name: "zeta_lookup",
        cache_control: { type: "ephemeral" },
      }),
    ]);
    expect(first[0]).not.toHaveProperty("cache_control");
  });

  it("keeps the relocatable marker out of native Anthropic system blocks", async () => {
    // Native Anthropic relocates nothing, so the marker must not survive into
    // the payload while the cache breakpoint still lands on the stable prefix.
    const { payload: capturedPayload, result } = await captureSimpleAnthropicPayload(
      {},
      { stopBeforeNetwork: true },
      {
        systemPrompt: `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Reactions guidance${SYSTEM_PROMPT_RELOCATABLE_BOUNDARY}Runtime: session=alpha${SYSTEM_PROMPT_RELOCATABLE_BOUNDARY_END}`,
        messages: [user("hello")],
      },
    );

    expect(result.stopReason).toBe("error");
    const system = (capturedPayload as { system?: unknown }).system;
    const serialized = JSON.stringify(system);
    expect(serialized).not.toContain("OPENCLAW-RELOCATABLE-BOUNDARY");
    expect(serialized).not.toContain("OPENCLAW_CACHE_BOUNDARY");
    expect(system).toEqual([
      {
        type: "text",
        text: "Stable prefix",
        cache_control: { type: "ephemeral" },
      },
      {
        type: "text",
        text: "Reactions guidance\nRuntime: session=alpha",
      },
    ]);
  });

  it("anchors the message cache breakpoint before transient runtime context", async () => {
    const { payload: capturedPayload, result } = await captureSimpleAnthropicPayload(
      {},
      { stopBeforeNetwork: true },
      {
        systemPrompt: "system",
        messages: [
          user("stable question"),
          {
            role: "user",
            content: "OpenClaw runtime context:\ntransient current-turn metadata",
            timestamp: 1,
            runtimeContext: {},
          },
        ],
      },
    );

    expect(result.stopReason).toBe("error");
    const messages = (capturedPayload as { messages: { content: unknown }[] }).messages;
    expect(messages[0]?.content).toEqual([
      {
        type: "text",
        text: "stable question",
        cache_control: { type: "ephemeral" },
      },
    ]);
    expect(messages[1]?.content).toBe("OpenClaw runtime context:\ntransient current-turn metadata");
  });

  it("emits error without a preceding start event when SSE error arrives before message_start", async () => {
    function createSseEventResponse(lines: string): Response {
      return new Response(lines, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }

    const client = {
      messages: {
        create: vi.fn(() => ({
          asResponse: () =>
            Promise.resolve(
              createSseEventResponse(
                "event: error\ndata: " +
                  JSON.stringify({
                    type: "invalid_request_error",
                    message: "messages.1.content.63: Invalid signature in thinking block",
                  }) +
                  "\n\n",
              ),
            ),
        })),
      },
    };

    const stream = startStream(client, {}, conversation(user("hi")));

    const eventTypes: string[] = [];
    for await (const event of stream as AsyncIterable<{ type: string }>) {
      eventTypes.push(event.type);
    }

    // error must be the first event — no start emitted before it
    expect(eventTypes[0]).toBe("error");
    expect(eventTypes).not.toContain("start");
  });

  it("strips the internal cache boundary when Anthropic cache control is disabled", async () => {
    const { payload, result } = await captureSimpleAnthropicPayload(
      {},
      { cacheRetention: "none", stopBeforeNetwork: true },
      {
        systemPrompt: `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic suffix`,
        messages: [user("hello")],
      },
    );
    expect(result.stopReason).toBe("error");
    expect(payload.system).toEqual([{ type: "text", text: "Stable prefix\nDynamic suffix" }]);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
