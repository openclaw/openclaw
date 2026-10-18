import { describe, expect, it } from "vitest";
import { configureAiTransportHost } from "../host.js";
import { convertMessages } from "../openai-completions-messages.js";
import { resolveOpenAICompletionsCompat } from "../transports/openai-completions-compat.js";
import { createOpenAICompletionsTransportStreamFn } from "../transports/openai-completions-transport.js";
import type { Context, Model } from "../types.js";
import { streamOpenAICompletions } from "./openai-completions.js";
import { makeOpenAIProviderModel, preserveTransportHost } from "./openai-provider.test-support.js";

const reasoningModel = makeOpenAIProviderModel("openai-completions");

const context = {
  messages: [{ role: "user", content: "Reply exactly", timestamp: 1 }],
} satisfies Context;

type StructuredContentScenario = {
  name: string;
  package?: boolean;
  choice: Record<string, unknown>;
  followupChoice?: Record<string, unknown>;
  expectedContent: Array<Record<string, unknown>>;
  reasoningEnabled?: boolean;
  reasoningEffort?: "medium" | "none";
};

const textPart = (text: string) => ({ type: "text", text });
function privateParts(thought = "Private thought", visible = "Visible answer") {
  return [{ type: "reasoning", text: thought }, textPart(visible)];
}
function answer(thinking = "Private thought", thinkingSignature?: string) {
  return [
    { type: "thinking", thinking, ...(thinkingSignature ? { thinkingSignature } : {}) },
    textPart("Visible answer"),
  ];
}
function refusalPart(refusal: string) {
  return { type: "refusal", refusal };
}

type ContentRow = [
  name: string,
  delta: Record<string, unknown>,
  expectedContent: StructuredContentScenario["expectedContent"],
  overrides?: Partial<StructuredContentScenario>,
];
const disabledReasoningRows = [
  ["mirrored disabled", "Do not expose this", "Do not expose this", false, undefined],
  ["structured explicitly disabled", "Do not expose this", undefined, undefined, "none"],
  [
    "distinct explicitly disabled",
    "Another private thought",
    "Do not expose this",
    undefined,
    "none",
  ],
] as const;
const refusalRows = [
  ["documented refusal part", ["Refused."], undefined, "Refused."],
  ["mirrored refusal", ["No."], "No.", "No."],
  ["distinct refusals", ["No. "], "Guidance.", "No. Guidance."],
  ["split mirrored refusal", ["No", "."], "No.", "No."],
] as const;
const contentRows: ContentRow[] = [
  ["the unchanged scalar text contract", { content: "Scalar answer" }, [textPart("Scalar answer")]],
  [
    "a provider-compatible typed text object",
    { content: { type: "text", text: "Visible object" } },
    [textPart("Visible object")],
  ],
  [
    "nested typed text content",
    { content: { type: "output_text", content: { text: "Nested answer" } } },
    [textPart("Nested answer")],
  ],
  [
    "mixed private reasoning and visible text",
    { content: privateParts() },
    answer(),
    { package: true },
  ],
  ...["reasoning_content", "reasoning", "reasoning_text"].map((field): ContentRow => [
    `private reasoning mirrored in ${field} and structured content`,
    { [field]: "Private thought", content: privateParts() },
    answer("Private thought", field),
  ]),
  ...["reasoning_content", "reasoning", "reasoning_text"].map((field): ContentRow => [
    `distinct private reasoning in ${field} and structured content`,
    {
      [field]: "Dedicated private thought.",
      content: privateParts("Distinct structured private thought."),
    },
    answer("Dedicated private thought.Distinct structured private thought.", field),
    { package: field === "reasoning_content" },
  ]),
  [
    "split structured reasoning mirrored in the dedicated field",
    {
      reasoning_content: "Private thought",
      content: [
        { type: "reasoning", text: "Private " },
        { type: "reasoning", text: "thought" },
        textPart("Visible answer"),
      ],
    },
    answer("Private thought", "reasoning_content"),
    { package: true },
  ],
  [
    "standalone dedicated reasoning alongside visible structured text",
    { reasoning_content: "Private thought", content: [textPart("Visible answer")] },
    answer("Private thought", "reasoning_content"),
  ],
  [
    "structured reasoning that is disabled",
    {
      content: [
        { type: "thinking", thinking: [textPart("Do not expose this")] },
        textPart("Visible answer"),
      ],
    },
    [textPart("Visible answer")],
    { reasoningEnabled: false },
  ],
  ...disabledReasoningRows.map(
    ([name, thought, dedicated, reasoningEnabled, reasoningEffort]): ContentRow => [
      name,
      { content: privateParts(thought), ...(dedicated ? { reasoning_content: dedicated } : {}) },
      [textPart("Visible answer")],
      { package: Boolean(dedicated), reasoningEnabled, reasoningEffort },
    ],
  ),
  [
    "pending partial inline reasoning remains private after a structured thought",
    { content: "<thi" },
    [{ type: "thinking", thinking: "Structured private thought" }, textPart("SAFE")],
    {
      package: true,
      followupChoice: {
        delta: {
          content: privateParts("Structured private thought", "nk>SECRET</think>SAFE"),
        },
      },
    },
  ],
  ...refusalRows.map(([name, parts, refusal, visible]): ContentRow => [
    name,
    { content: parts.map(refusalPart), ...(refusal === undefined ? {} : { refusal }) },
    [textPart(visible)],
  ]),
  [
    "identical refusals intentionally repeated across separate chunks",
    { refusal: "Safety refusal." },
    [textPart("Safety refusal.Safety refusal.")],
    { followupChoice: { delta: { refusal: "Safety refusal." } } },
  ],
  [
    "an existing top-level refusal without duplication",
    { content: [textPart("Visible prefix. ")], refusal: "Safety refusal." },
    [textPart("Visible prefix. Safety refusal.")],
  ],
  [
    "unknown structured parts without object coercion",
    { content: [{ type: "unknown", text: "Do not expose this" }] },
    [],
  ],
];
const scenarios: StructuredContentScenario[] = [
  ...contentRows.map(([name, delta, expectedContent, overrides]) =>
    Object.assign({ name, choice: { delta }, expectedContent }, overrides),
  ),
  {
    name: "documented mixed assistant text and refusal parts",
    package: true,
    choice: {
      message: {
        role: "assistant",
        content: [textPart("Visible prefix. "), refusalPart("Safety refusal.")],
      },
    },
    expectedContent: [textPart("Visible prefix. Safety refusal.")],
  },
];

