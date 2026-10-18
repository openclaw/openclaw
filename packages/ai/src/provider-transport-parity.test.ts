import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { APIError as AnthropicAPIError } from "@anthropic-ai/sdk/core/error.js";
import type { AssistantMessageEventStreamLike, Model } from "@openclaw/llm-core";
import { describe, expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "./host.js";
import {
  anthropicModel,
  context,
  anthropicEvents,
  createAnthropicResponse,
  registerParityHostLifecycle,
} from "./provider-transport-parity.test-support.js";

type OpenAIChunk = Record<string, unknown>;

const openAiMockState = vi.hoisted(() => ({
  error: undefined as Error | undefined,
  streamError: undefined as Error | undefined,
  chunks: [] as OpenAIChunk[],
  payloads: [] as unknown[],
}));

vi.mock("openai", () => ({
  default: class MockOpenAI {
    chat = {
      completions: {
        create: (payload: unknown) => {
          openAiMockState.payloads.push(payload);
          if (openAiMockState.error) {
            throw openAiMockState.error;
          }
          const createIterable = () => ({
            async *[Symbol.asyncIterator]() {
              for (const item of openAiMockState.chunks) {
                yield item;
              }
              if (openAiMockState.streamError) {
                throw openAiMockState.streamError;
              }
            },
          });
          return Object.assign(Promise.resolve(createIterable()), {
            asResponse: async () =>
              new Response(null, { status: 200, headers: { "x-request-id": "req-parity" } }),
          });
        },
      },
    };
  },
}));

type ParityOutput = {
  payload?: unknown;
  eventTrace: unknown[];
  terminal: Record<string, unknown>;
  errorFields: Record<string, unknown>;
};

type ParityFixture = {
  name: string;
  provider: "anthropic" | "openai";
  outcome: "success" | "error";
  snapshot?: string;
};

const openAiModel = {
  id: "gpt-5.5",
  name: "GPT-5.5",
  api: "openai-completions",
  provider: "openai",
  // Managed official OpenAI reasoning tool turns use Responses; this covers the Chat wire.
  baseUrl: "https://chat-proxy.example/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4096,
} satisfies Model<"openai-completions">;

const openRouterModel = {
  ...openAiModel,
  id: "openrouter/minimax/minimax-m2.7",
  name: "MiniMax M2.7",
  provider: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
} satisfies Model<"openai-completions">;

const openRouterModelWithoutBaseUrl = {
  ...openRouterModel,
  baseUrl: undefined,
} as unknown as Model<"openai-completions">;

function chunk(delta: Record<string, unknown>, finishReason: string | null = null): OpenAIChunk {
  return {
    id: "chatcmpl-parity",
    model: "gpt-5.5-response",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function thinking(value: string, thinkingSignature?: string) {
  return { type: "thinking", thinking: value, ...(thinkingSignature ? { thinkingSignature } : {}) };
}

const text = (value: string) => ({ type: "text", text: value });
const nativeThought = (value: string) => thinking(value, "reasoning_content");
const interleavedContent = (signature?: string) => [
  thinking("First thought.", signature),
  text("Interim."),
  thinking("Second thought.", signature),
  text("Final."),
];
const stopped = (...deltas: Record<string, unknown>[]) => [
  ...deltas.map((delta) => chunk(delta)),
  chunk({}, "stop"),
];
const openAiChunks = [
  chunk({ reasoning_content: "Think." }),
  chunk({ content: "Answer." }),
  {
    ...chunk({}, "stop"),
    usage: {
      prompt_tokens: 8,
      completion_tokens: 4,
      total_tokens: 12,
      prompt_tokens_details: { cached_tokens: 2 },
      completion_tokens_details: { reasoning_tokens: 1 },
    },
  },
];
const interleaved = [
  { reasoning_content: "First thought." },
  { content: "Interim." },
  { reasoning_content: "Second thought." },
  { content: "Final." },
];
const visibleDetails = [
  { type: "response.output_text", text: "Visible first." },
  { type: "reasoning.text", text: " Hidden second." },
  { type: "response.text", text: " Visible third." },
];
const nativeChunks = stopped(...interleaved);
const coalescedChunks = stopped(...interleaved.slice(0, 2), {
  content: "Final.",
  reasoning_content: "Second thought.",
});
const typedChunks = stopped(
  { content: { type: "reasoning", text: "First thought." } },
  { content: "Interim." },
  { content: { type: "reasoning", text: "Second thought." } },
  { content: "Final." },
);
const structuredChunks = stopped(
  { reasoning_details: [{ type: "reasoning.text", text: "First thought." }] },
  { content: "Interim." },
  { reasoning_details: [{ type: "reasoning.text", text: "Second thought." }] },
  { content: "Final." },
);
const orderedChunks = stopped({ reasoning_details: visibleDetails });
const splitChunks = stopped(...visibleDetails.map((detail) => ({ reasoning_details: [detail] })));
const interruptedChunks = stopped(
  ...visibleDetails.slice(0, 2).map((detail) => ({ reasoning_details: [detail] })),
  { content: "Interim." },
  { reasoning_content: "Hidden fourth." },
  { content: "Final." },
);
const trailingChunks = stopped(
  { reasoning_content: "First thought." },
  { content: "Answer." },
  { reasoning_content: "Trailing thought." },
  { content: " " },
);
const nativeTrailingChunks = stopped(...interleaved, {
  reasoning_content: "Trailing thought.",
});
const errorChunks = interleaved.slice(0, 3).map((delta) => chunk(delta));

const anthropicFailure = {
  status: 429,
  body: {
    type: "error",
    error: { type: "rate_limit_error", message: "synthetic Anthropic rejection" },
  },
  headers: { "content-type": "application/json", "retry-after": "2" },
} as const;

function usage(input_tokens: number, output_tokens: number, cacheRead = 0, cacheWrite = 0) {
  return {
    input_tokens,
    output_tokens,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
  };
}

function messageStart(id: string, tokens: Record<string, unknown>) {
  return { type: "message_start", message: { id, model: anthropicModel.id, usage: tokens } };
}

function normalizeRecord(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.fromEntries(
    keys.flatMap((key) => (value[key] === undefined ? [] : [[key, value[key]]])),
  );
}

async function observeStream(stream: AssistantMessageEventStreamLike): Promise<ParityOutput> {
  const eventTrace: unknown[] = [];
  for await (const rawEvent of stream) {
    const event = rawEvent as unknown as Record<string, unknown>;
    eventTrace.push(normalizeRecord(event, ["type", "contentIndex", "delta", "content", "reason"]));
  }
  const result = (await stream.result()) as unknown as Record<string, unknown>;
  return {
    eventTrace,
    terminal: normalizeRecord(
      result,
      "role content api provider model responseId responseModel openclawDelivery usage stopReason diagnostics".split(
        " ",
      ),
    ),
    errorFields: normalizeRecord(result, ["errorMessage", "errorCode", "errorType", "errorBody"]),
  };
}

function resetOpenAiMock(
  outcome: ParityFixture["outcome"],
  chunks: readonly OpenAIChunk[] = openAiChunks,
): void {
  openAiMockState.payloads = [];
  openAiMockState.streamError = undefined;
  openAiMockState.chunks = outcome === "success" ? [...chunks] : [];
  openAiMockState.error =
    outcome === "error"
      ? Object.assign(new Error("synthetic OpenAI rejection"), {
          status: 429,
          code: "rate_limit_exceeded",
          type: "rate_limit_error",
          error: { code: "rate_limit_exceeded", type: "rate_limit_error" },
        })
      : undefined;
}

async function runOpenAi(
  implementation: "provider" | "transport",
  outcome: ParityFixture["outcome"],
  chunks: readonly OpenAIChunk[] = openAiChunks,
  emitReasoning = true,
  modelOverride?: Model<"openai-completions">,
  streamError?: Error,
): Promise<ParityOutput> {
  resetOpenAiMock(outcome, chunks);
  openAiMockState.streamError = streamError;
  const baseModel = modelOverride ?? openAiModel;
  const model = emitReasoning ? baseModel : { ...baseModel, reasoning: false };
  const [
    { streamOpenAICompletions: providerStream },
    { createOpenAICompletionsTransportStreamFn: createTransport },
  ] = await Promise.all([
    import("./providers/openai-completions.js"),
    import("./transports/openai-completions-transport.js"),
  ]);
  const options = { apiKey: "sk-test", reasoningEffort: "medium" } as const;
  const stream =
    implementation === "provider"
      ? providerStream(model, context, options)
      : await createTransport()(model, context, options as never);
  const observed = await observeStream(stream);
  return {
    ...(outcome === "success" ? { payload: openAiMockState.payloads[0] } : {}),
    ...observed,
  };
}

async function runAnthropic(
  implementation: "provider" | "transport",
  outcome: ParityFixture["outcome"],
  events: readonly Record<string, unknown>[] = anthropicEvents,
): Promise<ParityOutput> {
  let payload: unknown;
  let stream: AssistantMessageEventStreamLike;
  const [{ streamAnthropic }, { createAnthropicMessagesTransportStreamFn: createTransport }] =
    await Promise.all([
      import("./providers/anthropic.js"),
      import("./transports/anthropic-transport-stream.js"),
    ]);
  const options = {
    apiKey: "sk-test",
    thinkingEnabled: true,
    thinkingBudgetTokens: 1024,
    effort: "low",
  } as const;
  if (implementation === "provider") {
    const client = {
      messages: {
        create: (nextPayload: unknown) => {
          payload = nextPayload;
          return {
            asResponse: async () => {
              if (outcome === "error") {
                throw AnthropicAPIError.generate(
                  anthropicFailure.status,
                  anthropicFailure.body,
                  undefined,
                  new Headers(anthropicFailure.headers),
                );
              }
              return createAnthropicResponse(events);
            },
          };
        },
      },
    };
    stream = streamAnthropic(anthropicModel, context, {
      ...options,
      client: client as never,
    });
  } else {
    const fetchMock: typeof fetch = async (_input, init) => {
      payload = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
      if (outcome === "error") {
        return new Response(JSON.stringify(anthropicFailure.body), {
          status: anthropicFailure.status,
          headers: anthropicFailure.headers,
        });
      }
      return createAnthropicResponse(events);
    };
    configureAiTransportHost({ ...getAiTransportHost(), buildModelFetch: () => fetchMock });
    stream = await createTransport()(anthropicModel, context, options as never);
  }
  const observed = await observeStream(stream);
  return {
    ...(outcome === "success" ? { payload } : {}),
    ...observed,
  };
}

type ContentCase = [
  name: string,
  chunks: OpenAIChunk[],
  content: unknown[],
  emitReasoning?: boolean,
  model?: Model<"openai-completions">,
];
const visibleContent = [text("Visible first."), thinking(" Hidden second.", "reasoning_details")];
const routerCase = (name: string, chunks: OpenAIChunk[], content: unknown[]): ContentCase => [
  name,
  chunks,
  content,
  true,
  openRouterModel,
];

const fixtures = (["anthropic", "openai"] as const).flatMap<ParityFixture>((provider) => {
  const label = provider === "anthropic" ? "Anthropic" : "OpenAI";
  return [
    {
      name: `${label} successful request and event trace`,
      provider,
      outcome: "success",
      snapshot: `${provider}-success.snap.txt`,
    },
    { name: `${label} structured request failure`, provider, outcome: "error" },
  ];
});

describe("provider and transport observable parity fixtures", () => {
  registerParityHostLifecycle();

  it.each([
    { name: "seeded starts followed by deltas", seeded: true, deltas: true },
    { name: "seed-only blocks", seeded: true, deltas: false },
    { name: "empty starts followed by deltas", seeded: false, deltas: true },
  ])("preserves Anthropic $name like the native SDK", async ({ seeded, deltas }) => {
    const events = anthropicEvents
      .filter((event) => deltas || event.type !== "content_block_delta")
      .map((event) => {
        if (event.type === "message_start") {
          return Object.assign({}, event, {
            message: Object.assign({}, event.message, {
              type: "message",
              role: "assistant",
              content: [],
              stop_reason: null,
              stop_sequence: null,
            }),
          });
        }
        if (!seeded && event.type === "content_block_start" && event.content_block) {
          return Object.assign({}, event, {
            content_block:
              event.content_block.type === "text"
                ? { type: "text", text: "" }
                : { type: "thinking", thinking: "", signature: "" },
          });
        }
        return event;
      });
    const sdk = new Anthropic({
      apiKey: "synthetic-key",
      fetch: async () => createAnthropicResponse(events),
    });
    const sdkResult = await sdk.messages
      .stream({
        model: anthropicModel.id,
        max_tokens: 4096,
        messages: [{ role: "user", content: "Find the answer." }],
      })
      .finalMessage();
    const thought = `${seeded ? "seed" : ""}${deltas ? " + thought" : ""}`;
    const answer = `${seeded ? "Hello" : ""}${deltas ? " world" : ""}`;
    const signature = deltas ? "final-signature" : "seed-signature";
    expect(sdkResult.content).toEqual([
      { type: "thinking", thinking: thought, signature },
      text(answer),
    ]);
    for (const implementation of ["provider", "transport"] as const) {
      const result = await runAnthropic(implementation, "success", events);
      expect(result.terminal).toMatchObject({
        stopReason: "stop",
        content: [thinking(thought, signature), text(answer)],
      });
      expect(result.eventTrace).toContainEqual({
        type: "thinking_end",
        contentIndex: 0,
        content: thought,
      });
      expect(result.eventTrace).toContainEqual({
        type: "text_end",
        contentIndex: 1,
        content: answer,
      });
    }
  });

  it.each(fixtures)("$name", async ({ provider, outcome, snapshot }) => {
    const run = provider === "anthropic" ? runAnthropic : runOpenAi;
    const providerResult = await run("provider", outcome);
    const transportResult = await run("transport", outcome);
    if (outcome === "error") {
      for (const result of [providerResult, transportResult]) {
        expect(result.terminal.stopReason).toBe("error");
        expect(result.errorFields.errorMessage).toEqual(expect.any(String));
      }
      if (provider === "openai") {
        expect(providerResult.errorFields).toEqual(transportResult.errorFields);
      } else {
        expect(providerResult.errorFields).toMatchObject({
          errorCode: "429",
          errorType: "rate_limit_error",
          errorBody: expect.stringContaining("synthetic Anthropic rejection"),
        });
        expect(transportResult.errorFields.errorMessage).toContain("Retry-After: 2 seconds");
      }
      return;
    }
    if (!snapshot) {
      throw new Error("success parity fixture requires a snapshot");
    }
    await expect(
      `${JSON.stringify({ provider: providerResult, transport: transportResult }, null, 2)}\n`,
    ).toMatchFileSnapshot(
      path.join(import.meta.dirname, "../test/fixtures/provider-transport-parity", snapshot),
    );
  });

  it.each([
    {
      name: "omitted usage after cumulative output updates",
      updates: [{ output_tokens: 7 }, { output_tokens: 11 }],
      final: undefined,
      billing: { input: 37, output: 11, cacheRead: 11, cacheWrite: 5, totalTokens: 64 },
      contextUsage: { state: "available", promptTokens: 53, totalTokens: 64 },
    },
    {
      name: "omitted usage after compaction iterations",
      updates: [
        {
          iterations: [
            {
              type: "compaction",
              ...usage(10, 3, 2, 1),
            },
            {
              type: "message",
              ...usage(4, 5, 6, 7),
            },
          ],
        },
      ],
      final: undefined,
      billing: { input: 14, output: 8, cacheRead: 8, cacheWrite: 8, totalTokens: 38 },
      contextUsage: { state: "available", promptTokens: 17, totalTokens: 22 },
    },
    {
      name: "present empty usage after a reported snapshot",
      updates: [],
      final: {},
      billing: { input: 37, output: 2, cacheRead: 11, cacheWrite: 5, totalTokens: 55 },
      contextUsage: { state: "unavailable" },
    },
  ])(
    "preserves Anthropic accounting for $name",
    async ({ updates, final, billing, contextUsage }) => {
      const events = [
        messageStart("msg_usage_parity", usage(37, 2, 11, 5)),
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done." } },
        { type: "content_block_stop", index: 0 },
        ...updates.map((tokens) => ({ type: "message_delta", delta: {}, usage: tokens })),
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: final },
        { type: "message_stop" },
      ];
      for (const implementation of ["provider", "transport"] as const) {
        const result = await runAnthropic(implementation, "success", events);
        expect(result.terminal).toMatchObject({
          stopReason: "stop",
          content: [{ type: "text", text: "Done." }],
          usage: { ...billing, contextUsage },
        });
        expect(result.eventTrace.at(-1)).toMatchObject({ type: "done" });
        expect(result.errorFields).toEqual({});
      }
    },
  );

  it.each([
    { name: "malformed seeded input", input: "{", providerError: true },
    {
      name: "encoded object input",
      input: '{"query":"seed"}',
      providerArguments: { query: "seed" },
    },
    {
      name: "streamed arguments superseding a malformed seed",
      input: "{",
      delta: '{"query":"streamed"}',
      providerArguments: { query: "streamed" },
    },
  ])("preserves Anthropic terminal tool validation for $name", async (fixture) => {
    const events = [
      messageStart("msg_seeded", { input_tokens: 1, output_tokens: 0 }),
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "call_seed", name: "lookup", input: fixture.input },
      },
      ...(fixture.delta
        ? [
            {
              type: "content_block_delta",
              index: 0,
              delta: { type: "input_json_delta", partial_json: fixture.delta },
            },
          ]
        : []),
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" } },
      { type: "message_stop" },
    ];
    for (const implementation of ["provider", "transport"] as const) {
      const result = await runAnthropic(implementation, "success", events);
      if (implementation === "provider" && fixture.providerError) {
        expect(result.terminal.stopReason).toBe("error");
        expect(result.errorFields.errorMessage).toContain("malformed JSON arguments");
        expect(result.terminal.content).toEqual([]);
        expect(result.eventTrace).not.toContainEqual(
          expect.objectContaining({ type: "toolcall_end" }),
        );
      } else {
        expect(result.terminal).toMatchObject({
          stopReason: "toolUse",
          content: [
            {
              type: "toolCall",
              id: "call_seed",
              arguments:
                implementation === "provider" || fixture.delta ? fixture.providerArguments : {},
            },
          ],
        });
      }
    }
  });

  it.each<ContentCase>([
    ["interleaved reasoning", nativeChunks, interleavedContent("reasoning_content")],
    ["coalesced reasoning", coalescedChunks, interleavedContent("reasoning_content")],
    ["typed reasoning", typedChunks, interleavedContent()],
    ["structured reasoning", structuredChunks, interleavedContent("reasoning_details")],
    ["hidden reasoning", nativeChunks, [text("Interim."), text("Final.")], false],
    [
      "trailing reasoning",
      trailingChunks,
      [
        nativeThought("First thought."),
        text("Answer."),
        nativeThought("Trailing thought."),
        text(" "),
      ],
    ],
    [
      "interleaved then trailing reasoning",
      nativeTrailingChunks,
      [...interleavedContent("reasoning_content"), nativeThought("Trailing thought.")],
    ],
    routerCase("ordered visible details", orderedChunks, [
      ...visibleContent,
      text(" Visible third."),
    ]),
    routerCase("split visible details", splitChunks, [...visibleContent, text(" Visible third.")]),
    routerCase("visible details before interrupted content", interruptedChunks, [
      ...visibleContent,
      text("Interim."),
      nativeThought("Hidden fourth."),
      text("Final."),
    ]),
  ])("preserves %s", async (_name, chunks, content, emitReasoning, model) => {
    for (const implementation of ["provider", "transport"] as const) {
      const result = await runOpenAi(implementation, "success", chunks, emitReasoning, model);
      expect(result.terminal.content).toEqual(content);
      if (emitReasoning === false) {
        expect(result.terminal.openclawDelivery).toBeUndefined();
      }
    }
  });

  it("preserves unphased text when the stream errors", async () => {
    for (const implementation of ["provider", "transport"] as const) {
      const result = await runOpenAi(
        implementation,
        "success",
        errorChunks,
        true,
        undefined,
        new Error("synthetic interrupted stream"),
      );

      expect(result.terminal.stopReason).toBe("error");
      expect(result.terminal.content).toEqual([
        nativeThought("First thought."),
        text("Interim."),
        nativeThought("Second thought."),
      ]);
    }
  });

  it("fails closed before using the OpenAI default endpoint for another provider", async () => {
    for (const implementation of ["provider", "transport"] as const) {
      const result = await runOpenAi(
        implementation,
        "success",
        openAiChunks,
        true,
        openRouterModelWithoutBaseUrl,
      );

      expect(result.terminal.stopReason).toBe("error");
      expect(result.errorFields.errorMessage).toContain(
        'Provider "openrouter" requires an explicit base URL',
      );
      expect(openAiMockState.payloads).toEqual([]);
    }
  });
});
