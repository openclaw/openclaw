import type { ChatCompletionChunk } from "openai/resources/chat/completions.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context, Model, SimpleStreamOptions } from "../types.js";
import { onLlmRequestActivity } from "../utils/llm-request-activity.js";
import {
  SYSTEM_PROMPT_CACHE_BOUNDARY,
  SYSTEM_PROMPT_RELOCATABLE_BOUNDARY,
  SYSTEM_PROMPT_RELOCATABLE_BOUNDARY_END,
} from "../utils/system-prompt-cache-boundary.js";

type DeepPartial<T> = T extends object ? { [P in keyof T]?: DeepPartial<T[P]> } : T;
type OpenAICompatibleDelta = DeepPartial<ChatCompletionChunk["choices"][number]["delta"]> & {
  reasoning_content?: string;
  reasoning?: string;
  reasoning_text?: string;
  reasoning_details?: Array<Record<string, string>>;
};
type OpenAICompatibleChoice = Omit<
  DeepPartial<ChatCompletionChunk["choices"][number]>,
  "delta" | "message"
> & {
  delta?: OpenAICompatibleDelta;
  // Some OpenAI-compatible endpoints deliver a full message instead of delta.
  message?: OpenAICompatibleDelta;
};
type OpenAICompatibleChatCompletionChunk = Omit<
  DeepPartial<ChatCompletionChunk>,
  "choices" | "usage"
> & {
  choices?: OpenAICompatibleChoice[];
  usage?: DeepPartial<ChatCompletionChunk["usage"]> & { cost?: unknown };
};
type FirstEventOptions = {
  firstEventTimeoutMs?: number;
  onFirstEventTimeout?: (reason: Error) => void;
};
type FirstEventSimpleStreamOptions = SimpleStreamOptions & FirstEventOptions;

const mockChunksRef: {
  chunks: OpenAICompatibleChatCompletionChunk[];
  stream?: AsyncIterable<OpenAICompatibleChatCompletionChunk>;
} = { chunks: [] };
const mockOpenAIOptionsRef: { payloads: unknown[] } = { payloads: [] };

vi.mock("openai", () => {
  class MockOpenAI {
    chat = {
      completions: {
        create: (params: unknown) => {
          mockOpenAIOptionsRef.payloads.push(params);
          async function* generate() {
            yield* mockChunksRef.chunks;
          }
          return Object.assign(Promise.resolve(mockChunksRef.stream ?? generate()), {
            asResponse: async () => new Response(null, { status: 200 }),
          });
        },
      },
    };
  }
  return { default: MockOpenAI };
});

import { makeTextToolResult } from "../../../../test/helpers/text-tool-result.js";
import { makeUserMessage } from "../../../../test/helpers/user-message.js";
import { collectEventTypes } from "../transports/openai-stream-cases.test-support.js";
import { createZeroUsage } from "../usage.test-support.js";
import {
  streamOpenAICompletions,
  streamSimpleOpenAICompletions,
  type OpenAICompletionsOptions,
} from "./openai-completions.js";
import { makeOpenAIProviderModel } from "./openai-provider.test-support.js";

beforeEach(() => {
  mockChunksRef.chunks = [];
  mockChunksRef.stream = undefined;
  mockOpenAIOptionsRef.payloads = [];
});

const model = makeOpenAIProviderModel("openai-completions", { reasoning: false });

const reasoningModel = {
  ...model,
  reasoning: true,
} satisfies Model<"openai-completions">;

const context = {
  messages: [{ role: "user", content: "hi", timestamp: 1 }],
} satisfies Context;

function createModel(maxTokens: number): Model<"openai-completions"> {
  return {
    ...model,
    id: "custom-model",
    name: "Custom Model",
    provider: "custom-openai-compatible",
    baseUrl: "https://third-party.test/v1",
    contextWindow: 200_000,
    maxTokens,
  };
}

function deltaChunk(delta: OpenAICompatibleDelta): OpenAICompatibleChatCompletionChunk {
  return {
    id: "chatcmpl-test",
    choices: [{ index: 0, delta }],
  };
}
const makeTextChunk = (content: string) => deltaChunk({ content, role: "assistant" });

