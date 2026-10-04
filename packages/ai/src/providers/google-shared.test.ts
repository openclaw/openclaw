import {
  ApiError,
  BlockedReason,
  FinishReason,
  GoogleGenAI,
  GenerateContentResponse,
  type Part,
} from "@google/genai";
import { describe, expect, it, vi } from "vitest";
import { makeTextToolResult } from "../../../../test/helpers/text-tool-result.js";
import { createAssistantOutput } from "../transports/assistant-output.js";
import { withProviderAcceptanceObserver } from "../transports/transport-stream-shared.js";
import type { AssistantMessage, Context, Model, Tool } from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { onLlmRequestActivity } from "../utils/llm-request-activity.js";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "../utils/system-prompt-cache-boundary.js";
import { normalizeToolParameterSchema } from "./agent-tools-parameter-schema.js";
import { convertGoogleTools, projectGoogleMessages } from "./google-messages.js";
import {
  buildGoogleGenerateContentParams,
  buildGoogleSimpleThinking,
  runGoogleGenerateContentLifecycle,
} from "./google-shared.js";
import {
  assertRecord,
  convertMessages,
  expectConvertedRoles,
  getFirstToolParameters,
  makeGeminiCliAssistantMessage,
  makeGeminiCliModel,
  makeGoogleAssistantMessage,
  makeModel,
} from "./google-shared.test-helpers.js";

const disabledThinking = { thinking: { enabled: false } };
const model: Model<"google-generative-ai"> = {
  ...makeModel("gemini-test"),
  reasoning: true,
  cost: { input: 1, output: 2, cacheRead: 0.25, cacheWrite: 0 },
};

describe("buildGoogleSimpleThinking", () => {
  it.each([
    ["gemini-flash-latest", "MINIMAL"],
    ["gemini-pro-latest", "LOW"],
    ["gemini-3.7-flash", "LOW"],
  ])("uses the supported thinking floor for %s", (id, level) => {
    const target = { ...model, id };
    expect(buildGoogleSimpleThinking(target, { reasoning: "minimal" })).toEqual({
      enabled: true,
      level,
    });
    expect(
      buildGoogleGenerateContentParams(target, { messages: [] }, disabledThinking).config
        ?.thinkingConfig,
    ).toEqual({ thinkingLevel: level });
  });

  it.each([
    { id: "gemini-2.5-pro", enabled: { enabled: true, budgetTokens: -1 }, disabled: undefined },
    { id: "gemini-pro-latest", enabled: { enabled: true }, disabled: { thinkingLevel: "LOW" } },
    {
      id: "gemini-3-flash-preview",
      enabled: { enabled: true },
      disabled: { thinkingLevel: "MINIMAL" },
    },
    { id: "gemma-4-26b-a4b-it", enabled: { enabled: true, level: "HIGH" }, disabled: undefined },
  ])("preserves adaptive and disabled thinking for $id", ({ id, enabled, disabled }) => {
    const target = { ...model, id };
    expect(buildGoogleSimpleThinking(target, { reasoning: "adaptive" } as never)).toEqual(enabled);
    expect(
      buildGoogleGenerateContentParams(target, { messages: [] }, disabledThinking).config
        ?.thinkingConfig,
    ).toEqual(disabled);
  });

  it("uses low thinking for the Flash alias", () => {
    expect(
      buildGoogleSimpleThinking({ ...model, id: "gemini-flash-latest" }, { reasoning: "low" }),
    ).toEqual({ enabled: true, level: "LOW" });
  });

  it.each([
    { label: "a non-reasoning model", target: { ...model, reasoning: false }, reasoning: "low" },
    {
      label: "an off-only model",
      target: {
        ...model,
        id: "gemini-3-flash-preview",
        thinkingLevelMap: {
          minimal: null,
          low: null,
          medium: null,
          high: null,
          xhigh: null,
          max: null,
        },
      },
      reasoning: "max",
    },
  ] as const)(
    "keeps thinking disabled when $reasoning clamps to off for $label",
    ({ target, reasoning }) => {
      expect(buildGoogleSimpleThinking(target, { reasoning })).toEqual({ enabled: false });
    },
  );
});

async function* chunks(items: GenerateContentResponse[]) {
  yield* items;
}

