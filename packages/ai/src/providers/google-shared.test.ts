import { FinishReason, GenerateContentResponse, type Part } from "@google/genai";
import { expect, it, vi } from "vitest";
import { makeTextToolResult } from "../../../../test/helpers/text-tool-result.js";
import { createAssistantOutput } from "../transports/assistant-output.js";
import { withProviderAcceptanceObserver } from "../transports/transport-stream-shared.js";
import type { AssistantMessage, AssistantMessageEvent, Context, UserMessage } from "../types.js";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "../utils/system-prompt-cache-boundary.js";
import { normalizeToolParameterSchema } from "./agent-tools-parameter-schema.js";
import { convertGoogleTools, projectGoogleMessages } from "./google-messages.js";
import {
  buildGoogleGenerateContentParams as buildParams,
  type GoogleGenerateContentClient,
} from "./google-shared.js";
import {
  convertMessages,
  getFirstToolParameters,
  makeGeminiCliModel,
  makeGoogleAssistantMessage,
  makeModel,
} from "./google-shared.test-helpers.js";
import { streamGoogle } from "./google.js";

const googleSdk = vi.hoisted(() => ({
  generateContentStream: vi.fn<GoogleGenerateContentClient["models"]["generateContentStream"]>(),
}));
vi.mock("@google/genai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@google/genai")>()),
  GoogleGenAI: class {
    models = { generateContentStream: googleSdk.generateContentStream };
  },
}));

const user = (content: UserMessage["content"]): UserMessage => ({
  role: "user",
  content,
  timestamp: 0,
});
const model = {
  ...makeModel("gemini-test"),
  reasoning: true,
  cost: { input: 1, output: 2, cacheRead: 0.25, cacheWrite: 0 },
};
const textPart = (text: string, thoughtSignature?: string): Part => ({
  text,
  ...(thoughtSignature && { thoughtSignature }),
});
const thoughtPart = (text: string, thoughtSignature?: string): Part => ({
  ...textPart(text, thoughtSignature),
  thought: true,
});
const textOutput = (text: string, textSignature?: string) => ({
  type: "text",
  text,
  textSignature,
});
const thoughtOutput = (thinking: string, thinkingSignature?: string) => ({
  type: "thinking",
  thinking,
  thinkingSignature,
});
const signature1 = "c2lnXzE=";
const signature2 = "c2lnXzI=";
const imageData = { mimeType: "image/png", data: "AAAA" };

it("omits an empty disabled thinking config for Gemini 2.5 Pro without an output cap", () => {
  expect(
    buildParams(
      { ...model, id: "gemini-2.5-pro" },
      { messages: [] },
      { thinking: { enabled: false } },
    ).config?.thinkingConfig,
  ).toBeUndefined();
});

const response = (fields: Partial<GenerateContentResponse>) =>
  Object.assign(new GenerateContentResponse(), fields);
function candidate(parts?: Part[], finishReason?: FinishReason, finishMessage?: string) {
  return {
    candidates: [
      { content: parts === undefined ? undefined : { parts }, finishReason, finishMessage },
    ],
  };
}
const finished = (parts?: Part[], reason = FinishReason.STOP, message?: string) =>
  candidate(parts, reason, message);
const partialFinish = (reason: FinishReason, message?: string) =>
  finished([textPart("partial output")], reason, message);
const usageChunk = (usageMetadata: GenerateContentResponse["usageMetadata"], terminal = false) => ({
  ...(terminal ? finished() : {}),
  usageMetadata,
});

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

type GoogleFixtureOptions = {
  options?: Parameters<typeof streamGoogle>[2];
  generateContentStream?: GoogleGenerateContentClient["models"]["generateContentStream"];
};

async function runFixture(
  responses: Parameters<typeof response>[0][] = [],
  fixture: GoogleFixtureOptions = {},
) {
  googleSdk.generateContentStream.mockImplementation(
    fixture.generateContentStream ??
      async function* () {
        yield* responses.map(response);
      },
  );
  const clock = vi.spyOn(Date, "now").mockReturnValue(123);
  try {
    const stream = streamGoogle(
      model,
      { messages: [] },
      { apiKey: "test-key", ...fixture.options },
    );
    const events: AssistantMessageEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }
    const result = await stream.result();
    return { output: result, events, result };
  } finally {
    clock.mockRestore();
  }
}