function request(
  requestModel: Model<"openai-completions"> = model,
  requestContext: Context = context,
  options: OpenAICompletionsOptions = {},
) {
  return streamOpenAICompletions(requestModel, requestContext, { apiKey: "sk-test", ...options });
}

async function capturePayload(
  requestModel: Model<"openai-completions"> = model,
  requestContext: Context = context,
  options: OpenAICompletionsOptions = {},
) {
  let captured: Record<string, unknown> = {};
  const result = await request(requestModel, requestContext, {
    ...options,
    onPayload(payload) {
      captured = payload as Record<string, unknown>;
      throw new Error("stop before network");
    },
  }).result();
  expect(result.stopReason).toBe("error");
  return captured;
}

async function collect(
  requestModel: Model<"openai-completions"> = model,
  options: OpenAICompletionsOptions = {},
) {
  const stream = request(requestModel, context, options);
  const eventTypes = await collectEventTypes(stream);
  return { result: await stream.result(), eventTypes };
}

function makeRefusalMessageChunk(refusal: string): OpenAICompatibleChatCompletionChunk {
  return {
    id: "chatcmpl-test",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: null, refusal },
        finish_reason: "stop",
      },
    ],
  };
}

function makeToolCallChunk(
  id: string,
  name: string,
  args: string,
  finishReason?: string,
): OpenAICompatibleChatCompletionChunk {
  return {
    id: "chatcmpl-test",
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [{ index: 0, id, function: { name, arguments: args }, type: "function" }],
        },
        finish_reason: finishReason as ChatCompletionChunk.Choice["finish_reason"],
      },
    ],
  };
}

function makeFinishChunk(
  finishReason: string,
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cost?: unknown;
  },
): OpenAICompatibleChatCompletionChunk {
  return {
    id: "chatcmpl-test",
    choices: [{ index: 0, delta: {}, finish_reason: finishReason as never }],
    ...(usage ? { usage } : {}),
  };
}

function createNeverYieldingStream(): AsyncIterable<OpenAICompatibleChatCompletionChunk> {
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          return new Promise<IteratorResult<OpenAICompatibleChatCompletionChunk>>(() => {});
        },
      };
    },
  };
}