function response({
  parts,
  finishReason,
  finishMessage,
  ...metadata
}: Pick<
  GenerateContentResponse,
  "responseId" | "modelVersion" | "usageMetadata" | "promptFeedback"
> & {
  parts?: Part[];
  finishReason?: FinishReason;
  finishMessage?: string;
}): GenerateContentResponse {
  return Object.assign(
    new GenerateContentResponse(),
    metadata,
    parts !== undefined || finishReason !== undefined || finishMessage !== undefined
      ? {
          candidates: [
            { content: parts === undefined ? undefined : { parts }, finishReason, finishMessage },
          ],
        }
      : {},
  );
}

function finished(parts: Part[], finishReason = FinishReason.STOP) {
  return response({ parts, finishReason });
}

function lookupPart(args: Record<string, unknown> = {}, thoughtSignature?: string): Part {
  return {
    functionCall: { id: "call_1", name: "lookup", args },
    ...(thoughtSignature && { thoughtSignature }),
  };
}

function toolCall(args: Record<string, unknown> = {}, signature?: string, id = "call_1") {
  return {
    type: "toolCall" as const,
    id,
    name: "lookup",
    arguments: args,
    ...(signature && { thoughtSignature: signature }),
  };
}

type StreamEvent = { type: string; delta?: string; reason?: string };

type GoogleLifecycleParams = Parameters<typeof runGoogleGenerateContentLifecycle>[0];
type GoogleGenerateContentStream = ReturnType<
  GoogleLifecycleParams["createClient"]
>["models"]["generateContentStream"];
type GoogleFixtureOptions = {
  targetModel?: Model<"google-generative-ai" | "google-vertex">;
  options?: GoogleLifecycleParams["options"];
  createClient?: GoogleLifecycleParams["createClient"];
  generateContentStream?: GoogleGenerateContentStream;
  buildParams?: GoogleLifecycleParams["buildParams"];
};

async function runFixture(
  responses: GenerateContentResponse[] = [],
  fixture: GoogleFixtureOptions = {},
) {
  const targetModel = fixture.targetModel ?? model;
  const output = createAssistantOutput(targetModel);
  const stream = new AssistantMessageEventStream();
  const events: StreamEvent[] = [];
  const collect = (async () => {
    for await (const event of stream) {
      events.push(event);
    }
  })();

  await runGoogleGenerateContentLifecycle({
    stream,
    model: targetModel,
    output,
    options: fixture.options,
    createClient:
      fixture.createClient ??
      (() => ({
        models: {
          generateContentStream: fixture.generateContentStream ?? (async () => chunks(responses)),
        },
      })),
    buildParams: fixture.buildParams ?? (() => ({ model: targetModel.id, contents: [] })),
    nextToolCallId: (name) => `generated-${name}`,
  });
  await collect;
  return { output, stream, events, result: await stream.result() };
}