it("projects text, thinking, tool calls, response id, and usage into one stream", async () => {
  const { output, events } = await runFixture([
    {
      responseId: "response-1",
      ...candidate([
        thoughtPart("thinking", "dGhpbms="),
        textPart("hello"),
        { functionCall: { name: "lookup", args: { query: "cats" } } },
      ]),
    },
    usageChunk(
      {
        promptTokenCount: 10,
        cachedContentTokenCount: 2,
        candidatesTokenCount: 3,
        thoughtsTokenCount: 4,
        totalTokenCount: 17,
      },
      true,
    ),
  ]);
  expect(events.map((event) => event.type)).toEqual(
    "start thinking_start thinking_delta thinking_end text_start text_delta text_end toolcall_start toolcall_delta toolcall_end done".split(
      " ",
    ),
  );
  const toolDelta = events.find((event) => event.type === "toolcall_delta");
  expect(toolDelta?.partial?.content[toolDelta.contentIndex ?? -1]).toMatchObject({
    partialJson: '{"query":"cats"}',
  });
  expect(output).toMatchObject({
    responseId: "response-1",
    stopReason: "toolUse",
    usage: { input: 8, output: 7, cacheRead: 2, totalTokens: 17 },
  });
  expect(output.content).toEqual([
    thoughtOutput("thinking", "dGhpbms="),
    textOutput("hello"),
    toolCall({ query: "cats" }, undefined, "lookup_123_1"),
  ]);
  expect(output.usage.cost.total).toBeGreaterThan(0);
});

type UsageCase = [string, Partial<GenerateContentResponse>[], Partial<AssistantMessage["usage"]>];
it.each([
  [
    "retains prompt/cache/tool usage across sparse chunks",
    [
      usageChunk({
        promptTokenCount: 100,
        cachedContentTokenCount: 40,
        toolUsePromptTokenCount: 6,
        candidatesTokenCount: 1,
        totalTokenCount: 107,
      }),
      usageChunk({ candidatesTokenCount: 12, thoughtsTokenCount: 3 }, true),
    ],
    { input: 66, output: 15, cacheRead: 40, totalTokens: 121 },
  ],
  [
    "clamps negative input from sparse cache usage",
    [usageChunk({ cachedContentTokenCount: 40, toolUsePromptTokenCount: 6 }, true)],
    { input: 6, cacheRead: 40 },
  ],
] satisfies UsageCase[])("%s", async (_name, responses, usage) => {
  expect((await runFixture(responses)).output.usage).toMatchObject(usage);
});

it.each([FinishReason.MAX_TOKENS, FinishReason.CONTINUATION])(
  "preserves %s when the partial response contains a function call",
  async (finishReason) => {
    const { output, events } = await runFixture([
      finished([{ functionCall: { name: "lookup", args: { query: "cats" } } }], finishReason),
    ]);
    expect(events.find((event) => event.type === "done")?.reason).toBe("length");
    expect(output.stopReason).toBe("length");
    expect(output.content).toEqual([expect.objectContaining({ type: "toolCall", name: "lookup" })]);
  },
);