describe("OpenAI-compatible completions params", () => {
  it.each([{ thinkingFormat: "qwen", expected: { enable_thinking: false } }] as const)(
    "treats reasoningEffort none as disabled for $thinkingFormat payloads",
    async ({ thinkingFormat, expected }) => {
      mockChunksRef.chunks = [makeTextChunk("ok"), makeFinishChunk("stop")];
      const compatibleModel = {
        ...reasoningModel,
        provider: "custom-openai-compatible",
        baseUrl: "https://third-party.test/v1",
        compat: { thinkingFormat, supportsReasoningEffort: true },
      } satisfies Model<"openai-completions">;

      await request(compatibleModel, context, { reasoningEffort: "none" }).result();

      expect(mockOpenAIOptionsRef.payloads[0]).toMatchObject(expected);
      expect(mockOpenAIOptionsRef.payloads[0]).not.toHaveProperty("reasoning_effort");
    },
  );

  it("omits reasoning_effort when deepseek-format compatibility disables it", async () => {
    mockChunksRef.chunks = [makeTextChunk("ok"), makeFinishChunk("stop")];
    const compatibleModel = {
      ...reasoningModel,
      provider: "longcat",
      baseUrl: "https://api.longcat.chat/openai",
      compat: {
        thinkingFormat: "deepseek" as const,
        supportsReasoningEffort: false,
      },
    } satisfies Model<"openai-completions">;

    await request(compatibleModel, context, { reasoningEffort: "high" }).result();

    expect(mockOpenAIOptionsRef.payloads[0]).toMatchObject({
      thinking: { type: "enabled" },
    });
    expect(mockOpenAIOptionsRef.payloads[0]).not.toHaveProperty("reasoning_effort");
  });

  it("surfaces aggregated chat-completions message.refusal as visible assistant text", async () => {
    mockChunksRef.chunks = [makeRefusalMessageChunk("Requests like this are not allowed.")];

    const result = await request().result();

    expect(result.content).toStrictEqual([
      { type: "text", text: "Requests like this are not allowed." },
    ]);
    expect(result.stopReason).toBe("stop");
  });

  it("carries the first-event timeout through the simple completions wrapper", async () => {
    vi.useFakeTimers();
    try {
      mockChunksRef.stream = createNeverYieldingStream();

      const simpleOptions: FirstEventSimpleStreamOptions = {
        apiKey: "sk-test",
        firstEventTimeoutMs: 5,
        onFirstEventTimeout: vi.fn(),
      };
      const stream = streamSimpleOpenAICompletions(model, context, simpleOptions);
      const resultPromise = stream.result();

      await vi.advanceTimersByTimeAsync(5);
      const result = await resultPromise;

      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toMatch(
        /completions HTTP stream opened but did not deliver a first SSE event within 5ms/,
      );
      expect(simpleOptions.onFirstEventTimeout).toHaveBeenCalledWith(expect.any(Error));
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips unreadable schemas while preserving healthy official OpenAI tools", async () => {
    const capturedPayload = await capturePayload(
      model,
      {
        ...context,
        tools: [
          {
            name: "broken",
            description: "Broken",
            parameters: {
              type: "object",
              get properties(): never {
                throw new Error("properties exploded");
              },
            },
          },
          {
            name: "lookup",
            description: "Lookup",
            parameters: {},
          },
        ],
      },
      {
        toolChoice: { type: "function", function: { name: "lookup" } },
      },
    );

    expect(capturedPayload?.tools).toEqual([
      {
        type: "function",
        function: {
          name: "lookup",
          description: "Lookup",
          parameters: {},
          strict: false,
        },
      },
    ]);
    expect(capturedPayload?.tool_choice).toEqual({
      type: "function",
      function: { name: "lookup" },
    });
  });

  it("keeps request bytes stable across equivalent tool input order", async () => {
    const tools = [
      {
        name: "zeta_tool",
        description: "Zeta tool",
        parameters: { type: "object", properties: {} },
      },
      {
        name: "alpha_tool",
        description: "Alpha tool",
        parameters: { type: "object", properties: {} },
      },
    ];
    const payloads: string[] = [];

    for (const orderedTools of [tools, tools.toReversed()]) {
      payloads.push(
        JSON.stringify(await capturePayload(model, { ...context, tools: orderedTools })),
      );
    }

    expect(payloads[0]).toBe(payloads[1]);
    expect(
      (
        JSON.parse(payloads[0] ?? "{}") as {
          tools: Array<{ function: { name: string } }>;
        }
      ).tools.map((tool) => tool.function.name),
    ).toEqual(["alpha_tool", "zeta_tool"]);
  });

  it("uses Z.AI max_tokens and disables thinking by default", async () => {
    const stream = streamOpenAICompletions(
      {
        ...createModel(32_000),
        provider: "zai",
        baseUrl: "https://api.z.ai/api/paas/v4",
        reasoning: true,
      },
      context,
      {
        apiKey: "sk-test",
        maxTokens: 1_024,
      },
    );

    await stream.result();

    expect(mockOpenAIOptionsRef.payloads[0]).toMatchObject({
      max_tokens: 1_024,
      thinking: { type: "disabled" },
    });
    expect(mockOpenAIOptionsRef.payloads[0]).not.toHaveProperty("max_completion_tokens");
    expect(mockOpenAIOptionsRef.payloads[0]).not.toHaveProperty("enable_thinking");
  });

  it("enables Z.AI thinking with the documented payload when requested", async () => {
    const stream = streamSimpleOpenAICompletions(
      {
        ...createModel(32_000),
        provider: "zai",
        baseUrl: "https://api.z.ai/api/paas/v4",
        reasoning: true,
      },
      context,
      {
        apiKey: "sk-test",
        reasoning: "max",
      },
    );

    await stream.result();

    expect(mockOpenAIOptionsRef.payloads[0]).toMatchObject({
      thinking: { type: "enabled", clear_thinking: false },
    });
    expect(mockOpenAIOptionsRef.payloads[0]).not.toHaveProperty("reasoning_effort");
    expect(mockOpenAIOptionsRef.payloads[0]).not.toHaveProperty("enable_thinking");
  });

  it("forwards simple stop sequences to request params", async () => {
    let capturedStop: unknown;
    const stream = streamSimpleOpenAICompletions(createModel(32_000), context, {
      apiKey: "sk-test",
      stop: ["STOP"],
      onPayload(payload) {
        capturedStop = (payload as { stop?: unknown }).stop;
        throw new Error("stop before network");
      },
    });

    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(capturedStop).toEqual(["STOP"]);
  });

  it("carries bounded Runtime facts on the first user turn for OpenAI-compatible providers", async () => {
    const { messages: capturedMessages } = await capturePayload(createModel(32_000), {
      systemPrompt: `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic suffix${SYSTEM_PROMPT_RELOCATABLE_BOUNDARY}Runtime facts${SYSTEM_PROMPT_RELOCATABLE_BOUNDARY_END}`,
      messages: [{ role: "user", content: "hi", timestamp: 1 }],
    });
    const messages = capturedMessages as Array<{ role: string; content: unknown }>;
    // The stable prefix must not fork; tool schemas are serialized after it.
    expect(messages[0]).toEqual({
      role: "system",
      content: "Stable prefix\nDynamic suffix",
    });
    // Only the non-behavioral tail rides behind the tools on the user turn.
    expect(messages[1]).toEqual({
      role: "user",
      content: "hi\n\nRuntime facts",
    });
    // The internal marker must never reach the provider.
    expect(JSON.stringify(messages)).not.toContain("OPENCLAW_CACHE_BOUNDARY");
  });

  it.each([
    "anthropic/claude-sonnet-4.6",
    "~anthropic/claude-haiku-latest",
    "openrouter/~anthropic/claude-haiku-latest",
  ])("preserves the stable cache breakpoint for OpenRouter model %s", async (id) => {
    // This route preserves the cache boundary for its breakpoint and relocates
    // nothing, so the relocatable marker must not survive into the payload.
    const { messages: capturedMessages } = await capturePayload(
      {
        ...createModel(32_000),
        id,
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
      },
      {
        systemPrompt: `Stable prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}Reactions guidance${SYSTEM_PROMPT_RELOCATABLE_BOUNDARY}## Runtime\nRuntime: session=alpha${SYSTEM_PROMPT_RELOCATABLE_BOUNDARY_END}`,
        messages: [{ role: "user", content: "hi", timestamp: 1 }],
      },
    );
    const messages = capturedMessages as Array<{ role: string; content: unknown }>;
    const serialized = JSON.stringify(messages);
    expect(serialized).not.toContain("OPENCLAW_CACHE_BOUNDARY");
    expect(serialized).not.toContain("OPENCLAW-RELOCATABLE-BOUNDARY");
    // The breakpoint still lands on the stable prefix, and nothing is relocated.
    expect(messages[0]).toEqual({
      role: "system",
      content: [
        {
          type: "text",
          text: "Stable prefix",
          cache_control: { type: "ephemeral" },
        },
        {
          type: "text",
          text: "Reactions guidance\n## Runtime\nRuntime: session=alpha",
        },
      ],
    });
    // The user turn carries the conversation breakpoint and nothing relocated.
    expect(messages[1]).toEqual({
      role: "user",
      content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }],
    });
  });

  it("anchors the OpenRouter Anthropic cache marker on the last stable user turn, skipping a trailing runtime-context carrier", async () => {
    const { messages: capturedMessages } = await capturePayload(
      {
        ...createModel(32_000),
        id: "anthropic/claude-sonnet-4.6",
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
      },
      {
        systemPrompt: "system",
        messages: [
          { role: "user", content: "stable question", timestamp: 1 },
          {
            role: "user",
            content: "OpenClaw runtime context:\nvolatile current-turn metadata",
            timestamp: 2,
            runtimeContext: {},
          },
        ],
      },
    );
    const messages = capturedMessages as Array<{ role: string; content: unknown }>;
    const stableMsg = messages.find((m) => JSON.stringify(m.content).includes("stable question"));
    const carrierMsg = messages.find((m) =>
      JSON.stringify(m.content).includes("volatile current-turn metadata"),
    );
    // The stable user turn carries the cache breakpoint; the trailing carrier does not.
    expect(JSON.stringify(stableMsg)).toContain("cache_control");
    expect(JSON.stringify(carrierMsg)).not.toContain("cache_control");
  });

  it("adds reasoning_content replay fields for Xiaomi MiMo assistant tool history", async () => {
    const { messages: capturedMessages } = await capturePayload(
      {
        ...createModel(32_000),
        id: "mimo-v2.5-pro",
        name: "MiMo V2.5 Pro",
        provider: "xiaomi",
        baseUrl: "https://api.xiaomimimo.com/v1",
        reasoning: true,
      },
      {
        messages: [
          makeUserMessage("search first", 1),
          {
            role: "assistant",
            api: "openai-completions",
            provider: "xiaomi",
            model: "mimo-v2.5-pro",
            usage: createZeroUsage(),
            stopReason: "toolUse",
            content: [
              {
                type: "toolCall",
                id: "call_search",
                name: "search",
                arguments: { query: "MiMo docs" },
              },
            ],
            timestamp: 2,
          },
          makeTextToolResult("call_search", "search", "ok", false, 3),
          makeUserMessage("continue", 4),
        ],
      },
    );
    const messages = capturedMessages as Array<Record<string, unknown>>;
    expect(messages.find((message) => message.role === "assistant")).toMatchObject({
      role: "assistant",
      reasoning_content: "",
    });
  });
});