function chatChunk(model: Model, choice: Record<string, unknown>, finishReason: "stop" | null) {
  return `data: ${JSON.stringify({
    id: "chatcmpl-structured-content",
    object: "chat.completion.chunk",
    created: 1,
    model: model.id,
    choices: [{ index: 0, ...choice, finish_reason: finishReason }],
  })}\n\n`;
}

function installResponse(body: string | ReadableStream<Uint8Array>) {
  configureAiTransportHost({
    buildModelFetch: () => async () =>
      new Response(body, { headers: { "content-type": "text/event-stream" } }),
  });
}

function installChatChunk(scenario: StructuredContentScenario, model: Model): void {
  const choices = [scenario.choice, ...(scenario.followupChoice ? [scenario.followupChoice] : [])];
  const body = `${choices
    .map((choice, index) => chatChunk(model, choice, index === choices.length - 1 ? "stop" : null))
    .join("")}data: [DONE]\n\n`;
  installResponse(body);
}

function installDeferredStructuredChatChunks(model: Model): () => void {
  let releaseTerminal: (() => void) | undefined;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encodeChunk = (content: unknown, finishReason: "stop" | null) =>
        encoder.encode(chatChunk(model, { delta: { content } }, finishReason));
      controller.enqueue(encodeChunk(privateParts("Private thought", "VISIBLE_ONE"), null));
      releaseTerminal = () => {
        controller.enqueue(encodeChunk("VISIBLE_TWO", "stop"));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      };
    },
  });
  installResponse(stream);
  return () => releaseTerminal?.();
}

const createManagedStream = createOpenAICompletionsTransportStreamFn();

function createManagedFixtureStream(model: Model, scenario: StructuredContentScenario) {
  const options = {
    apiKey: "fixture-token",
    reasoningEffort: scenario.reasoningEffort ?? "medium",
  };
  const stream = createManagedStream(model, context, options);
  if (stream instanceof Promise) {
    throw new Error("OpenAI Chat Completions transport must return its stream synchronously");
  }
  return stream;
}

preserveTransportHost();

describe.each([
  {
    name: "package",
    createStream: (model: Model<"openai-completions">, scenario: StructuredContentScenario) =>
      streamOpenAICompletions(model, context, {
        apiKey: "fixture-token",
        reasoningEffort: scenario.reasoningEffort ?? "medium",
      }),
  },
  { name: "managed", createStream: createManagedFixtureStream },
])("$name Chat Completions structured content", ({ name, createStream }) => {
  const ownerScenarios =
    name === "package" ? scenarios.filter((scenario) => scenario.package) : scenarios;
  it.each(ownerScenarios)("preserves $name", async (scenario) => {
    const model = {
      ...reasoningModel,
      reasoning: scenario.reasoningEnabled ?? true,
    } satisfies Model<"openai-completions">;
    installChatChunk(scenario, model);

    const result = await createStream(model, scenario).result();
    expect({ stopReason: result.stopReason, content: result.content }).toEqual({
      stopReason: "stop",
      content: scenario.expectedContent,
    });
    expect(JSON.stringify(result.content)).not.toContain("[object Object]");

    const visibleAnswer = result.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");
    if (visibleAnswer && result.content.some((block) => block.type === "thinking")) {
      const assistantReplay = convertMessages(
        model,
        { messages: [...context.messages, result] },
        resolveOpenAICompletionsCompat(model),
      ).find((message) => message.role === "assistant");
      expect(assistantReplay?.content).toBe(visibleAnswer);
    }
  });

  it.each(["medium", "none"] as const)(
    "streams visible structured content before terminal when reasoning is %s",
    async (reasoningEffort) => {
      const releaseTerminal = installDeferredStructuredChatChunks(reasoningModel);
      const scenario: StructuredContentScenario = {
        name: "incremental structured reasoning",
        choice: {},
        expectedContent: [],
        reasoningEffort,
      };
      const stream = createStream(reasoningModel, scenario);
      let resolveFirstVisible: ((value: string) => void) | undefined;
      const firstVisible = new Promise<string>((resolve) => {
        resolveFirstVisible = resolve;
      });
      const textDeltas: string[] = [];
      const consumeEvents = (async () => {
        for await (const event of stream as AsyncIterable<{ type: string; delta?: string }>) {
          if (event.type === "text_delta" && typeof event.delta === "string") {
            textDeltas.push(event.delta);
            resolveFirstVisible?.(event.delta);
            resolveFirstVisible = undefined;
          }
        }
      })();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const firstDelta = await Promise.race([
          firstVisible,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error("Visible content was buffered until the terminal chunk")),
              500,
            );
          }),
        ]);
        expect(firstDelta).toBe("VISIBLE_ONE");
      } finally {
        if (timeout) {
          clearTimeout(timeout);
        }
        releaseTerminal();
      }
      await consumeEvents;
      await stream.result();
      expect(textDeltas).toEqual(["VISIBLE_ONE", "VISIBLE_TWO"]);
    },
  );
});
