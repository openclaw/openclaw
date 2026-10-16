import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import { convertMessages } from "../openai-completions-messages.js";
import { resolveOpenAICompletionsCompat } from "../transports/openai-completions-compat.js";
import { createOpenAICompletionsTransportStreamFn } from "../transports/openai-completions-transport.js";
import type { AssistantMessageEventStreamLike, Context, Model } from "../types.js";
import { streamOpenAICompletions } from "./openai-completions.js";

const reasoningModel = {
  id: "gpt-5.5",
  name: "GPT-5.5",
  api: "openai-completions",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4_096,
} satisfies Model<"openai-completions">;

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

function contentCase(
  name: string,
  delta: Record<string, unknown>,
  expectedContent: StructuredContentScenario["expectedContent"],
  overrides: Partial<StructuredContentScenario> = {},
): StructuredContentScenario {
  return { name, choice: { delta }, expectedContent, ...overrides };
}

const scenarios: StructuredContentScenario[] = [
  contentCase("the unchanged scalar text contract", { content: "Scalar answer" }, [
    textPart("Scalar answer"),
  ]),
  contentCase(
    "a provider-compatible typed text object",
    { content: { type: "text", text: "Visible object" } },
    [textPart("Visible object")],
  ),
  contentCase(
    "nested typed text content",
    { content: { type: "output_text", content: { text: "Nested answer" } } },
    [textPart("Nested answer")],
  ),
  contentCase(
    "mixed private reasoning and visible text",
    {
      content: privateParts(),
    },
    answer(),
    { package: true },
  ),
  ...(["reasoning_content", "reasoning", "reasoning_text"] as const).map((field) =>
    contentCase(
      `private reasoning mirrored in ${field} and structured content`,
      {
        [field]: "Private thought",
        content: privateParts(),
      },
      answer("Private thought", field),
    ),
  ),
  ...(["reasoning_content", "reasoning", "reasoning_text"] as const).map((field) =>
    contentCase(
      `distinct private reasoning in ${field} and structured content`,
      {
        [field]: "Dedicated private thought.",
        content: privateParts("Distinct structured private thought.", "Visible answer"),
      },
      answer("Dedicated private thought.Distinct structured private thought.", field),
      { package: field === "reasoning_content" },
    ),
  ),
  contentCase(
    "split structured reasoning mirrored in the dedicated field",
    {
      reasoning_content: "Private thought",
      content: [
        { type: "reasoning", text: "Private " },
        { type: "reasoning", text: "thought" },
        { type: "text", text: "Visible answer" },
      ],
    },
    answer("Private thought", "reasoning_content"),
    { package: true },
  ),
  contentCase(
    "standalone dedicated reasoning alongside visible structured text",
    {
      reasoning_content: "Private thought",
      content: [textPart("Visible answer")],
    },
    answer("Private thought", "reasoning_content"),
  ),
  contentCase(
    "structured reasoning that is disabled",
    {
      content: [
        { type: "thinking", thinking: [textPart("Do not expose this")] },
        { type: "text", text: "Visible answer" },
      ],
    },
    [textPart("Visible answer")],
    { reasoningEnabled: false },
  ),
  contentCase(
    "dedicated and structured mirrored reasoning that is disabled",
    {
      reasoning_content: "Do not expose this",
      content: privateParts("Do not expose this", "Visible answer"),
    },
    [textPart("Visible answer")],
    { package: true, reasoningEnabled: false },
  ),
  contentCase(
    "structured reasoning explicitly disabled on a capable model",
    {
      content: privateParts("Do not expose this", "Visible answer"),
    },
    [textPart("Visible answer")],
    { reasoningEffort: "none" },
  ),
  contentCase(
    "pending partial inline reasoning remains private after a structured thought",
    { content: "<thi" },
    [
      { type: "thinking", thinking: "Structured private thought" },
      { type: "text", text: "SAFE" },
    ],
    {
      package: true,
      followupChoice: {
        delta: {
          content: privateParts("Structured private thought", "nk>SECRET</think>SAFE"),
        },
      },
    },
  ),
  contentCase(
    "dedicated and structured reasoning explicitly disabled on a capable model",
    {
      reasoning_content: "Do not expose this",
      content: privateParts("Another private thought", "Visible answer"),
    },
    [textPart("Visible answer")],
    { package: true, reasoningEffort: "none" },
  ),
  contentCase(
    "a documented refusal content part",
    { content: [refusalPart("I cannot help with that.")] },
    [textPart("I cannot help with that.")],
  ),
  contentCase(
    "the same refusal mirrored in structured and top-level fields",
    {
      content: [refusalPart("Safety refusal.")],
      refusal: "Safety refusal.",
    },
    [textPart("Safety refusal.")],
  ),
  contentCase(
    "distinct structured and top-level refusals",
    {
      content: [refusalPart("Provider refusal. ")],
      refusal: "Operator guidance.",
    },
    [textPart("Provider refusal. Operator guidance.")],
  ),
  contentCase(
    "split structured refusal mirrored in the top-level field",
    {
      content: [refusalPart("Safety "), refusalPart("refusal.")],
      refusal: "Safety refusal.",
    },
    [textPart("Safety refusal.")],
  ),
  contentCase(
    "identical refusals intentionally repeated across separate chunks",
    { refusal: "Safety refusal." },
    [textPart("Safety refusal.Safety refusal.")],
    { followupChoice: { delta: { refusal: "Safety refusal." } } },
  ),
  {
    name: "documented mixed assistant text and refusal parts",
    package: true,
    choice: {
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Visible prefix. " }, refusalPart("Safety refusal.")],
      },
    },
    expectedContent: [textPart("Visible prefix. Safety refusal.")],
  },
  contentCase(
    "an existing top-level refusal without duplication",
    {
      content: [textPart("Visible prefix. ")],
      refusal: "Safety refusal.",
    },
    [textPart("Visible prefix. Safety refusal.")],
  ),
  contentCase(
    "unknown structured parts without object coercion",
    { content: [{ type: "unknown", text: "Do not expose this" }] },
    [],
  ),
];