describe("Google stream projection", () => {
  it("reports every parsed Google response as request activity", async () => {
    const controller = new AbortController();
    const onActivity = vi.fn();
    const unsubscribe = onLlmRequestActivity(controller.signal, onActivity);
    const responses = [
      response({ usageMetadata: { totalTokenCount: 1 } }),
      response({ finishReason: FinishReason.STOP }),
    ];
    try {
      await runFixture(responses, { options: { signal: controller.signal } });
    } finally {
      unsubscribe();
    }
    expect(onActivity).toHaveBeenCalledTimes(responses.length);
  });

  it("projects text, thinking, tool calls, response id, and usage into one stream", async () => {
    const { output, events } = await runFixture([
      response({
        responseId: "response-1",
        parts: [
          { text: "thinking", thought: true, thoughtSignature: "dGhpbms=" },
          { text: "hello" },
          { functionCall: { name: "lookup", args: { query: "cats" } } },
        ],
      }),
      response({
        finishReason: FinishReason.STOP,
        usageMetadata: {
          promptTokenCount: 10,
          cachedContentTokenCount: 2,
          candidatesTokenCount: 3,
          thoughtsTokenCount: 4,
          totalTokenCount: 17,
        },
      }),
    ]);
    expect(events.map((event) => event.type)).toEqual([
      "start",
      "thinking_start",
      "thinking_delta",
      "thinking_end",
      "text_start",
      "text_delta",
      "text_end",
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
      "done",
    ]);
    expect(output.responseId).toBe("response-1");
    expect(output.stopReason).toBe("toolUse");
    expect(output.content).toEqual([
      { type: "thinking", thinking: "thinking", thinkingSignature: "dGhpbms=" },
      { type: "text", text: "hello" },
      toolCall({ query: "cats" }, undefined, "generated-lookup"),
    ]);
    expect(output.usage).toMatchObject({ input: 8, output: 7, cacheRead: 2, totalTokens: 17 });
    expect(output.usage.cost.total).toBeGreaterThan(0);
  });

  it.each([
    {
      requested: "projects/fixture/locations/global/publishers/google/models/gemini-test",
      returned: ["models/gemini-test"],
      expected: undefined,
    },
    {
      requested: "publishers/meta/models/gemini-test",
      returned: ["gemini-test"],
      expected: "gemini-test",
    },
    {
      requested: "gemini-test",
      returned: ["", "gemini-test-002", "gemini-test-003"],
      expected: "gemini-test-002",
    },
  ])(
    "retains only an actually different response model for $requested",
    async ({ requested, returned, expected }) => {
      const { result } = await runFixture(
        returned.map((modelVersion, index) =>
          response({
            modelVersion,
            ...(index === returned.length - 1
              ? {
                  parts: [{ text: "actual response" }],
                  finishReason: FinishReason.STOP,
                }
              : {}),
          }),
        ),
        { targetModel: { ...model, id: requested } },
      );
      expect(result.stopReason).toBe("stop");
      if (expected) {
        expect(result.responseModel).toBe(expected);
      } else {
        expect(result).not.toHaveProperty("responseModel");
      }
    },
  );

  it("retains prompt, cache, and tool-token facts across sparse Google usage chunks", async () => {
    const { output } = await runFixture([
      response({
        usageMetadata: {
          promptTokenCount: 100,
          cachedContentTokenCount: 40,
          toolUsePromptTokenCount: 6,
          candidatesTokenCount: 1,
          totalTokenCount: 107,
        },
      }),
      response({
        finishReason: FinishReason.STOP,
        usageMetadata: { candidatesTokenCount: 12, thoughtsTokenCount: 3 },
      }),
    ]);
    expect(output.usage).toMatchObject({ input: 66, output: 15, cacheRead: 40, totalTokens: 121 });
  });

  it("never reports negative input when Google only provides sparse cached-token facts", async () => {
    const { output } = await runFixture([
      response({
        finishReason: FinishReason.STOP,
        usageMetadata: { cachedContentTokenCount: 40, toolUsePromptTokenCount: 6 },
      }),
    ]);
    expect(output.usage).toMatchObject({ input: 6, cacheRead: 40 });
  });

  it("preserves MAX_TOKENS when the partial response contains a function call", async () => {
    const { output, events } = await runFixture([
      response({
        parts: [{ functionCall: { name: "lookup", args: { query: "cats" } } }],
        finishReason: FinishReason.MAX_TOKENS,
      }),
    ]);
    expect(events.find((event) => event.type === "done")?.reason).toBe("length");
    expect(output.stopReason).toBe("length");
    expect(output.content).toEqual([expect.objectContaining({ type: "toolCall", name: "lookup" })]);
  });

  it("generates a new id when Google repeats a streamed tool-call id", async () => {
    const { output, events } = await runFixture([
      response({ parts: [lookupPart()] }),
      finished([lookupPart()]),
    ]);
    expect(events.at(-1)?.type).toBe("done");
    expect(output.content).toEqual([toolCall(), toolCall({}, undefined, "generated-lookup")]);
  });

  it.each([
    {
      name: "a later standalone signature attaches to its unsigned tool call",
      parts: [[lookupPart({ query: "cats" })], [{ thoughtSignature: "Y2FsbF9zaWc=" }]],
      content: [toolCall({ query: "cats" }, "Y2FsbF9zaWc=")],
    },
    {
      name: "a signature-only thought stays separate from a tool call",
      parts: [
        [
          lookupPart(),
          { thought: true, thoughtSignature: "dGhvdWdodF9zaWc=" },
          { thought: true, text: "draft" },
        ],
      ],
      content: [
        toolCall(),
        { type: "thinking", thinking: "", thinkingSignature: "dGhvdWdodF9zaWc=" },
        { type: "thinking", thinking: "draft", thinkingSignature: undefined },
      ],
    },
    {
      name: "a separate signature never overwrites a signed tool call",
      parts: [[lookupPart({}, "c2lnXzE="), { thoughtSignature: "c2lnXzI=" }]],
      content: [toolCall({}, "c2lnXzE="), { type: "text", text: "", textSignature: "c2lnXzI=" }],
    },
    {
      name: "a signed media part never attaches to a tool call",
      parts: [
        [
          lookupPart(),
          { inlineData: { mimeType: "image/png", data: "aW1hZ2U=" }, thoughtSignature: "c2lnXzE=" },
        ],
      ],
      content: [toolCall()],
    },
    {
      name: "a same-candidate standalone signature stays separate from a tool call",
      parts: [[lookupPart(), { thoughtSignature: "c2lnXzE=" }]],
      content: [toolCall(), { type: "text", text: "", textSignature: "c2lnXzE=" }],
    },
  ])("$name", async ({ parts, content }) => {
    const { output } = await runFixture(
      parts.map((chunk, index) =>
        response({
          parts: chunk,
          ...(index === parts.length - 1 ? { finishReason: FinishReason.STOP } : {}),
        }),
      ),
    );
    expect(output.content).toEqual(content);
  });

  it.each([
    {
      name: "signed empty thinking and text parts",
      parts: [
        { thought: true, text: "", thoughtSignature: "c2lnXzE=" },
        { text: "", thoughtSignature: "c2lnXzI=" },
        { text: "answer" },
      ],
      content: [
        { type: "thinking", thinking: "", thinkingSignature: "c2lnXzE=" },
        { type: "text", text: "", textSignature: "c2lnXzI=" },
        { type: "text", text: "answer", textSignature: undefined },
      ],
    },
    {
      name: "signed text followed by unsigned text",
      parts: [{ text: "signed", thoughtSignature: "c2lnXzE=" }, { text: "unsigned" }],
      content: [
        { type: "text", text: "signed", textSignature: "c2lnXzE=" },
        { type: "text", text: "unsigned", textSignature: undefined },
      ],
    },
    {
      name: "separately signed thoughts with the same signature",
      parts: [
        { thought: true, text: "first", thoughtSignature: "c2lnXzE=" },
        { thought: true, text: "second", thoughtSignature: "c2lnXzE=" },
      ],
      content: [
        { type: "thinking", thinking: "first", thinkingSignature: "c2lnXzE=" },
        { type: "thinking", thinking: "second", thinkingSignature: "c2lnXzE=" },
      ],
    },
  ])("round-trips exact provider part ownership for $name", async ({ parts, content }) => {
    const { output, events } = await runFixture([finished(parts)]);
    expect(output.content).toEqual(content);
    expect(convertMessages(model, { messages: [output] })).toEqual([{ role: "model", parts }]);
    expect(
      events
        .filter((event) => event.type === "text_delta" || event.type === "thinking_delta")
        .map((event) => event.delta),
    ).toEqual(parts.map((part) => part.text));
  });
});

