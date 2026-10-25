import type { Model } from "@openclaw/llm-core";
import { describe, expect, it, vi } from "vitest";
import {
  anthropicModel,
  context,
  anthropicEvents,
  captureAnthropicExchange,
  registerParityHostLifecycle,
} from "./provider-transport-parity.test-support.js";
import { makeProviderModel } from "./providers/provider-model.test-support.js";

type OpenAIChunk = Record<string, unknown>;

const openAiMockState = vi.hoisted(() => ({
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

const openAiModel = makeProviderModel("openai-completions", "openai", "gpt-5.5", {
  name: "GPT-5.5",
  // Managed official OpenAI reasoning tool turns use Responses; this covers the Chat wire.
  baseUrl: "https://chat-proxy.example/v1",
  maxTokens: 4096,
});

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
const coalescedChunks = stopped(
  ...interleaved.slice(0, 2),
  {
    content: "Final.",
    reasoning_content: "Second thought.",
  },
  { reasoning_content: "Trailing thought." },
);
const interruptedChunks = stopped(
  { reasoning_details: visibleDetails.slice(0, 2) },
  { reasoning_details: visibleDetails.slice(2) },
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
const errorChunks = interleaved.slice(0, 3).map((delta) => chunk(delta));

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

const blockStart = (index: number, content_block: Record<string, unknown>) => ({
  type: "content_block_start",
  index,
  content_block,
});
const blockDelta = (index: number, delta: Record<string, unknown>) => ({
  type: "content_block_delta",
  index,
  delta,
});
const blockStop = (index: number) => ({ type: "content_block_stop", index });
const messageDelta = (stop_reason?: string, tokens?: unknown) => ({
  type: "message_delta",
  delta: stop_reason ? { stop_reason } : {},
  usage: tokens,
});
const messageStop = { type: "message_stop" };

async function runOpenAi(
  implementation: "provider" | "transport",
  chunks: readonly OpenAIChunk[],
  emitReasoning = true,
  modelOverride?: Model<"openai-completions">,
  streamError?: Error,
) {
  openAiMockState.payloads = [];
  openAiMockState.chunks = [...chunks];
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
  return { terminal: await stream.result() };
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

describe("provider and transport observable parity fixtures", () => {
  registerParityHostLifecycle();

  it.each([
    { name: "seeded starts followed by deltas", seeded: true, deltas: true },
    { name: "seed-only blocks", seeded: true, deltas: false },
    { name: "empty starts followed by deltas", seeded: false, deltas: true },
  ])("preserves Anthropic $name", async ({ seeded, deltas }) => {
    const events = anthropicEvents
      .filter((event) => deltas || event.type !== "content_block_delta")
      .map((event) => {
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
    const thought = `${seeded ? "seed" : ""}${deltas ? " + thought" : ""}`;
    const answer = `${seeded ? "Hello" : ""}${deltas ? " world" : ""}`;
    const signature = deltas ? "final-signature" : "seed-signature";
    for (const implementation of ["provider", "transport"] as const) {
      const result = await captureAnthropicExchange(implementation, { events });
      expect(result.terminal).toMatchObject({
        stopReason: "stop",
        content: [thinking(thought, signature), text(answer)],
      });
      expect(result.eventTrace).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "thinking_end", contentIndex: 0, content: thought }),
          expect.objectContaining({ type: "text_end", contentIndex: 1, content: answer }),
        ]),
      );
    }
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
            { type: "compaction", ...usage(10, 3, 2, 1) },
            { type: "message", ...usage(4, 5, 6, 7) },
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
        blockStart(0, { type: "text", text: "" }),
        blockDelta(0, { type: "text_delta", text: "Done." }),
        blockStop(0),
        ...updates.map((tokens) => messageDelta(undefined, tokens)),
        messageDelta("end_turn", final),
        messageStop,
      ];
      for (const implementation of ["provider", "transport"] as const) {
        const result = await captureAnthropicExchange(implementation, { events });
        expect(result.terminal).toMatchObject({
          stopReason: "stop",
          content: [{ type: "text", text: "Done." }],
          usage: { ...billing, contextUsage },
        });
        expect(result.eventTrace.at(-1)).toMatchObject({ type: "done" });
        const errorKeys = ["errorMessage", "errorCode", "errorType", "errorBody"] as const;
        expect(errorKeys.map((key) => result.terminal[key])).toEqual(
          errorKeys.map(() => undefined),
        );
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
      blockStart(0, { type: "tool_use", id: "call_seed", name: "lookup", input: fixture.input }),
      ...(fixture.delta
        ? [blockDelta(0, { type: "input_json_delta", partial_json: fixture.delta })]
        : []),
      blockStop(0),
      messageDelta("tool_use"),
      messageStop,
    ];
    for (const implementation of ["provider", "transport"] as const) {
      const result = await captureAnthropicExchange(implementation, { events });
      if (implementation === "provider" && fixture.providerError) {
        expect(result.terminal.stopReason).toBe("error");
        expect(result.terminal.errorMessage).toContain("malformed JSON arguments");
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
    [
      "separated, coalesced, and trailing reasoning",
      coalescedChunks,
      [...interleavedContent("reasoning_content"), nativeThought("Trailing thought.")],
    ],
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
    routerCase("visible details before interrupted content", interruptedChunks, [
      ...visibleContent,
      text(" Visible third."),
      text("Interim."),
      nativeThought("Hidden fourth."),
      text("Final."),
    ]),
  ])("preserves %s", async (_name, chunks, content, emitReasoning, model) => {
    for (const implementation of ["provider", "transport"] as const) {
      const result = await runOpenAi(implementation, chunks, emitReasoning, model);
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
        stopped({ content: "Answer." }),
        true,
        openRouterModelWithoutBaseUrl,
      );

      expect(result.terminal.stopReason).toBe("error");
      expect(result.terminal.errorMessage).toContain(
        'Provider "openrouter" requires an explicit base URL',
      );
      expect(openAiMockState.payloads).toEqual([]);
    }
  });
});