function installChatChunk(scenario: StructuredContentScenario, model: Model): void {
  const choices = [scenario.choice, ...(scenario.followupChoice ? [scenario.followupChoice] : [])];
  const body = `${choices
    .map(
      (choice, index) =>
        `data: ${JSON.stringify({
          id: `chatcmpl-${scenario.name.replaceAll(" ", "-")}`,
          object: "chat.completion.chunk",
          created: 1,
          model: model.id,
          choices: [
            {
              index: 0,
              ...choice,
              finish_reason: index === choices.length - 1 ? "stop" : null,
            },
          ],
        })}\n\n`,
    )
    .join("")}data: [DONE]\n\n`;
  configureAiTransportHost({
    buildModelFetch: () => async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
  });
}

function installDeferredStructuredChatChunks(model: Model): () => void {
  let releaseTerminal: (() => void) | undefined;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encodeChunk = (delta: Record<string, unknown>, finishReason: "stop" | null) =>
        encoder.encode(
          `data: ${JSON.stringify({
            id: "chatcmpl-incremental-structured-content",
            object: "chat.completion.chunk",
            created: 1,
            model: model.id,
            choices: [{ index: 0, delta, finish_reason: finishReason }],
          })}\n\n`,
        );
      controller.enqueue(
        encodeChunk(
          {
            content: privateParts("Private thought", "VISIBLE_ONE"),
          },
          null,
        ),
      );
      releaseTerminal = () => {
        controller.enqueue(encodeChunk({ content: "VISIBLE_TWO" }, "stop"));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      };
    },
  });
  configureAiTransportHost({
    buildModelFetch: () => async () =>
      new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
  });
  return () => releaseTerminal?.();
}

const createManagedStream = createOpenAICompletionsTransportStreamFn();

function createManagedFixtureStream(
  model: Model,
  scenario: StructuredContentScenario,
): AssistantMessageEventStreamLike {
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

let previousHost: ReturnType<typeof getAiTransportHost>;

beforeEach(() => {
  previousHost = getAiTransportHost();
});

afterEach(() => {
  configureAiTransportHost(previousHost);
});

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
    expect(result.stopReason).toBe("stop");
    expect(result.content).toEqual(scenario.expectedContent);
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