describe("runGoogleGenerateContentLifecycle", () => {
  it("reports SDK stream acceptance without fabricated HTTP metadata", async () => {
    const acceptanceObserver = vi.fn();
    const options = withProviderAcceptanceObserver({}, acceptanceObserver);
    const { result } = await runFixture(
      [response({ parts: [{ text: "ok" }], finishReason: FinishReason.STOP })],
      { options },
    );
    expect(result.stopReason).toBe("stop");
    expect(acceptanceObserver).toHaveBeenCalledWith({ kind: "provider_stream_opened" });
  });

  it("closes an unread SDK stream without waiting when acceptance fails", async () => {
    const close = vi.fn(() => new Promise<IteratorResult<GenerateContentResponse>>(() => {}));
    const googleStream = {
      next: vi.fn(),
      return: close,
      throw: vi.fn(),
      [Symbol.asyncIterator]() {
        return this;
      },
    } as unknown as AsyncGenerator<GenerateContentResponse>;
    const options = withProviderAcceptanceObserver({}, () => {
      throw new Error("acceptance observer failed");
    });
    const { result } = await runFixture([], {
      options,
      generateContentStream: async () => googleStream,
    });
    expect(result).toMatchObject({
      stopReason: "error",
      errorMessage: "acceptance observer failed",
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it("keeps an unspecified Google finish reason nonterminal", async () => {
    const { result } = await runFixture([
      response({
        parts: [{ text: "partial output" }],
        finishReason: FinishReason.FINISH_REASON_UNSPECIFIED,
      }),
    ]);
    expect(result).toMatchObject({
      stopReason: "error",
      errorCode: "STREAM_INCOMPLETE",
      errorType: "google_incomplete_stream",
      errorMessage: "Google stream ended before a terminal finish reason",
    });
  });

  it("closes partial text before reporting a failed candidate", async () => {
    const { events, result } = await runFixture([
      response({
        parts: [{ text: "partial output" }],
        finishReason: FinishReason.SAFETY,
        finishMessage: "Provider rejected the generated response",
      }),
    ]);
    expect(events.map((event) => event.type)).toEqual([
      "start",
      "text_start",
      "text_delta",
      "text_end",
      "error",
    ]);
    expect(result).toMatchObject({
      stopReason: "error",
      errorCode: "SAFETY",
      errorType: "google_generation_failed",
      errorMessage: "Google generation stopped (SAFETY): Provider rejected the generated response",
    });
  });

  it("preserves cancellation precedence over an observed candidate failure", async () => {
    const controller = new AbortController();
    const abortReason = Object.assign(new Error("Google run restarted"), {
      code: "GATEWAY_RESTART",
    });
    const { output, result } = await runFixture([], {
      options: { signal: controller.signal },
      generateContentStream: async () => ({
        async *[Symbol.asyncIterator]() {
          yield response({
            parts: [{ text: "partial output" }],
            finishReason: FinishReason.SAFETY,
          });
          controller.abort(abortReason);
        },
      }),
    });
    expect(result).toMatchObject({
      stopReason: "aborted",
      errorCode: "GATEWAY_RESTART",
      errorMessage: "Google run restarted",
    });
    expect(output.errorCode).toBe("GATEWAY_RESTART");
  });

  it.each([429])("preserves the official Google SDK's %s API error status", async (status) => {
    const { result } = await runFixture([], {
      generateContentStream: async () => {
        throw new ApiError({ status, message: "Google quota exceeded" });
      },
    });
    expect(result).toMatchObject({
      stopReason: "error",
      errorCode: String(status),
      errorMessage: `${status}: Google quota exceeded`,
    });
  });

  it("preserves the typed Gemini finish reason when the official SDK omits finishMessage", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        `data: ${JSON.stringify({
          candidates: [
            {
              finishReason: "SAFETY",
              finishMessage: "Gemini Developer API strips this field",
            },
          ],
        })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      ),
    );
    try {
      const { result } = await runFixture([], {
        createClient: () => new GoogleGenAI({ apiKey: "test-gemini-api-key" }),
        buildParams: () => ({
          model: model.id,
          contents: [{ role: "user", parts: [{ text: "hello" }] }],
        }),
      });
      expect(result).toMatchObject({
        stopReason: "error",
        errorCode: "SAFETY",
        errorType: "google_generation_failed",
        errorMessage: "Google generation stopped (SAFETY)",
      });
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      fetchMock.mockRestore();
    }
  });

  it.each([BlockedReason.SAFETY, undefined])(
    "surfaces blocked Google prompts as typed stream errors when blockReason is %s",
    async (blockReason) => {
      const { result } = await runFixture([
        response({
          promptFeedback: {
            ...(blockReason ? { blockReason } : {}),
            blockReasonMessage: "Prompt violates provider safety policy",
          },
          usageMetadata: { promptTokenCount: 12, cachedContentTokenCount: 2, totalTokenCount: 12 },
        }),
      ]);
      const expectedBlockReason = blockReason ?? "PROMPT_BLOCKED";
      expect(result).toMatchObject({
        stopReason: "error",
        errorCode: expectedBlockReason,
        errorType: "google_prompt_blocked",
        errorMessage: `Google prompt blocked (${expectedBlockReason}): Prompt violates provider safety policy`,
        content: [],
        usage: { input: 10, cacheRead: 2, totalTokens: 12 },
      });
      expect(result.usage.cost.total).toBeGreaterThan(0);
    },
  );

  it("surfaces HTTP response body text from Google-compatible errors", async () => {
    const error = Object.assign(new Error("502 status code (no body)"), {
      status: 502,
      body: "gateway maintenance",
    });
    const { output } = await runFixture([], {
      generateContentStream: async () => {
        throw error;
      },
    });
    expect(output.errorMessage).toBe("502: gateway maintenance");
  });

  it("redacts generated video bytes from Google terminal fields", async () => {
    const media = "QUJDRA==";
    const error = Object.assign(new Error("502 status code (no body)"), {
      status: 502,
      body: { generatedVideos: [{ video: { videoBytes: media, mimeType: "video/mp4" } }] },
    });
    const { output } = await runFixture([], {
      generateContentStream: async () => {
        throw error;
      },
    });
    expect(output.errorCode).toBe("502");
    expect(JSON.stringify(output)).not.toContain(media);
  });
});

describe("buildGoogleGenerateContentParams", () => {
  it("forwards stop sequences to Google generation config", () => {
    const params = buildGoogleGenerateContentParams(
      model,
      { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
      { stop: ["STOP"] },
    );
    expect(params.config?.stopSequences).toEqual(["STOP"]);
  });

  it("strips the internal cache boundary marker from systemInstruction", () => {
    const params = buildGoogleGenerateContentParams(model, {
      systemPrompt: `Stable${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic`,
      messages: [{ role: "user", content: "hello", timestamp: 0 }],
    });
    expect(params.config?.systemInstruction).toBe("Stable\nDynamic");
    expect(JSON.stringify(params)).not.toContain("OPENCLAW_CACHE_BOUNDARY");
  });
});

type GoogleSharedTestModel = ReturnType<typeof makeModel> | ReturnType<typeof makeGeminiCliModel>;
const convertMessagesForTest = convertMessages as unknown as (
  model: GoogleSharedTestModel,
  context: Context,
) => ReturnType<typeof convertMessages>;
const conversionModel = makeModel("gemini-3-flash");
const call = { type: "toolCall" as const, id: "call_1", name: "lookup", arguments: {} };
const result = makeTextToolResult("call_1", "lookup", "ok", false, 0);
const convert = (messages: Context["messages"]) =>
  convertMessagesForTest(conversionModel, { messages });

describe("Google tool declarations", () => {
  it.each([
    {
      properties: { action: { type: "string" } },
      required: ["action"],
    },
    {
      type: "object",
      patternProperties: { "^x-": { type: "string" } },
      additionalProperties: false,
      properties: {
        mode: { type: "string", const: "fast" },
        options: { anyOf: [{ type: "string" }, { type: "number" }] },
        list: { type: "array", items: { type: "string", const: "item" } },
      },
      required: ["mode"],
    },
  ])("preserves tool parameter schema %j without filtering", (parameters) => {
    expect(
      getFirstToolParameters(
        convertGoogleTools([
          { name: "demo", description: "Demo", parameters: structuredClone(parameters) },
        ]) ?? [],
      ),
    ).toStrictEqual(parameters);
  });

  it("omits optional metadata from normalized Gemini function declarations", () => {
    const parameters = normalizeToolParameterSchema(
      {
        type: "object",
        properties: { message: { type: "string" }, timeout: { type: "number", "~optional": true } },
        required: ["message"],
      },
      { modelProvider: "google", modelId: "gemini-2.5-flash" },
    );
    expect(
      getFirstToolParameters(
        convertGoogleTools([{ name: "demo", description: "Demo", parameters }]) ?? [],
      ),
    ).toStrictEqual({
      type: "object",
      properties: { message: { type: "string" }, timeout: { type: "number" } },
      required: ["message"],
    });
  });

  it("keeps Google tool declarations stable across discovery order", () => {
    const tools = [
      { name: "zeta", description: "Last", parameters: { type: "object" } },
      { name: "alpha", description: "First", parameters: { type: "object" } },
    ] as Tool[];
    expect(convertGoogleTools(tools)).toEqual(convertGoogleTools(tools.toReversed()));
    expect(convertGoogleTools(tools)?.[0]?.functionDeclarations.map((tool) => tool.name)).toEqual([
      "alpha",
      "zeta",
    ]);
  });
});

describe("Google message conversion", () => {
  it.each([
    {
      replay: "managed" as const,
      required: true,
      expected: [
        "c2lnXzE=",
        "skip_thought_signature_validator",
        "c2lnXzI=",
        "c2lnXzE=",
        "c2lnXzI=",
      ],
    },
    {
      replay: "signed-parts" as const,
      required: true,
      expected: ["c2lnXzE=", undefined, "c2lnXzI=", undefined, "skip_thought_signature_validator"],
    },
    {
      replay: "managed" as const,
      required: false,
      expected: ["c2lnXzE=", undefined, "c2lnXzI=", undefined, undefined],
    },
    {
      replay: "signed-parts" as const,
      required: false,
      expected: ["c2lnXzE=", undefined, "c2lnXzI=", undefined, undefined],
    },
  ])(
    "preserves $replay signature ownership with required=$required",
    ({ replay, required, expected }) => {
      const target = required ? conversionModel : makeModel("gemini-2.5-pro");
      const args = { first: 1, nested: { alpha: 2, beta: 3 } };
      const reordered = { nested: { beta: 3, alpha: 2 }, first: 1 };
      const originalBytes = JSON.stringify([args, reordered]);
      const turn = (content: AssistantMessage["content"]) => ({
        ...createAssistantOutput(target),
        content,
      });
      const contents = projectGoogleMessages({
        model: target,
        replay,
        requiresToolCallSignature: required,
        messages: [
          turn([
            { ...call, arguments: args, thoughtSignature: "c2lnXzE=" },
            { ...call, arguments: reordered },
          ]),
          result,
          result,
          turn([
            { ...call, arguments: args, thoughtSignature: "c2lnXzI=" },
            { ...call, arguments: reordered },
          ]),
          result,
          result,
          turn([{ ...call, arguments: reordered }]),
          result,
        ],
      });
      const parts = contents
        .flatMap((content) => content.parts)
        .filter((part) => part.functionCall);
      expect(parts.map((part) => part.thoughtSignature)).toEqual(expected);
      expect(parts.map((part) => part.functionCall?.args)).toEqual([
        args,
        reordered,
        args,
        reordered,
        reordered,
      ]);
      expect(parts[1]?.functionCall?.args).toBe(reordered);
      expect(JSON.stringify([args, reordered])).toBe(originalBytes);
    },
  );

  it.each([
    {
      label: "user",
      messages: [
        { role: "user", content: "Hello", timestamp: 0 },
        { role: "user", content: "How are you?", timestamp: 1 },
      ],
      expected: [
        { role: "user", parts: [{ text: "Hello" }] },
        { role: "user", parts: [{ text: "How are you?" }] },
      ],
    },
    {
      label: "model",
      messages: [
        makeGoogleAssistantMessage(conversionModel.id, [{ type: "text", text: "Hi there!" }]),
        makeGoogleAssistantMessage(conversionModel.id, [{ type: "text", text: "How can I help?" }]),
      ],
      expected: [
        { role: "model", parts: [{ text: "Hi there!" }] },
        { role: "model", parts: [{ text: "How can I help?" }] },
      ],
    },
  ])("preserves consecutive $label turns", ({ messages, expected }) => {
    expect(convert(messages as Context["messages"])).toEqual(expected);
  });

  it.each([
    { value: '{"query":"cats"}', expected: { query: "cats" } },
    { value: "{not valid json", expected: {} },
    { value: ["not", "an", "object"], expected: {} },
  ])("coerces serialized tool arguments $value to SDK objects", ({ value, expected }) => {
    const context = {
      messages: [makeGoogleAssistantMessage(conversionModel.id, [{ ...call, arguments: value }])],
    } as Context;
    expect(
      convertMessagesForTest(conversionModel, context)[0]?.parts?.[0]?.functionCall?.args,
    ).toEqual(expected);
  });

  it.each([
    { label: "empty user text", messages: [{ role: "user", content: "" }] },
    {
      label: "empty user text part",
      messages: [{ role: "user", content: [{ type: "text", text: "" }] }],
    },
    { label: "empty user parts", messages: [{ role: "user", content: [] }] },
    {
      label: "blank assistant history",
      messages: [makeGoogleAssistantMessage(conversionModel.id, [{ type: "text", text: "   " }])],
    },
  ])("keeps $label valid for the Google SDK", ({ messages }) => {
    expect(convert(messages as Context["messages"])).toEqual([
      { role: "user", parts: [{ text: " " }] },
    ]);
  });

  it.each(["foreign route", "user turn", "runtime context"] as const)(
    "does not replay an earlier signature across a %s",
    (boundary) => {
      const contents = convert([
        makeGoogleAssistantMessage(conversionModel.id, [{ ...call, thoughtSignature: "c2lnbmVk" }]),
        ...(boundary === "foreign route"
          ? []
          : [
              boundary === "runtime context"
                ? {
                    role: "user",
                    content: "OpenClaw runtime context:\na new question",
                    timestamp: 1,
                    runtimeContext: {},
                  }
                : { role: "user", content: "a new question", timestamp: 1 },
            ]),
        {
          ...makeGoogleAssistantMessage(conversionModel.id, [call]),
          ...(boundary === "foreign route" ? { api: "google-vertex" } : {}),
        },
      ] as Context["messages"]);
      expect(
        contents
          .flatMap((content) => content.parts ?? [])
          .filter((part) => part.functionCall)
          .map((part) => part.thoughtSignature),
      ).toEqual(["c2lnbmVk", "skip_thought_signature_validator"]);
    },
  );

  it("strips call and response IDs for google-gemini-cli", () => {
    const target = makeGeminiCliModel(conversionModel.id);
    const contents = convertMessagesForTest(target, {
      messages: [
        makeGeminiCliAssistantMessage(target.id, [{ ...call, thoughtSignature: "dGVzdA==" }]),
        result,
      ],
    } as Context);
    const parts = contents.flatMap((content) => content.parts ?? []);
    expect(parts.find((part) => part.functionCall)?.functionCall).toEqual({
      name: "lookup",
      args: {},
    });
    expect(parts.find((part) => part.functionResponse)?.functionResponse).toEqual({
      name: "lookup",
      response: { output: "ok" },
    });
  });

  it("serializes structured tool results into function responses", () => {
    const contents = convertMessagesForTest(conversionModel, {
      messages: [
        {
          ...result,
          content: [{ type: "json", payload: { sessionKey: "current", status: "ok" } }],
        },
      ],
    } as unknown as Context);
    expect(assertRecord(contents[0]?.parts?.[0]?.functionResponse?.response).output).toBe(
      '{"type":"json","payload":{"sessionKey":"current","status":"ok"}}',
    );
  });

  it("omits payload-less tool images without media placeholders", () => {
    const contents = convertMessagesForTest(conversionModel, {
      messages: [
        {
          ...result,
          content: [{ type: "image", mimeType: "image/png", data: "" }],
        },
      ],
    });
    const serialized = JSON.stringify(contents);
    expect(serialized).toContain('"output":""');
    expect(serialized).not.toContain("inlineData");
    expect(serialized).not.toContain("see attached image");
  });

  it.each([
    { id: "google/gemini-2.5-pro", deferred: true },
    { id: "models/gemini-3.1-pro-preview", deferred: false },
  ])("keeps parallel image results in the supported location for $id", ({ id, deferred }) => {
    const target: ReturnType<typeof makeModel> = { ...makeModel(id), input: ["text", "image"] };
    const image = { inlineData: { mimeType: "image/png", data: "AAAA" } };
    const contents = convertMessagesForTest(target, {
      messages: [
        { role: "user", content: "Screenshot the page and check the weather.", timestamp: 0 },
        makeGoogleAssistantMessage(id, [
          { ...call, name: "screenshot" },
          { ...call, id: "call_2", name: "weather" },
        ]),
        { ...result, toolName: "screenshot", content: [{ type: "image", ...image.inlineData }] },
        makeTextToolResult("call_2", "weather", "Sunny, 21C", false, 0),
      ],
    } as Context);
    expectConvertedRoles(
      contents,
      deferred ? ["user", "model", "user", "user"] : ["user", "model", "user"],
    );
    expect(contents[2]?.parts?.map((part) => part.functionResponse?.name)).toEqual([
      "screenshot",
      "weather",
    ]);
    expect(contents[1]?.parts?.map((part) => part.functionCall?.id)).toEqual(["call_1", "call_2"]);
    expect(contents[1]?.parts?.map((part) => part.thoughtSignature)).toEqual(
      deferred ? [undefined, undefined] : ["skip_thought_signature_validator", undefined],
    );
    expect(contents[2]?.parts?.map((part) => part.functionResponse?.id)).toEqual([
      "call_1",
      "call_2",
    ]);
    if (deferred) {
      expect(contents[3]).toEqual({ role: "user", parts: [{ text: "Tool result image:" }, image] });
      expect(
        contents
          .slice(3)
          .flatMap((content) => content.parts ?? [])
          .some((part) => part.functionResponse),
      ).toBe(false);
    } else {
      expect(contents[2]?.parts?.[0]?.functionResponse?.parts).toEqual([image]);
    }
  });
});