describe("openai-completions stop-reason tool-call guard", () => {
  it("partitions inline reasoning tags out of visible text", async () => {
    mockChunksRef.chunks = [
      deltaChunk({ content: "Before <thi" }),
      deltaChunk({
        content: "nk>private reasoning</think> after",
        reasoning_content: "private reasoning",
      }),
      makeFinishChunk("stop"),
    ];

    const result = await request(reasoningModel, context, { reasoningEffort: "medium" }).result();
    const visibleText = result.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("");
    const thinkingText = result.content
      .filter((block): block is { type: "thinking"; thinking: string } => block.type === "thinking")
      .map((block) => block.thinking)
      .join("");

    expect(visibleText).toBe("Before  after");
    expect(visibleText).not.toContain("private reasoning");
    expect(thinkingText).toBe("private reasoning");
  });

  it("does not recover unclosed reasoning tags when mirrored reasoning arrives later", async () => {
    mockChunksRef.chunks = [
      deltaChunk({ content: "<think>private reasoning" }),
      deltaChunk({ reasoning_content: "private reasoning" }),
      makeFinishChunk("stop"),
    ];

    const result = await request(reasoningModel, context, { reasoningEffort: "medium" }).result();
    const visibleText = result.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("");

    expect(visibleText).toBe("");
    expect(result.content).toContainEqual({
      type: "thinking",
      thinking: "private reasoning",
      thinkingSignature: "reasoning_content",
    });
  });

  it.each(["reasoning_text"] as const)(
    "reports hidden %s chunks as request activity",
    async (reasoningField) => {
      mockChunksRef.chunks = [
        deltaChunk({ [reasoningField]: "private reasoning" }),
        deltaChunk({ [reasoningField]: "still private" }),
        makeTextChunk("visible answer"),
        makeFinishChunk("stop"),
      ];
      const abortController = new AbortController();
      const onActivity = vi.fn();
      const unsubscribe = onLlmRequestActivity(abortController.signal, onActivity);

      try {
        const result = await streamOpenAICompletions(model, context, {
          apiKey: "sk-test",
          signal: abortController.signal,
        }).result();

        expect(onActivity).toHaveBeenCalledTimes(mockChunksRef.chunks.length);
        expect(result.content).toContainEqual({ type: "text", text: "visible answer" });
        expect(result.content.some((block) => block.type === "thinking")).toBe(false);
      } finally {
        unsubscribe();
      }
    },
  );

  it("seals the native reasoning block before a following tool call", async () => {
    mockChunksRef.chunks = [
      deltaChunk({ reasoning_content: "I should call a tool." }),
      makeToolCallChunk("call_1", "bash", '{"cmd":"ls"}'),
      makeFinishChunk("tool_calls"),
    ];

    const { eventTypes } = await collect(reasoningModel, { reasoningEffort: "medium" });

    const thinkingEndIndex = eventTypes.indexOf("thinking_end");
    const toolCallStartIndex = eventTypes.indexOf("toolcall_start");
    expect(thinkingEndIndex).toBeGreaterThanOrEqual(0);
    expect(toolCallStartIndex).toBeGreaterThanOrEqual(0);
    expect(thinkingEndIndex).toBeLessThan(toolCallStartIndex);
    expect(eventTypes.filter((type) => type === "thinking_end")).toHaveLength(1);
  });

  it("attaches encrypted reasoning details to the matching streamed tool call", async () => {
    const detail = { type: "reasoning.encrypted", id: "call_1", data: "encrypted" };
    mockChunksRef.chunks = [
      makeToolCallChunk("call_1", "first", '{"value":1}'),
      deltaChunk({
        tool_calls: [
          {
            index: 1,
            id: "call_2",
            function: { name: "second", arguments: '{"value":2}' },
            type: "function",
          },
        ],
        reasoning_details: [detail],
      }),
      makeFinishChunk("tool_calls"),
    ];

    const result = await request().result();
    const toolCalls = result.content.filter((block) => block.type === "toolCall");

    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0]).toMatchObject({
      id: "call_1",
      thoughtSignature: JSON.stringify(detail),
    });
    expect(toolCalls[1]).not.toHaveProperty("thoughtSignature");
  });

  it("keeps one native reasoning block when content and reasoning co-occur", async () => {
    mockChunksRef.chunks = [
      deltaChunk({ reasoning_content: "First thought." }),
      deltaChunk({
        content: "Visible text that shares the reasoning chunk.",
        reasoning_content: " Second thought.",
      }),
      makeTextChunk(" Final answer."),
      makeFinishChunk("stop"),
    ];

    const { result, eventTypes } = await collect(reasoningModel, { reasoningEffort: "medium" });

    expect(eventTypes.filter((type) => type === "thinking_start")).toHaveLength(1);
    expect(eventTypes.filter((type) => type === "thinking_end")).toHaveLength(1);
    expect(eventTypes.indexOf("thinking_end")).toBeLessThan(eventTypes.indexOf("text_start"));
    expect(result.content).toContainEqual({
      type: "thinking",
      thinking: "First thought. Second thought.",
      thinkingSignature: "reasoning_content",
    });
  });

  it("promotes silent tool_calls with finish_reason stop to toolUse", async () => {
    mockChunksRef.chunks = [
      makeToolCallChunk("call_1", "bash", '{"cmd":"ls"}'),
      makeFinishChunk("stop"),
    ];

    const result = await request().result();

    expect(result.stopReason).toBe("toolUse");
    const toolCalls = result.content.filter((b) => b.type === "toolCall");
    expect(toolCalls).toHaveLength(1);
  });

  it("replaces the stored function name on a same-id fragmented continuation", async () => {
    // Same-id continuations replace the name snapshot instead of freezing its first fragment.
    mockChunksRef.chunks = [
      makeToolCallChunk("call_name", "get_", '{"city":'),
      makeToolCallChunk("call_name", "weather", '"Paris"}'),
      makeFinishChunk("tool_calls"),
    ];

    const result = await request().result();

    expect(result.content).toContainEqual({
      type: "toolCall",
      id: "call_name",
      name: "weather",
      arguments: { city: "Paris" },
    });
  });

  it("replaces the stored name when an index-resolved continuation omits the id", async () => {
    // A continuation delta that re-uses the established index but omits the id
    // is still the same tool call — the block was already resolved by index
    // above, so an absent id is a continuation, not a conflicting identity. The
    // latest nonempty function-name snapshot must replace the stored name,
    // matching the pinned OpenAI SDK accumulator. Only an explicitly conflicting
    // id (next test) keeps the first name.
    mockChunksRef.chunks = [
      makeToolCallChunk("call_A", "first", '{"city":'),
      {
        id: "chatcmpl-test",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, function: { name: "second", arguments: '"Paris"}' }, type: "function" },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
    ];

    const stream = streamOpenAICompletions(model, context, { apiKey: "sk-test" });
    const result = await stream.result();

    expect(result.content).toContainEqual({
      type: "toolCall",
      id: "call_A",
      name: "second",
      arguments: { city: "Paris" },
    });
  });

  it("keeps the first name when a continuation carries a conflicting id", async () => {
    // A continuation whose id explicitly conflicts with the established block
    // id is not the same call, so in direct mode the first tool identity wins
    // and the stored name is preserved.
    mockChunksRef.chunks = [
      makeToolCallChunk("call_A", "first", '{"city":'),
      makeToolCallChunk("call_B", "second", '"Paris"}'),
      makeFinishChunk("tool_calls"),
    ];

    const stream = streamOpenAICompletions(model, context, { apiKey: "sk-test" });
    const result = await stream.result();

    expect(result.content).toContainEqual({
      type: "toolCall",
      id: "call_A",
      name: "first",
      arguments: { city: "Paris" },
    });
  });

  it("does not erase the stored name when a continuation carries an empty name", async () => {
    // An empty function-name snapshot must not replace the stored name — the
    // guard checks truthiness, so "" is skipped. This mirrors the pinned SDK
    // (which only replaces on nonempty fn.name) and satisfies the issue's
    // "empty-name continuation" assertion requirement.
    mockChunksRef.chunks = [
      makeToolCallChunk("call_name", "get_weather", '{"city":'),
      {
        id: "chatcmpl-test",
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, function: { name: "", arguments: '"Paris"}' }, type: "function" },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
    ];

    const stream = streamOpenAICompletions(model, context, { apiKey: "sk-test" });
    const result = await stream.result();

    expect(result.content).toContainEqual({
      type: "toolCall",
      id: "call_name",
      name: "get_weather",
      arguments: { city: "Paris" },
    });
  });

  it("publishes post-tool text immediately and closes blocks in their original order", async () => {
    mockChunksRef.chunks = [
      makeToolCallChunk("call_1", "lookup", '{"value":1}'),
      makeTextChunk("following text"),
      makeFinishChunk("tool_calls"),
    ];

    const stream = streamOpenAICompletions(model, context, { apiKey: "sk-test" });
    const eventTypes: string[] = [];
    for await (const event of stream) {
      eventTypes.push(event.type);
      if (event.type === "text_delta") {
        expect(event.partial).toBeDefined();
      }
    }

    expect(eventTypes.indexOf("text_delta")).toBeLessThan(eventTypes.indexOf("toolcall_end"));
    expect(eventTypes.indexOf("toolcall_end")).toBeLessThan(eventTypes.indexOf("text_end"));
    expect((await stream.result()).content).toEqual([
      { type: "toolCall", id: "call_1", name: "lookup", arguments: { value: 1 } },
      {
        type: "text",
        text: "following text",
      },
    ]);
  });

  it("preserves narration when an unfinished tool stream is interrupted", async () => {
    mockChunksRef.chunks = [
      makeTextChunk("ordinary narration"),
      makeToolCallChunk("call_1", "lookup", '{"value":1}'),
    ];

    const { result, eventTypes } = await collect();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe("Stream ended without finish_reason");
    expect(result.content).toEqual([{ type: "text", text: "ordinary narration" }]);
    expect(eventTypes.indexOf("text_end")).toBeLessThan(eventTypes.indexOf("error"));
    expect(eventTypes).not.toContain("toolcall_end");
  });

  it("keeps buffered visible text before following tool calls", async () => {
    mockChunksRef.chunks = [
      makeTextChunk("Use <"),
      makeToolCallChunk("call_1", "bash", '{"cmd":"ls"}'),
      makeFinishChunk("tool_calls"),
    ];

    const result = await request().result();

    expect(result.content[0]).toEqual({
      type: "text",
      text: "Use <",
    });
    expect(result.content[1]).toMatchObject({ type: "toolCall", id: "call_1", name: "bash" });
  });

  it("serializes structured tool results as tool text", async () => {
    const capturedPayload = await capturePayload(model, {
      tools: [{ name: "session_status", description: "Status", parameters: { type: "object" } }],
      messages: [
        {
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          content: [{ type: "toolCall", id: "call_1", name: "session_status", arguments: {} }],
          usage: createZeroUsage(),
          stopReason: "toolUse",
          timestamp: 0,
        },
        {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "session_status",
          content: [{ type: "json", payload: { sessionKey: "current", status: "ok" } }],
          isError: false,
          timestamp: 0,
        },
      ],
    } as unknown as Context);
    expect(capturedPayload?.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "tool",
          tool_call_id: "call_1",
          content: expect.stringContaining('"type":"json"'),
        }),
      ]),
    );
  });
});
