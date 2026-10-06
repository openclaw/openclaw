import type { ChatCompletionChunk } from "openai/resources/chat/completions.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import { createOpenAICompletionsTransportStreamFn } from "../transports/openai-completions-transport.js";
import type { AssistantMessageEvent, Context, Model, SimpleStreamOptions } from "../types.js";
import { streamOpenAICompletions, type OpenAICompletionsOptions } from "./openai-completions.js";

const model = {
  id: "gpt-4",
  name: "GPT-4",
  api: "openai-completions",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 8_192,
  maxTokens: 1_024,
} satisfies Model<"openai-completions">;

const context = {
  messages: [{ role: "user", content: "Look up cats", timestamp: 1 }],
  tools: [
    {
      name: "lookup",
      description: "Look up a query",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    },
  ],
} satisfies Context;
const TOOL_ARGUMENT_BYTE_LIMIT = 256_000;

function chunk(
  delta: ChatCompletionChunk.Choice.Delta,
  finishReason: ChatCompletionChunk.Choice["finish_reason"] = null,
): ChatCompletionChunk {
  return {
    id: "chatcmpl-legacy-fixture",
    object: "chat.completion.chunk",
    created: 0,
    model: model.id,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

type ToolCallFixture = {
  index?: number;
  id?: string;
  name?: string;
  arguments: string;
};

function toolCallDelta({
  index = 0,
  id,
  name,
  arguments: rawArguments,
}: ToolCallFixture): ChatCompletionChunk.Choice.Delta.ToolCall {
  return {
    index,
    ...(id !== undefined ? { id, type: "function" as const } : {}),
    function: {
      ...(name !== undefined ? { name } : {}),
      arguments: rawArguments,
    },
  };
}

function idOnlyToolCallDelta(params: {
  id: string;
  name?: string;
  arguments: string;
}): ChatCompletionChunk.Choice.Delta.ToolCall {
  return {
    id: params.id,
    type: "function",
    function: {
      ...(params.name !== undefined ? { name: params.name } : {}),
      arguments: params.arguments,
    },
  } as ChatCompletionChunk.Choice.Delta.ToolCall;
}

function argumentsWithByteLength(bytes: number, fill = "a"): string {
  const prefix = '{"query":"';
  const suffix = '"}';
  const availableBytes = bytes - Buffer.byteLength(prefix + suffix, "utf8");
  const characterBytes = Buffer.byteLength(fill, "utf8");
  const value =
    prefix +
    fill.repeat(Math.floor(availableBytes / characterBytes)) +
    "a".repeat(availableBytes % characterBytes) +
    suffix;
  expect(Buffer.byteLength(value, "utf8")).toBe(bytes);
  return value;
}

function splitSurrogateArguments(bytes: number): [string, string] {
  const prefix = '{"query":"';
  const suffix = '"}';
  const emoji = "😀";
  const padding = bytes - Buffer.byteLength(prefix + suffix + emoji, "utf8");
  const value = `${prefix}${"a".repeat(padding)}${emoji}${suffix}`;
  expect(Buffer.byteLength(value, "utf8")).toBe(bytes);
  const surrogateBoundary = value.indexOf(emoji) + 1;
  return [value.slice(0, surrogateBoundary), value.slice(surrogateBoundary)];
}

const modernCallChunk = (
  rawArguments: string,
  { id = "call_modern", index = 0, name = "lookup" } = {},
): ChatCompletionChunk =>
  chunk({ tool_calls: [toolCallDelta({ id, index, name, arguments: rawArguments })] });

const confirmedModernCallChunks = (
  rawArguments: string,
  options?: Parameters<typeof modernCallChunk>[1],
): ChatCompletionChunk[] => [modernCallChunk(rawArguments, options), chunk({}, "tool_calls")];

function confirmedLegacyCallChunks(rawArguments: string, name = "lookup"): ChatCompletionChunk[] {
  return [chunk({ function_call: { name, arguments: rawArguments } }), chunk({}, "function_call")];
}

function installStream(chunks: ChatCompletionChunk[]): void {
  const body = `${chunks.map((value) => `data: ${JSON.stringify(value)}\n\n`).join("")}data: [DONE]\n\n`;
  configureAiTransportHost({
    buildModelFetch: () => async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
  });
}

let previousHost: ReturnType<typeof getAiTransportHost>;

beforeEach(() => (previousHost = getAiTransportHost()));

afterEach(() => configureAiTransportHost(previousHost));

const createManagedStream = createOpenAICompletionsTransportStreamFn();
type FixtureOptions = { apiKey: string; reasoningEffort?: "medium"; signal?: AbortSignal };

const FIXTURE_OPTIONS = { apiKey: "fixture-token" } satisfies FixtureOptions;

function createManagedFixtureStream(
  fixtureModel: Model<"openai-completions">,
  fixtureContext: Context,
  fixtureOptions?: FixtureOptions,
) {
  const stream = createManagedStream(fixtureModel, fixtureContext, fixtureOptions);
  if (stream instanceof Promise) {
    throw new Error("OpenAI Chat transport must return its event stream synchronously");
  }
  return stream;
}

describe("OpenAI Chat Completions stream", () => {
  const startFixture = (
    chunks: ChatCompletionChunk[],
    options: FixtureOptions = FIXTURE_OPTIONS,
    fixtureModel: Model<"openai-completions"> = model,
    createStream = createManagedFixtureStream,
  ) => {
    installStream(chunks);
    return createStream(fixtureModel, context, options);
  };
  const fixtureResult = (...args: Parameters<typeof startFixture>) =>
    startFixture(...args).result();
  const collectFixture = async (...args: Parameters<typeof startFixture>) => {
    const stream = startFixture(...args);
    const eventTypes: AssistantMessageEvent["type"][] = [];
    const argumentDeltas: string[] = [];
    for await (const event of stream) {
      eventTypes.push(event.type);
      if (event.type === "toolcall_delta" && event.delta) {
        argumentDeltas.push(event.delta);
      }
    }
    return {
      eventTypes,
      argumentDeltas,
      result: await stream.result(),
    };
  };
  it("preserves legacy function_call deltas and reassembles split arguments", async () => {
    const { eventTypes, result } = await collectFixture([
      chunk({ role: "assistant", function_call: { name: "lookup" } }),
      chunk({ function_call: { arguments: '{"query":"ca' } }),
      chunk({ function_call: { arguments: 'ts"}' } }),
      chunk({}, "function_call"),
    ]);

    expect(result.stopReason).toBe("toolUse");
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toMatchObject({
      type: "toolCall",
      id: expect.stringMatching(/^call_[a-f0-9]{24}$/),
      name: "lookup",
      arguments: { query: "cats" },
    });
    expect(result.content[0]).not.toHaveProperty("partialArgs");
    expect(result.content[0]).not.toHaveProperty("streamIndex");
    expect(eventTypes).toContain("toolcall_start");
    expect(eventTypes).toContain("toolcall_delta");
  });

  it("preserves a confirmed legacy call before later visible text", async () => {
    const { eventTypes, result } = await collectFixture([
      chunk({ function_call: { name: "lookup", arguments: '{"query":"cats"}' } }),
      chunk({ content: "Trailing commentary." }),
      chunk({}, "function_call"),
    ]);

    expect(result.stopReason).toBe("toolUse");
    expect(result.content.map((block) => block.type)).toEqual(["toolCall", "text"]);
    expect(result.content[1]).toMatchObject({ text: "Trailing commentary." });
    expect(eventTypes.indexOf("toolcall_start")).toBeLessThan(eventTypes.indexOf("text_start"));
  });

  it("keeps content preceding a legacy call in the same provider delta", async () => {
    const result = await fixtureResult([
      chunk({
        content: "Commentary before the call.",
        function_call: { name: "lookup", arguments: '{"query":"cats"}' },
      }),
      chunk({}, "function_call"),
    ]);

    expect(result.stopReason).toBe("toolUse");
    expect(result.content.map((block) => block.type)).toEqual(["text", "toolCall"]);
    expect(result.content[0]).toMatchObject({ text: "Commentary before the call." });
  });

  it("preserves a confirmed legacy call before later streamed reasoning", async () => {
    const { eventTypes, result } = await collectFixture(
      [
        chunk({ function_call: { name: "lookup", arguments: '{"query":"cats"}' } }),
        chunk({
          reasoning_content: "Reasoning after the call.",
        } as ChatCompletionChunk.Choice.Delta),
        chunk({}, "function_call"),
      ],
      { ...FIXTURE_OPTIONS, reasoningEffort: "medium" },
      { ...model, reasoning: true },
    );

    expect(result.stopReason).toBe("toolUse");
    expect(result.content.map((block) => block.type)).toEqual(["toolCall", "thinking"]);
    expect(eventTypes.indexOf("toolcall_start")).toBeLessThan(eventTypes.indexOf("thinking_start"));
  });

  it.each([
    { finishReason: "length", visibleText: false, stopReason: "length" },
    { finishReason: "content_filter", visibleText: false, stopReason: "error" },
    { finishReason: "stop", visibleText: true, stopReason: "stop" },
  ] as const)(
    "does not publish completed modern calls discarded by a $finishReason terminal",
    async ({ finishReason, visibleText, stopReason }) => {
      const { eventTypes, result } = await collectFixture([
        ...(visibleText ? [chunk({ content: "Visible final answer." })] : []),
        modernCallChunk('{"query":"discard"}', { id: "call_unconfirmed" }),
        chunk({}, finishReason),
      ]);
      expect(result.stopReason).toBe(stopReason);
      expect(result.content.filter((block) => block.type === "toolCall")).toHaveLength(0);
      expect(eventTypes).not.toContain("toolcall_end");
    },
  );

  it.each([
    { reason: "incomplete JSON", name: "lookup", arguments: '{"query":"cats"' },
    { reason: "empty arguments", name: "lookup", arguments: "" },
    { reason: "missing function name", name: "", arguments: '{"query":"cats"}' },
  ] as const)(
    "rejects an authoritative modern tool terminal with $reason",
    async ({ reason, name, arguments: rawArguments }) => {
      const { eventTypes, result } = await collectFixture(
        confirmedModernCallChunks(rawArguments, { id: "call_malformed", name }),
        FIXTURE_OPTIONS,
        model,
        reason === "incomplete JSON" ? streamOpenAICompletions : createManagedFixtureStream,
      );
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toContain("incomplete or malformed tool call");
      expect(result.content.filter((block) => block.type === "toolCall")).toHaveLength(0);
      expect(eventTypes).not.toContain("toolcall_end");
    },
  );

  it("removes provisional calls when the response is aborted mid-stream", async () => {
    const abort = new AbortController();
    const stream = startFixture(
      confirmedModernCallChunks('{"query":"cats"}', { id: "call_aborted" }),
      { ...FIXTURE_OPTIONS, signal: abort.signal },
    );
    const eventTypes: string[] = [];
    for await (const event of stream) {
      eventTypes.push(event.type);
      if (event.type === "toolcall_start") {
        abort.abort();
      }
    }

    const result = await stream.result();
    expect(result.stopReason).toBe("aborted");
    expect(result.content.filter((block) => block.type === "toolCall")).toHaveLength(0);
    expect(eventTypes).not.toContain("toolcall_end");
  });

  it("preserves unsafe integers in confirmed tool arguments", async () => {
    const { result } = await collectFixture(
      confirmedModernCallChunks('{"target":9223372036854775807}', {
        id: "call_unsafe_integer",
      }),
    );

    expect(result.content).toContainEqual(
      expect.objectContaining({
        type: "toolCall",
        id: "call_unsafe_integer",
        arguments: { target: "9223372036854775807" },
      }),
    );
  });

  it.each([{ finishReason: "tool_calls", stopReason: "stop" }] as const)(
    "discards provisional legacy fragments when the provider finishes with $finishReason",
    async ({ finishReason, stopReason }) => {
      const { eventTypes, result } = await collectFixture([
        chunk({ function_call: { name: "lookup", arguments: '{"query":"discard"}' } }),
        chunk({}, finishReason),
      ]);

      expect(result.stopReason).toBe(stopReason);
      expect(result.content.filter((block) => block.type === "toolCall")).toHaveLength(0);
      expect(eventTypes).not.toContain("toolcall_start");
      expect(eventTypes).not.toContain("toolcall_delta");
    },
  );

  it.each<[string, string, string]>([
    [
      "rejects oversized legacy arguments without publishing a provisional tool call",
      "x".repeat(256_001),
      "lookup",
    ],
  ])("%s", async (_title, rawArguments, name) => {
    const { eventTypes, result } = await collectFixture(
      confirmedLegacyCallChunks(rawArguments, name),
    );
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("Exceeded tool-call argument buffer limit");
    expect(eventTypes).not.toContain("toolcall_start");
  });

  it("keeps independent id-only modern calls independently bounded", async () => {
    const { result } = await collectFixture([
      chunk({
        tool_calls: [
          idOnlyToolCallDelta({
            id: "call_id_a",
            name: "lookup",
            arguments: argumentsWithByteLength(200_000),
          }),
          idOnlyToolCallDelta({
            id: "call_id_b",
            name: "lookup",
            arguments: argumentsWithByteLength(200_000),
          }),
        ],
      }),
      chunk({}, "tool_calls"),
    ]);

    expect(result.stopReason).toBe("toolUse");
    expect(
      result.content
        .filter((block) => block.type === "toolCall")
        .map((block) => [block.id, Buffer.byteLength(JSON.stringify(block.arguments), "utf8")]),
    ).toEqual([
      ["call_id_a", 200_000],
      ["call_id_b", 200_000],
    ]);
  });

  it.each([
    {
      name: "rejects an oversized surrogate pair split between deltas",
      bytes: TOOL_ARGUMENT_BYTE_LIMIT + 1,
      stopReason: "error",
    },
  ] as const)("$name", async ({ bytes, stopReason }) => {
    const [first, second] = splitSurrogateArguments(bytes);
    const { eventTypes, result } = await collectFixture([
      chunk({
        tool_calls: [
          toolCallDelta({
            index: 0,
            id: "call_surrogate",
            name: "lookup",
            arguments: first,
          }),
        ],
      }),
      chunk({ tool_calls: [toolCallDelta({ index: 0, arguments: second })] }),
      chunk({}, "tool_calls"),
    ]);

    expect(result.stopReason).toBe(stopReason);
    if (stopReason === "error") {
      expect(result.errorMessage).toContain("Exceeded tool-call argument buffer limit");
      expect(result.content.filter((block) => block.type === "toolCall")).toHaveLength(0);
      expect(eventTypes).not.toContain("toolcall_end");
      return;
    }
    expect(result.content[0]).toMatchObject({ id: "call_surrogate", type: "toolCall" });
    expect(
      result.content[0]?.type === "toolCall"
        ? Buffer.byteLength(JSON.stringify(result.content[0].arguments), "utf8")
        : undefined,
    ).toBe(bytes);
  });

  it("coalesces tiny provisional legacy fragments into one bounded executable delta", async () => {
    const query = "x".repeat(1_100);
    const { argumentDeltas, result } = await collectFixture([
      chunk({ function_call: { name: "lookup", arguments: '{"query":"' } }),
      ...Array.from(query, (character) =>
        chunk({
          content: "",
          refusal: "",
          reasoning_details: [],
          function_call: { arguments: character },
        } as ChatCompletionChunk.Choice.Delta),
      ),
      chunk({ function_call: { arguments: '"}' } }),
      chunk({}, "function_call"),
    ]);

    expect(result.stopReason).toBe("toolUse");
    expect(result.content[0]).toMatchObject({
      type: "toolCall",
      name: "lookup",
      arguments: { query },
    });
    expect(argumentDeltas).toEqual([JSON.stringify({ query })]);
  });

  it("bounds the number of tiny deltas buffered behind a provisional legacy call", async () => {
    const result = await fixtureResult([
      chunk({ function_call: { name: "lookup", arguments: '{"query":"cats"}' } }),
      ...Array.from({ length: 1_025 }, () => chunk({ content: "x" })),
      chunk({}, "function_call"),
    ]);

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("Exceeded legacy tool-call content buffer limit");
    expect(result.content).toEqual([]);
  });
});

describe("mapped off effort in chat completions", () => {
  async function capturePayload(
    compat: Model<"openai-completions">["compat"],
    off: string | null | undefined,
    request: {
      transport?: "managed";
      reasoning?: SimpleStreamOptions["reasoning"];
      reasoningEffort?: OpenAICompletionsOptions["reasoningEffort"];
    } = {},
  ) {
    let payload: unknown;
    const reasoningFixtureModel = {
      id: "mapped-thinking-model",
      name: "Mapped thinking model",
      provider: "synthetic-provider",
      api: "openai-completions",
      baseUrl: "https://provider.example/v1",
      reasoning: true,
      input: ["text"],
      contextWindow: 32_000,
      maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      thinkingLevelMap: off === undefined ? undefined : { off },
      compat,
    } satisfies Model<"openai-completions">;
    const options = {
      apiKey: "synthetic-unused-key",
      reasoningEffort: request.reasoningEffort,
      onPayload(value) {
        payload = value;
        throw new Error("captured before network");
      },
    } satisfies OpenAICompletionsOptions;
    const stream = await (request.transport === "managed"
      ? createOpenAICompletionsTransportStreamFn()(
          reasoningFixtureModel,
          { messages: [{ role: "user", content: "Synthetic request", timestamp: 1 }] },
          {
            ...options,
            reasoning: request.reasoning,
          },
        )
      : streamOpenAICompletions(
          reasoningFixtureModel,
          { messages: [{ role: "user", content: "Synthetic request", timestamp: 1 }] },
          options,
        ));
    const result = await stream.result();
    expect(result.errorMessage).toBe("captured before network");
    return payload;
  }

  it("maps OpenRouter logical off to the supported none effort", async () => {
    expect(
      await capturePayload(
        {
          supportsReasoningEffort: true,
          thinkingFormat: "openrouter",
          supportedReasoningEfforts: ["none", "low", "high"],
        },
        undefined,
        { reasoningEffort: "off" },
      ),
    ).toMatchObject({ reasoning: { effort: "none" } });
  });

  it("honors an uppercase binary off mapping", async () => {
    expect(
      await capturePayload(
        {
          thinkingFormat: "together",
          supportsReasoningEffort: true,
          reasoningEffortMap: { OFF: "low" },
        },
        undefined,
        { reasoningEffort: "off" },
      ),
    ).toMatchObject({
      reasoning: { enabled: true },
      reasoning_effort: "low",
    });
  });

  it("honors the model's off mapping for Qwen chat templates", async () => {
    expect(
      await capturePayload(
        {
          thinkingFormat: "qwen-chat-template",
          supportsReasoningEffort: true,
        },
        "low",
      ),
    ).toMatchObject({
      chat_template_kwargs: { enable_thinking: true, preserve_thinking: true },
    });
  });

  it.each([
    { name: "omission", reasoning: undefined, enabled: undefined },
    { name: "logical off", reasoning: "off", enabled: true },
  ] as const)(
    "preserves mandatory OpenRouter $name without an effort selector",
    async ({ reasoning, enabled }) => {
      const payload = await capturePayload(
        {
          thinkingFormat: "openrouter",
          supportsReasoningEffort: false,
        },
        null,
        { transport: "managed", reasoning },
      );
      if (enabled === undefined) {
        expect(payload).not.toHaveProperty("reasoning");
      } else {
        expect(payload).toMatchObject({ reasoning: { enabled } });
      }
      expect(payload).not.toHaveProperty("reasoning_effort");
      expect(payload).not.toHaveProperty("reasoning.effort");
    },
  );

  it("honors the model off mapping at the managed binary boundary", async () => {
    expect(
      await capturePayload(
        {
          thinkingFormat: "together",
          supportsReasoningEffort: true,
          supportedReasoningEfforts: ["none", "low", "high"],
        },
        "low",
        { transport: "managed", reasoning: "off" },
      ),
    ).toMatchObject({
      reasoning: { enabled: true },
      reasoning_effort: "low",
    });
  });
});

describe("OpenAI Chat Completions cache metadata", () => {
  it.each([
    {
      id: "gpt-5.4",
      compat: undefined,
      key: "session-123",
      lifetime: { prompt_cache_retention: "24h" },
    },
    {
      id: "gpt-5.6-sol",
      compat: undefined,
      key: "session-123",
      lifetime: { prompt_cache_options: { ttl: "30m" } },
    },
  ])("uses native cache policy for $id with $compat", async ({ id, compat, key, lifetime }) => {
    const cacheModel = {
      id,
      name: id,
      api: "openai-completions",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 4096,
      compat,
    } satisfies Model<"openai-completions">;
    let payload: unknown;
    const result = await streamOpenAICompletions(
      cacheModel,
      { messages: [{ role: "user", content: "Synthetic request", timestamp: 1 }] },
      {
        apiKey: "synthetic-unused-key",
        sessionId: "session-123",
        cacheRetention: "long",
        onPayload(value) {
          payload = value;
          throw new Error("captured before request");
        },
      },
    ).result();
    expect(result.errorMessage).toBe("captured before request");
    expect(payload).toMatchObject({ prompt_cache_key: key, ...lifetime });
    if (!("prompt_cache_retention" in lifetime)) {
      expect(payload).not.toHaveProperty("prompt_cache_retention");
    }
  });
});