type SignatureCase = [string, Part[][], unknown[], boolean?];
it.each<SignatureCase>([
  [
    "late standalone signature",
    [[lookupPart({ query: "cats" })], [{ thoughtSignature: "Y2FsbF9zaWc=" }]],
    [toolCall({ query: "cats" }, "Y2FsbF9zaWc=")],
  ],
  [
    "separate signature-only thought",
    [[lookupPart(), { thought: true, thoughtSignature: "dGhvdWdodF9zaWc=" }, thoughtPart("draft")]],
    [toolCall(), thoughtOutput("", "dGhvdWdodF9zaWc="), thoughtOutput("draft")],
  ],
  [
    "no signature overwrite",
    [[lookupPart({}, signature1), { thoughtSignature: signature2 }]],
    [toolCall({}, signature1), textOutput("", signature2)],
  ],
  [
    "no media signature attachment",
    [[lookupPart(), { inlineData: imageData, thoughtSignature: signature1 }]],
    [toolCall()],
  ],
  [
    "separate same-candidate signature",
    [[lookupPart(), { thoughtSignature: signature1 }]],
    [toolCall(), textOutput("", signature1)],
  ],
  [
    "signed empty thinking and text",
    [[thoughtPart("", signature1), textPart("", signature2), textPart("answer")]],
    [thoughtOutput("", signature1), textOutput("", signature2), textOutput("answer")],
    true,
  ],
  [
    "signed then unsigned text",
    [[textPart("signed", signature1), textPart("unsigned")]],
    [textOutput("signed", signature1), textOutput("unsigned")],
    true,
  ],
  [
    "separate thoughts with the same signature",
    [[thoughtPart("first", signature1), thoughtPart("second", signature1)]],
    [thoughtOutput("first", signature1), thoughtOutput("second", signature1)],
    true,
  ],
])("preserves %s", async (_name, chunks, content, roundTrip?: boolean) => {
  const { output, events } = await runFixture(
    chunks.map((parts, index) =>
      candidate(parts, index === chunks.length - 1 ? FinishReason.STOP : undefined),
    ),
  );
  expect(output.content).toEqual(content);
  if (roundTrip) {
    const parts = chunks.flat();
    expect(convertMessages(model, { messages: [output] })).toEqual([{ role: "model", parts }]);
    expect(
      events
        .filter((event) => event.type === "text_delta" || event.type === "thinking_delta")
        .map((event) => event.delta),
    ).toEqual(parts.map((part) => part.text));
  }
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
  expect(result).toMatchObject({ stopReason: "error", errorMessage: "acceptance observer failed" });
  expect(close).toHaveBeenCalledOnce();
});

it("closes partial text before reporting a failed candidate", async () => {
  const { events, result } = await runFixture([
    partialFinish(FinishReason.SAFETY, "Provider rejected the generated response"),
  ]);
  expect(events.map((event) => event.type)).toEqual(
    "start text_start text_delta text_end error".split(" "),
  );
  expect(result).toMatchObject({
    stopReason: "error",
    errorCode: "SAFETY",
    errorType: "google_generation_failed",
    errorMessage: "Google generation stopped (SAFETY): Provider rejected the generated response",
  });
});

it("preserves cancellation precedence over an observed candidate failure", async () => {
  const controller = new AbortController();
  const abortReason = Object.assign(new Error("Google run restarted"), { code: "GATEWAY_RESTART" });
  const { result } = await runFixture([], {
    options: { signal: controller.signal },
    generateContentStream: async () => ({
      async *[Symbol.asyncIterator]() {
        yield response(partialFinish(FinishReason.SAFETY));
        controller.abort(abortReason);
      },
    }),
  });
  expect(result).toMatchObject({
    stopReason: "aborted",
    errorCode: "GATEWAY_RESTART",
    errorMessage: "Google run restarted",
  });
});

it("surfaces blocked Google prompts without a reason as typed stream errors", async () => {
  const { result } = await runFixture([
    {
      promptFeedback: { blockReasonMessage: "Prompt violates provider safety policy" },
      usageMetadata: { promptTokenCount: 12, cachedContentTokenCount: 2, totalTokenCount: 12 },
    },
  ]);
  expect(result).toMatchObject({
    stopReason: "error",
    errorCode: "PROMPT_BLOCKED",
    errorType: "google_prompt_blocked",
    errorMessage: "Google prompt blocked (PROMPT_BLOCKED): Prompt violates provider safety policy",
    content: [],
    usage: { input: 10, cacheRead: 2, totalTokens: 12 },
  });
  expect(result.usage.cost.total).toBeGreaterThan(0);
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

it("forwards stop sequences to Google generation config", () => {
  const params = buildParams(model, { messages: [user("hello")] }, { stop: ["STOP"] });
  expect(params.config?.stopSequences).toEqual(["STOP"]);
});

it("strips the internal cache boundary marker from systemInstruction", () => {
  const params = buildParams(model, {
    systemPrompt: `Stable${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic`,
    messages: [user("hello")],
  });
  expect(params.config?.systemInstruction).toBe("Stable\nDynamic");
  expect(JSON.stringify(params)).not.toContain("OPENCLAW_CACHE_BOUNDARY");
});

type GoogleSharedTestModel = ReturnType<typeof makeModel> | ReturnType<typeof makeGeminiCliModel>;
const convertMessagesForTest = convertMessages as unknown as (
  model: GoogleSharedTestModel,
  context: Context,
) => ReturnType<typeof convertMessages>;
const conversionModel = makeModel("gemini-3-flash");
const call = { type: "toolCall" as const, id: "call_1", name: "lookup", arguments: {} };
const result = makeTextToolResult("call_1", "lookup", "ok", false, 0);
const convert = (messages: Context["messages"], target: GoogleSharedTestModel = conversionModel) =>
  convertMessagesForTest(target, { messages });
function assistant(
  content: AssistantMessage["content"],
  target: GoogleSharedTestModel = conversionModel,
) {
  return { ...createAssistantOutput(target), content, timestamp: 0 };
}

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

it("preserves managed signature ownership with required signatures", () => {
  const args = { first: 1, nested: { alpha: 2, beta: 3 } };
  const reordered = { nested: { beta: 3, alpha: 2 }, first: 1 };
  const originalBytes = JSON.stringify([args, reordered]);
  const replayPair = (thoughtSignature: string) => [
    assistant([
      { ...call, arguments: args, thoughtSignature },
      { ...call, arguments: reordered },
    ]),
    result,
    result,
  ];
  const contents = projectGoogleMessages({
    model: conversionModel,
    replay: "managed",
    requiresToolCallSignature: true,
    messages: [
      ...replayPair(signature1),
      ...replayPair(signature2),
      assistant([{ ...call, arguments: reordered }]),
      result,
    ],
  });
  const parts = contents.flatMap((content) => content.parts).filter((part) => part.functionCall);
  expect(parts.map((part) => part.thoughtSignature)).toEqual([
    signature1,
    "skip_thought_signature_validator",
    signature2,
    signature1,
    signature2,
  ]);
  expect(parts.map((part) => part.functionCall?.args)).toEqual([
    args,
    reordered,
    args,
    reordered,
    reordered,
  ]);
  expect(parts[1]?.functionCall?.args).toBe(reordered);
  expect(JSON.stringify([args, reordered])).toBe(originalBytes);
});

it("coerces malformed serialized tool arguments to an SDK object", () => {
  const context = {
    messages: [
      makeGoogleAssistantMessage(conversionModel.id, [{ ...call, arguments: "{not valid json" }]),
    ],
  } as Context;
  expect(convert(context.messages)[0]?.parts?.[0]?.functionCall?.args).toEqual({});
});

it.each([
  ["empty user text", [user([{ type: "text", text: "" }])]],
  ["empty user parts", [user([])]],
  ["blank assistant", [assistant([{ type: "text", text: "   " }])]],
] satisfies Array<[string, Context["messages"]]>)(
  "keeps %s valid for the Google SDK",
  (_label, messages) => {
    expect(convert(messages)).toEqual([{ role: "user", parts: [{ text: " " }] }]);
  },
);

it("does not replay an earlier signature across a foreign route", () => {
  const contents = convert([
    assistant([{ ...call, thoughtSignature: "c2lnbmVk" }]),
    { ...assistant([call]), api: "google-vertex" },
  ] as Context["messages"]);
  expect(
    contents
      .flatMap((content) => content.parts ?? [])
      .filter((part) => part.functionCall)
      .map((part) => part.thoughtSignature),
  ).toEqual(["c2lnbmVk", "skip_thought_signature_validator"]);
});

it("strips call and response IDs for google-gemini-cli", () => {
  const target = makeGeminiCliModel(conversionModel.id);
  const contents = convert(
    [assistant([{ ...call, thoughtSignature: "dGVzdA==" }], target), result],
    target,
  );
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

it("omits payload-less tool images without media placeholders", () => {
  const contents = convert([
    { ...result, content: [{ type: "image", mimeType: "image/png", data: "" }] },
  ]);
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
  const image = { inlineData: imageData };
  const contents = convert(
    [
      user("Screenshot the page and check the weather."),
      assistant(
        [
          { ...call, name: "screenshot" },
          { ...call, id: "call_2", name: "weather" },
        ],
        target,
      ),
      { ...result, toolName: "screenshot", content: [{ type: "image", ...image.inlineData }] },
      makeTextToolResult("call_2", "weather", "Sunny, 21C", false, 0),
    ],
    target,
  );
  expect(contents.map((entry) => entry.role)).toEqual(
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
