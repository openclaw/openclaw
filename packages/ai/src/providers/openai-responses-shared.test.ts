// OpenAI Responses shared tests cover tool conversion and response item mapping.
import type {
  ResponseCreateParamsStreaming,
  ResponseStreamEvent,
  Tool as OpenAIResponsesTool,
} from "openai/resources/responses/responses.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createResponsesDoneArgumentEvents } from "../../../../test/helpers/openai-responses-events.js";
import { makeTextToolResult } from "../../../../test/helpers/text-tool-result.js";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import {
  buildOpenAIResponsesReasoningReplayMetadata,
  captureOpenAIResponsesCompaction,
} from "../transports/openai-responses-compaction-replay.js";
import { isInvalidEncryptedContentError } from "../transports/openai-responses-replay-internal.js";
import { processResponsesStream } from "../transports/openai-responses-stream-internal.js";
import type { AssistantMessage, AssistantMessageEvent, Context, Model } from "../types.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "../utils/system-prompt-cache-boundary.js";
import { resolveOpenAISimpleReasoningEffort } from "./openai-request-reasoning.js";
import {
  applyCommonResponsesParams,
  createResponsesAssistantOutput,
  convertResponsesMessages,
  runResponsesStreamLifecycle,
} from "./openai-responses-shared.js";
import { convertResponsesToolPayload } from "./openai-responses-tools.js";

type ResponsesFunctionTool = Extract<OpenAIResponsesTool, { type: "function" }>;
async function* streamResponsesEvents<T>(events: readonly T[]): AsyncGenerator<T> {
  yield* events;
}

function createNeverYieldingResponsesStream<T>(): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          return new Promise<IteratorResult<T>>(() => {});
        },
      };
    },
  };
}

function createCapturedAssistantMessageEventStream(): {
  stream: AssistantMessageEventStream;
  events: AssistantMessageEvent[];
} {
  const stream = new AssistantMessageEventStream();
  const events: AssistantMessageEvent[] = [];
  const push = stream.push.bind(stream);
  stream.push = (event) => {
    events.push(event);
    push(event);
  };
  return { stream, events };
}

function expectResponsesFunctionTool(tool: OpenAIResponsesTool | undefined): ResponsesFunctionTool {
  expect(tool).toHaveProperty("type", "function");
  return tool as ResponsesFunctionTool;
}

const nativeOpenAIModel = {
  id: "gpt-5.5",
  name: "GPT-5.5",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 8192,
} satisfies Model<"openai-responses">;

const proxyOpenAIModel = {
  ...nativeOpenAIModel,
  id: "custom-model",
  name: "Custom Model",
  baseUrl: "https://proxy.example.com/v1",
} satisfies Model<"openai-responses">;

const gpt56SolModel = {
  ...nativeOpenAIModel,
  id: "gpt-5.6-sol",
  name: "GPT-5.6 Sol",
  thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" },
} satisfies Model<"openai-responses">;

const testAllowedToolCallProviders = new Set(["openai", "openai-codex", "opencode"]);
const reasoningReplayIdentity = { sessionId: "session-a", authProfileId: "profile-a" };

type LifecycleParams = Parameters<typeof runResponsesStreamLifecycle>[0];
type RequestOptions = Parameters<
  ReturnType<LifecycleParams["createClient"]>["responses"]["create"]
>[1];

function startLifecycle(
  send: (
    attempt: number,
    options: RequestOptions,
  ) => AsyncIterable<ResponseStreamEvent> | Promise<AsyncIterable<ResponseStreamEvent>>,
  params: Pick<LifecycleParams, "options"> & Partial<Pick<LifecycleParams, "buildParams">> = {},
) {
  const output = createAssistantOutput();
  const { stream, events } = createCapturedAssistantMessageEventStream();
  const requests: ResponseCreateParamsStreaming[] = [];
  const done = runResponsesStreamLifecycle({
    model: nativeOpenAIModel,
    output,
    stream,
    buildParams: () => ({ model: nativeOpenAIModel.id, input: [], stream: true }),
    ...params,
    createClient: () => ({
      responses: {
        create: (request, options) => {
          requests.push(structuredClone(request));
          return {
            withResponse: async () => ({
              data: await send(requests.length, options),
              response: new Response(null, { status: 200 }),
            }),
          };
        },
      },
    }),
  });
  return { output, events, requests, done };
}

async function collectResponses(input: readonly unknown[]) {
  const output = createAssistantOutput();
  const { stream, events } = createCapturedAssistantMessageEventStream();
  await processResponsesStream(streamResponsesEvents(input), output, stream, nativeOpenAIModel);
  return { output, events };
}

function argumentsDelta(delta: string, outputIndex?: number, itemId?: string) {
  return {
    type: "response.function_call_arguments.delta",
    delta,
    output_index: outputIndex,
    item_id: itemId,
  };
}

function completed(id: string) {
  return { type: "response.completed", response: { id, status: "completed" } };
}

function itemEvent<P extends "added" | "done", T extends object>(
  phase: P,
  item: T,
  outputIndex?: number,
) {
  return {
    type: `response.output_item.${phase}` as const,
    item,
    output_index: outputIndex,
  };
}

function toolItem(id: string, args = "", name = "computer") {
  return {
    type: "function_call" as const,
    id: `fc_${id}`,
    call_id: `call_${id}`,
    name,
    arguments: args,
  };
}

function createAssistantOutput(): AssistantMessage {
  return { ...createResponsesAssistantOutput(nativeOpenAIModel), timestamp: 0 };
}

describe("convertResponsesToolPayload", () => {
  beforeEach(() => {
    // Mimic the OpenClaw host strict-tool policy: native OpenAI routes force
    // strict=true; compatible routes opt in to sending strict=false.
    const capabilities = getAiTransportHost().resolveProviderRequestCapabilities({});
    configureAiTransportHost({
      resolveProviderRequestCapabilities: ({ baseUrl }) => ({
        ...capabilities,
        endpointClass: baseUrl === nativeOpenAIModel.baseUrl ? "openai-public" : "custom",
      }),
      resolveOpenAIStrictToolSetting: (model, options) => {
        if (model.provider === "openai" && model.baseUrl === "https://api.openai.com/v1") {
          return true;
        }
        return options?.supportsStrictMode ? false : undefined;
      },
    });
  });

  afterEach(() => {
    configureAiTransportHost({});
  });

  it("downgrades incompatible native Responses schemas to strict false", () => {
    const converted = convertResponsesToolPayload(
      [
        {
          name: "read_file",
          description: "Read",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: { path: { type: "string" } },
            required: [],
          },
        },
      ],
      { model: nativeOpenAIModel },
    );

    const tool = expectResponsesFunctionTool(converted[0]);
    expect(tool.strict).toBe(false);
    expect(tool.parameters).toEqual({
      type: "object",
      additionalProperties: false,
      properties: { path: { type: "string" } },
      required: [],
    });
  });

  it("omits strict on proxy-like Responses routes but keeps schema normalization", () => {
    const converted = convertResponsesToolPayload(
      [
        {
          name: "lookup_weather",
          description: "Get forecast",
          parameters: {},
        },
      ],
      { model: proxyOpenAIModel },
    );

    const tool = expectResponsesFunctionTool(converted[0]);
    expect(tool).not.toHaveProperty("strict");
    expect(tool.parameters).toEqual({
      type: "object",
      properties: {},
    });
  });

  it("keeps tool order deterministic", () => {
    const tools = [
      { name: "zeta", description: "Z", parameters: {} },
      { name: "alpha", description: "A", parameters: {} },
    ];
    expect(
      convertResponsesToolPayload(tools).map((tool) => expectResponsesFunctionTool(tool).name),
    ).toEqual(["alpha", "zeta"]);
  });

  it("skips unreadable schemas and preserves healthy native strict tools", () => {
    const converted = convertResponsesToolPayload(
      [
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
      { model: nativeOpenAIModel },
    );

    expect(converted).toEqual([
      {
        type: "function",
        name: "lookup",
        description: "Lookup",
        strict: true,
        parameters: {
          type: "object",
          properties: {},
          required: [],
          additionalProperties: false,
        },
      },
    ]);
  });

  it("does not reread an unreadable tool inventory length", () => {
    const tools = new Proxy([], {
      get(target, property, receiver) {
        if (property === "length") {
          throw new Error("length exploded");
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const params = {} as never;

    applyCommonResponsesParams(params, nativeOpenAIModel, {
      messages: [{ role: "user", content: "hello", timestamp: 1 }],
      tools,
    } as never);

    expect(params).not.toHaveProperty("tools");
  });
});

describe("Responses temperature support", () => {
  it("drops temperature for the GPT-5.6 family that rejects it", () => {
    const params = {} as never;
    applyCommonResponsesParams(params, gpt56SolModel, { messages: [] }, { temperature: 0.3 });

    expect(params).not.toHaveProperty("temperature");
  });
});

describe("Responses reasoning effort", () => {
  it("passes max through for GPT-5.6 Sol", () => {
    expect(resolveOpenAISimpleReasoningEffort(gpt56SolModel, "max")).toBe("max");

    const params = {} as never;
    applyCommonResponsesParams(
      params,
      gpt56SolModel,
      { messages: [] },
      {
        reasoningEffort: "max",
      },
    );
    expect(params).toMatchObject({ reasoning: { effort: "max", summary: "auto" } });
  });

  it.each<{
    model: Model<"openai-responses">;
    reasoning: "minimal" | "high";
    expected: string;
  }>([
    {
      model: { ...proxyOpenAIModel, compat: { supportedReasoningEfforts: ["ProviderHigh"] } },
      reasoning: "high",
      expected: "ProviderHigh",
    },
  ])(
    "normalizes $reasoning to $expected at the request boundary",
    ({ model, reasoning, expected }) => {
      const params = {} as ResponseCreateParamsStreaming;
      applyCommonResponsesParams(
        params,
        model,
        { messages: [] },
        {
          reasoningEffort: resolveOpenAISimpleReasoningEffort(model, reasoning),
        },
      );
      expect(params.reasoning).toEqual({ effort: expected, summary: "auto" });
    },
  );
});

describe("convertResponsesMessages", () => {
  function replay(
    context: Context,
    options?: Parameters<typeof convertResponsesMessages>[3],
    model: Model = nativeOpenAIModel,
  ) {
    return convertResponsesMessages(model, context, testAllowedToolCallProviders, options);
  }
  function assistant(content: AssistantMessage["content"]): AssistantMessage {
    return { ...createAssistantOutput(), content };
  }

  it("strips the internal cache boundary marker from the system prompt message", () => {
    const input = replay({
      systemPrompt: `Stable${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic`,
      messages: [],
    });
    expect(input[0]).toMatchObject({
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: "Stable\nDynamic" }],
    });
    expect(JSON.stringify(input)).not.toContain("OPENCLAW_CACHE_BOUNDARY");
  });

  it("omits phase-tagged assistant replay ids without reasoning", () => {
    const input = replay(
      {
        messages: [
          assistant([
            {
              type: "text",
              text: "Working...",
              textSignature: JSON.stringify({ v: 1, id: "msg_commentary", phase: "commentary" }),
            },
          ]),
        ],
      },
      { includeSystemPrompt: false },
    );
    const message = input.find((item) => item.type === "message" && item.role === "assistant");
    expect(message).toMatchObject({ phase: "commentary" });
    expect(message).not.toHaveProperty("id");
  });

  it("omits Responses replay item ids when requested by store-disabled callers", () => {
    const input = replay(
      {
        messages: [
          {
            ...assistant([
              {
                type: "thinking",
                thinking: "Need a tool.",
                thinkingSignature: JSON.stringify({
                  type: "reasoning",
                  id: "rs_prior",
                  encrypted_content: "ciphertext",
                }),
              },
              {
                type: "text",
                text: "Checking the price.",
                textSignature: JSON.stringify({
                  v: 1,
                  id: "msg_prior",
                  phase: "commentary",
                }),
              },
              {
                type: "toolCall",
                id: "call_abc|fc_prior",
                name: "price_lookup",
                arguments: { symbol: "SOL" },
              },
            ]),
            stopReason: "toolUse",
          },
          makeTextToolResult("call_abc|fc_prior", "price_lookup", "$83.95", false, 2),
        ],
      },
      { includeSystemPrompt: false, replayResponsesItemIds: false },
    );
    const reasoningItem = input.find((item) => item.type === "reasoning");
    expect(reasoningItem).toMatchObject({
      type: "reasoning",
      encrypted_content: "ciphertext",
      summary: [],
    });
    expect(reasoningItem).not.toHaveProperty("id");
    const message = input.find((item) => item.type === "message" && item.role === "assistant");
    expect(message).toMatchObject({ type: "message", role: "assistant", phase: "commentary" });
    expect(message).not.toHaveProperty("id");
    const call = input.find((item) => item.type === "function_call");
    expect(call).toMatchObject({ type: "function_call", call_id: "call_abc" });
    expect(call).not.toHaveProperty("id");
  });

  it("preserves image-bearing tool results instead of using no-output text", () => {
    const input = replay(
      {
        messages: [
          {
            ...assistant([
              { type: "toolCall", id: "call_screenshot", name: "screenshot", arguments: {} },
            ]),
            stopReason: "toolUse",
          },
          {
            role: "toolResult",
            toolCallId: "call_screenshot",
            toolName: "screenshot",
            content: [{ type: "image", mimeType: "image/png", data: "aW1n" }],
            isError: false,
            timestamp: 2,
          },
        ],
      },
      { includeSystemPrompt: false },
      { ...nativeOpenAIModel, input: ["text", "image"] },
    );
    const result = input.find((item) => item.type === "function_call_output");
    expect(result?.output).toEqual([
      { type: "input_image", detail: "auto", image_url: "data:image/png;base64,aW1n" },
    ]);
  });

  it("uses audio placeholder for audio-only tool results instead of image or no-output text", () => {
    const input = replay(
      {
        messages: [
          {
            ...assistant([{ type: "toolCall", id: "call_audio", name: "audio", arguments: {} }]),
            stopReason: "toolUse",
          },
          {
            role: "toolResult",
            toolCallId: "call_audio",
            toolName: "audio",
            content: [{ type: "audio", mimeType: "audio/mpeg", data: "YXVkaW8=" }],
            isError: false,
            timestamp: 2,
          },
        ],
      } as unknown as Context,
      { includeSystemPrompt: false },
    );
    const result = input.find((item) => item.type === "function_call_output");
    expect(result).toMatchObject({
      type: "function_call_output",
      call_id: "call_audio",
      output: "(see attached audio)",
    });
    expect(result?.output).not.toBe("(see attached image)");
    expect(result?.output).not.toBe("(no output)");
  });

  it("does not emit image parts or placeholders for payload-less tool media", () => {
    const input = replay(
      {
        messages: [
          {
            role: "toolResult",
            toolCallId: "call_husk",
            toolName: "screenshot",
            content: [{ type: "image", mimeType: "image/png", data: "" }],
            isError: false,
            timestamp: 2,
          },
        ],
      },
      { includeSystemPrompt: false },
      { ...nativeOpenAIModel, input: ["text", "image"] },
    );
    const result = input.find((item) => item.type === "function_call_output");
    expect(result?.output).toBe("(no output)");
    expect(JSON.stringify(result)).not.toContain("input_image");
    expect(JSON.stringify(result)).not.toContain("see attached image");
  });

  const sameRoute = buildOpenAIResponsesReasoningReplayMetadata(
    nativeOpenAIModel,
    reasoningReplayIdentity,
  );
  const otherSession = buildOpenAIResponsesReasoningReplayMetadata(nativeOpenAIModel, {
    ...reasoningReplayIdentity,
    sessionId: "session-b",
  });
  it.each([
    ["matching block metadata", sameRoute, otherSession, true],
    ["mismatched block metadata", otherSession, sameRoute, false],
    ["malformed block metadata", null, sameRoute, false],
    ["mismatched embedded metadata", undefined, otherSession, false],
  ])(
    "fences encrypted reasoning with %s",
    (_name, blockMetadata, embeddedMetadata, preservesCiphertext) => {
      const input = replay(
        {
          messages: [
            assistant([
              {
                type: "thinking",
                thinking: "Safe visible reasoning.",
                thinkingSignature: JSON.stringify({
                  type: "reasoning",
                  id: "rs_route_fenced",
                  summary: [{ type: "summary_text", text: "safe summary" }],
                  content: [{ type: "reasoning_text", text: "safe content" }],
                  encrypted_content: "route-bound-ciphertext",
                  ...(embeddedMetadata !== undefined
                    ? { __openclaw_replay: embeddedMetadata }
                    : {}),
                }),
                ...(blockMetadata !== undefined ? { openclawReasoningReplay: blockMetadata } : {}),
              },
            ] as unknown as AssistantMessage["content"]),
          ],
        },
        {
          includeSystemPrompt: false,
          replayResponsesItemIds: true,
          ...reasoningReplayIdentity,
        },
      );
      const item = input.find((entry) => entry.type === "reasoning");
      if (!preservesCiphertext) {
        expect(item).toBeUndefined();
        return;
      }
      expect(item).toMatchObject({
        type: "reasoning",
        id: "rs_route_fenced",
        summary: [{ type: "summary_text", text: "safe summary" }],
        content: [{ type: "reasoning_text", text: "safe content" }],
      });
      expect(item).not.toHaveProperty("__openclaw_replay");
      expect(item).toHaveProperty("encrypted_content", "route-bound-ciphertext");
    },
  );
});

describe("processResponsesStream", () => {
  it.each([["Could not decrypt encrypted_content metadata for the OAuth sidecar.", 400, false]])(
    "classifies encrypted replay rejection: %s",
    (message, status, expected) => {
      expect(isInvalidEncryptedContentError({ message, status })).toBe(expected);
    },
  );

  it("aborts the Responses request signal when the first SSE event never arrives", async () => {
    vi.useFakeTimers();
    try {
      let requestSignal: AbortSignal | undefined;
      const onFirstEventTimeout = vi.fn();
      const { output, done } = startLifecycle(
        (_attempt, options) => {
          requestSignal = options.signal;
          return createNeverYieldingResponsesStream<ResponseStreamEvent>();
        },
        { options: { firstEventTimeoutMs: 5, onFirstEventTimeout } },
      );
      await vi.advanceTimersByTimeAsync(5);
      await done;
      expect(output.stopReason).toBe("error");
      expect(requestSignal?.aborted).toBe(true);
      expect(requestSignal?.reason).toBeInstanceOf(Error);
      expect(onFirstEventTimeout).toHaveBeenCalledWith(requestSignal?.reason);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["create", "response.failed-status", "error"] as const)(
    "recovers code-less encrypted reasoning rejected during %s stream drain",
    async (failureShape) => {
      const failureMessage =
        "400 The encrypted content [REDACTED] could not be verified. Reason: Encrypted content could not be decrypted or parsed.";
      const { output, requests, events, done } = startLifecycle(
        (attempt) => {
          if (attempt === 1 && failureShape === "create") {
            throw Object.assign(new Error(failureMessage), { status: 400 });
          }
          return (async function* () {
            if (attempt === 1) {
              yield {
                type: "response.created",
                sequence_number: 0,
                response: { id: "resp_rejected" },
              } as ResponseStreamEvent;
              yield (
                failureShape === "response.failed-status"
                  ? {
                      type: "response.failed",
                      sequence_number: 1,
                      response: {
                        id: "resp_rejected",
                        status: "failed",
                        error: {
                          code: null,
                          status: 400,
                          message: "The encrypted content could not be decrypted or parsed.",
                        },
                      },
                    }
                  : {
                      type: "error",
                      sequence_number: 1,
                      code: null,
                      message: "400 Could not decrypt the provided encrypted_content.",
                      param: null,
                    }
              ) as ResponseStreamEvent;
            } else {
              yield {
                type: "response.completed",
                sequence_number: 1,
                response: { id: "resp_recovered", status: "completed" },
              } as ResponseStreamEvent;
            }
          })();
        },
        {
          buildParams: () => ({
            model: nativeOpenAIModel.id,
            stream: true,
            input: [
              {
                type: "reasoning",
                id: "rs_replay",
                encrypted_content: "stale-reasoning",
                summary: [],
              },
              { type: "compaction", id: "cmp_keep", encrypted_content: "valid-compaction" },
            ],
          }),
        },
      );
      await done;
      expect(requests).toHaveLength(2);
      expect(requests[0]?.input).toEqual(
        expect.arrayContaining([expect.objectContaining({ encrypted_content: "stale-reasoning" })]),
      );
      expect(requests[1]?.input).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "reasoning", id: "rs_replay" }),
          expect.objectContaining({ type: "compaction", encrypted_content: "valid-compaction" }),
        ]),
      );
      expect(JSON.stringify(requests[1]?.input)).not.toContain("stale-reasoning");
      expect(events.map((event) => event.type)).toEqual(["start", "done"]);
      expect(output.stopReason).toBe("stop");
      expect(output.responseId).toBe("resp_recovered");
    },
  );

  it("never retries an encrypted-looking response hook rejection", async () => {
    const onResponse = vi.fn(() => {
      throw new Error("400 The encrypted content could not be verified.");
    });
    const { output, requests, done } = startLifecycle(() => streamResponsesEvents([]), {
      options: { onResponse },
      buildParams: () => ({
        model: nativeOpenAIModel.id,
        stream: true,
        input: [{ type: "reasoning", id: "rs_replay", encrypted_content: "stale", summary: [] }],
      }),
    });
    await done;
    expect(requests).toHaveLength(1);
    expect(onResponse).toHaveBeenCalledOnce();
    expect(output.errorMessage).toBe("400 The encrypted content could not be verified.");
  });

  it("never retries encrypted replay after tool output starts", async () => {
    const { output, requests, events, done } = startLifecycle(
      () =>
        (async function* () {
          yield {
            type: "response.output_item.added",
            output_index: 0,
            sequence_number: 0,
            item: toolItem("started", "", "lookup"),
          } as ResponseStreamEvent;
          throw new Error("400 The encrypted content could not be verified.");
        })(),
      {
        buildParams: () => ({
          model: nativeOpenAIModel.id,
          stream: true,
          input: [{ type: "reasoning", id: "rs_replay", encrypted_content: "stale", summary: [] }],
        }),
      },
    );
    await done;
    expect(requests).toHaveLength(1);
    expect(output.content).toHaveLength(1);
    expect(output.stopReason).toBe("error");
    expect(events[0]?.type).toBe("start");
    expect(events.at(-1)?.type).toBe("error");
  });

  it("suppresses rejected persisted compaction state on the following turn", async () => {
    const replayIdentity = { sessionId: "session-a", authProfileId: "profile-a" };
    const prior = createAssistantOutput();
    captureOpenAIResponsesCompaction(
      prior,
      {
        type: "compaction",
        id: "cmp_rejected",
        encrypted_content: "opaque-rejected-compaction",
      },
      0,
      nativeOpenAIModel,
      buildOpenAIResponsesReasoningReplayMetadata(nativeOpenAIModel, replayIdentity),
    );
    const context: Context = {
      messages: [
        { role: "user", content: "full history prefix", timestamp: 0 },
        prior,
        { role: "user", content: "recover", timestamp: 1 },
      ],
    };
    const onPayload = vi.fn((request: unknown) => request);
    const onCompactionRejected = vi.fn();
    const { output, requests, done } = startLifecycle(
      (attempt) => {
        if (attempt === 1) {
          throw Object.assign(new Error("invalid_encrypted_content"), {
            code: "invalid_encrypted_content",
            status: 400,
          });
        }
        return streamResponsesEvents([
          {
            type: "response.completed",
            sequence_number: 1,
            response: { id: "resp_recovered", status: "completed", output: [] },
          } as unknown as ResponseStreamEvent,
        ]);
      },
      {
        options: { ...replayIdentity, onCompactionRejected, onPayload },
        buildParams: (_model, replayMode) => ({
          model: nativeOpenAIModel.id,
          input: convertResponsesMessages(
            nativeOpenAIModel,
            context,
            testAllowedToolCallProviders,
            {
              ...replayIdentity,
              replayMode,
            },
          ),
          stream: true,
        }),
      },
    );

    await done;
    expect(requests).toHaveLength(2);
    expect(requests[0]?.input).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "compaction", id: "cmp_rejected" })]),
    );
    expect(JSON.stringify(requests[0]?.input)).not.toContain("full history prefix");
    const retryInput = requests[1]?.input;
    expect(Array.isArray(retryInput)).toBe(true);
    const retryItems = Array.isArray(retryInput) ? retryInput : [];
    expect(retryItems.some((item) => item.type === "compaction")).toBe(false);
    expect(JSON.stringify(retryInput)).toContain("full history prefix");
    expect(onPayload).toHaveBeenCalledTimes(2);
    expect(onCompactionRejected).toHaveBeenCalledOnce();
    expect(output.stopReason).toBe("stop");
    expect(output.providerReplay).toMatchObject({
      type: "openai-responses-compaction-suppression",
      data: "rejected",
      provider: nativeOpenAIModel.provider,
      api: nativeOpenAIModel.api,
      model: nativeOpenAIModel.id,
    });

    const nextInput = convertResponsesMessages(
      nativeOpenAIModel,
      {
        messages: [
          ...context.messages,
          output,
          { role: "user", content: "next turn", timestamp: 2 },
        ],
      },
      testAllowedToolCallProviders,
      replayIdentity,
    );
    expect(nextInput.some((item) => item.type === "compaction")).toBe(false);
  });

  it("keeps interleaved reasoning items bound to their output indices", async () => {
    const { output, events } = await collectResponses([
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "reasoning", id: "rs_first", summary: [] },
      },
      {
        type: "response.output_item.added",
        output_index: 1,
        item: { type: "reasoning", id: "rs_second", summary: [] },
      },
      { type: "response.reasoning_text.delta", output_index: 0, delta: "first" },
      { type: "response.reasoning_text.delta", output_index: 1, delta: "second" },
      {
        type: "response.output_item.done",
        output_index: 1,
        item: {
          type: "reasoning",
          id: "rs_second",
          summary: [],
          content: [{ type: "reasoning_text", text: "second" }],
          encrypted_content: "cipher-second",
        },
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "reasoning",
          id: "rs_first",
          summary: [],
          content: [{ type: "reasoning_text", text: "first" }],
          encrypted_content: "cipher-first",
        },
      },
      completed("resp_reasoning"),
    ]);

    expect(output.content).toMatchObject([
      { type: "thinking", thinking: "first" },
      { type: "thinking", thinking: "second" },
    ]);
    const signatures = output.content.map((block) =>
      block.type === "thinking" && block.thinkingSignature
        ? JSON.parse(block.thinkingSignature)
        : undefined,
    );
    expect(signatures).toMatchObject([
      { id: "rs_first", encrypted_content: "cipher-first" },
      { id: "rs_second", encrypted_content: "cipher-second" },
    ]);
    expect(
      events.map((event) => [event.type, "contentIndex" in event ? event.contentIndex : undefined]),
    ).toEqual([
      ["thinking_start", 0],
      ["thinking_start", 1],
      ["thinking_delta", 0],
      ["thinking_delta", 1],
      ["thinking_end", 1],
      ["thinking_end", 0],
    ]);
  });

  it("keeps deferred text before an interleaved output item", async () => {
    const { output, events } = await collectResponses([
      {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          type: "message",
          id: "msg_first",
          content: [{ type: "output_text", text: "" }],
        },
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: {
          type: "message",
          id: "msg_first",
          content: [{ type: "output_text", text: "first" }],
        },
      },
      {
        type: "response.output_item.added",
        output_index: 1,
        item: {
          type: "message",
          id: "msg_second",
          content: [{ type: "output_text", text: "" }],
        },
      },
      { type: "response.output_text.delta", output_index: 1, delta: "first extended" },
      {
        type: "response.output_item.added",
        output_index: 2,
        item: { type: "reasoning", id: "rs_after", summary: [] },
      },
      {
        type: "response.output_item.done",
        output_index: 2,
        item: {
          type: "reasoning",
          id: "rs_after",
          summary: [],
          content: [{ type: "reasoning_text", text: "thought" }],
        },
      },
      {
        type: "response.output_item.done",
        output_index: 1,
        item: {
          type: "message",
          id: "msg_second",
          content: [{ type: "output_text", text: "first extended" }],
        },
      },
      completed("resp_order"),
    ]);

    expect(output.content).toMatchObject([
      { type: "text", text: "first" },
      { type: "text", text: "first extended" },
      { type: "thinking", thinking: "thought" },
    ]);
    expect(
      events
        .filter((event) => event.type.endsWith("_start"))
        .map((event) => [event.type, "contentIndex" in event ? event.contentIndex : undefined]),
    ).toEqual([
      ["text_start", 0],
      ["text_start", 1],
      ["thinking_start", 2],
    ]);
  });

  it("finalizes incomplete usage and derives an omitted token total", async () => {
    const { output } = await collectResponses([
      {
        type: "response.incomplete",
        response: {
          id: "resp_incomplete",
          status: "incomplete",
          usage: {
            input_tokens: 30,
            output_tokens: 12,
            input_tokens_details: { cached_tokens: 5, cache_write_tokens: 3 },
          },
        },
      },
    ]);

    expect(output.stopReason).toBe("length");
    expect(output.usage).toMatchObject({
      input: 22,
      output: 12,
      cacheRead: 5,
      cacheWrite: 3,
      totalTokens: 42,
    });
  });

  it("preserves failed terminal response details and accounting", async () => {
    const model = {
      ...nativeOpenAIModel,
      cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 6.25 },
    } satisfies Model<"openai-responses">;
    const output = createAssistantOutput();
    const resolveServiceTier = vi.fn(
      (
        responseTier: ResponseCreateParamsStreaming["service_tier"],
        requestTier: ResponseCreateParamsStreaming["service_tier"],
      ) => responseTier ?? requestTier,
    );
    const applyServiceTierPricing = vi.fn(
      (usage: AssistantMessage["usage"], tier: ResponseCreateParamsStreaming["service_tier"]) => {
        if (tier === "priority") {
          usage.cost.total *= 2;
        }
      },
    );

    await expect(
      processResponsesStream(
        streamResponsesEvents([
          {
            type: "response.failed",
            response: {
              id: "resp_failed",
              status: "failed",
              model: "gpt-5.6-luna",
              service_tier: "priority",
              error: { code: "server_error", message: "provider failed" },
              usage: {
                input_tokens: 21,
                output_tokens: 4,
                total_tokens: 25,
                input_tokens_details: { cached_tokens: 6, cache_write_tokens: 2 },
                output_tokens_details: { reasoning_tokens: 3 },
              },
            },
          },
        ]),
        output,
        new AssistantMessageEventStream(),
        model,
        { serviceTier: "default", resolveServiceTier, applyServiceTierPricing },
      ),
    ).rejects.toThrow("server_error: provider failed");

    expect(output).toMatchObject({
      responseId: "resp_failed",
      responseModel: "gpt-5.6-luna",
      stopReason: "stop",
      usage: {
        input: 13,
        output: 4,
        cacheRead: 6,
        cacheWrite: 2,
        reasoningTokens: 3,
        totalTokens: 25,
      },
    });
    expect(output.usage.cost.input).toBeCloseTo(0.000065, 10);
    expect(output.usage.cost.output).toBeCloseTo(0.00012, 10);
    expect(output.usage.cost.cacheRead).toBeCloseTo(0.000003, 10);
    expect(output.usage.cost.cacheWrite).toBeCloseTo(0.0000125, 10);
    expect(output.usage.cost.total).toBeCloseTo(0.000401, 10);
    expect(resolveServiceTier).toHaveBeenCalledWith("priority", "default");
    expect(applyServiceTierPricing).toHaveBeenCalledWith(output.usage, "priority");
  });

  it("preserves cancellation when the SDK swallows the abort and ends iteration", async () => {
    const abort = new AbortController();
    const output = createAssistantOutput();
    async function* silentlyAbortedStream() {
      yield { type: "response.created", response: { id: "resp_aborted" } };
      abort.abort();
    }

    await expect(
      processResponsesStream(
        silentlyAbortedStream(),
        output,
        new AssistantMessageEventStream(),
        nativeOpenAIModel,
        { signal: abort.signal },
      ),
    ).rejects.toThrow("Request was aborted");
    expect(output.responseId).toBe("resp_aborted");
  });

  it.each([
    ["omits arguments", undefined],
    ["sends empty arguments", ""],
  ])("preserves streamed tool-call arguments when done %s", async (_label, doneArguments) => {
    const output = createAssistantOutput();
    const stream = new AssistantMessageEventStream();
    const events: Array<Record<string, unknown>> = [];
    const collect = (async () => {
      for await (const event of stream) {
        events.push(event as unknown as Record<string, unknown>);
      }
    })();

    await processResponsesStream(
      streamResponsesEvents([
        itemEvent("added", toolItem("read", "", "read")),
        argumentsDelta('{"path":"docs/gateway/local-models.md"}'),
        {
          type: "response.function_call_arguments.done",
          ...(doneArguments === undefined ? {} : { arguments: doneArguments }),
          item_id: "fc_read",
          name: "read",
          output_index: 0,
          sequence_number: 3,
        },
        {
          type: "response.output_item.done",
          item: {
            type: "function_call",
            id: "fc_read",
            call_id: "call_read",
            name: "read",
          },
        },
        completed("resp_1"),
      ]),
      output,
      stream,
      nativeOpenAIModel,
    );
    stream.end();
    await collect;

    expect(output.stopReason).toBe("toolUse");
    expect(output.content).toEqual([
      {
        type: "toolCall",
        id: "call_read|fc_read",
        name: "read",
        arguments: { path: "docs/gateway/local-models.md" },
      },
    ]);
    expect(events.map((event) => event.type)).toEqual([
      "toolcall_start",
      "toolcall_delta",
      "toolcall_end",
    ]);
  });

  it("keeps idless tool-call ids stable within a response and unique across responses", async () => {
    const runOnce = async () => {
      const output = createAssistantOutput();
      const { stream, events } = createCapturedAssistantMessageEventStream();
      await processResponsesStream(
        streamResponsesEvents([
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { type: "function_call", name: "computer", arguments: "" },
          },
          {
            type: "response.output_item.done",
            output_index: 0,
            item: { type: "function_call", name: "computer", arguments: "{}" },
          },
          completed("resp_idless"),
        ]),
        output,
        stream,
        nativeOpenAIModel,
      );
      const block = output.content.find((entry) => entry.type === "toolCall");
      const end = events.find((event) => event.type === "toolcall_end");
      if (!block || block.type !== "toolCall" || !end || end.type !== "toolcall_end") {
        throw new Error("missing tool-call lifecycle");
      }
      return { blockId: block.id, endId: end.toolCall.id };
    };

    const first = await runOnce();
    const second = await runOnce();
    expect(first.blockId).toMatch(/^call_[0-9a-f]{24}$/);
    expect(first.endId).toBe(first.blockId);
    expect(second.endId).toBe(second.blockId);
    expect(second.blockId).not.toBe(first.blockId);
  });

  it("adopts the completed SDK item id while preserving lifecycle and result linkage", async () => {
    const responseStream: ResponseStreamEvent[] = [
      {
        type: "response.output_item.added",
        output_index: 0,
        sequence_number: 1,
        item: {
          type: "function_call",
          call_id: "call_weather",
          name: "weather",
          arguments: "",
          status: "in_progress",
        },
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        sequence_number: 2,
        item: {
          type: "function_call",
          id: "fc_weather",
          call_id: "call_weather",
          name: "weather",
          arguments: '{"city":"Seattle"}',
          status: "completed",
        },
      },
      {
        type: "response.completed",
        sequence_number: 3,
        response: { id: "resp_weather", status: "completed" },
      } as ResponseStreamEvent,
    ];
    const output = createAssistantOutput();
    const { stream, events } = createCapturedAssistantMessageEventStream();
    let startedId: string | undefined;
    const capturePush = stream.push.bind(stream);
    stream.push = (event) => {
      if (event.type === "toolcall_start") {
        const block = event.partial.content[event.contentIndex];
        startedId = block?.type === "toolCall" ? block.id : undefined;
      }
      capturePush(event);
    };

    await processResponsesStream(
      streamResponsesEvents(responseStream),
      output,
      stream,
      nativeOpenAIModel,
    );

    expect(startedId).toBe("call_weather");
    expect(output.content).toEqual([
      {
        type: "toolCall",
        id: "call_weather|fc_weather",
        name: "weather",
        arguments: { city: "Seattle" },
      },
    ]);
    expect(
      events.map((event) => [event.type, "contentIndex" in event ? event.contentIndex : undefined]),
    ).toEqual([
      ["toolcall_start", 0],
      ["toolcall_end", 0],
    ]);

    const replay = convertResponsesMessages(
      nativeOpenAIModel,
      {
        systemPrompt: "",
        messages: [
          output,
          makeTextToolResult("call_weather|fc_weather", "weather", "Rain", false, 1),
        ],
      } satisfies Context,
      testAllowedToolCallProviders,
      { includeSystemPrompt: false },
    ) as unknown as Array<Record<string, unknown>>;
    expect(replay).toContainEqual({
      type: "function_call",
      id: "fc_weather",
      call_id: "call_weather",
      name: "weather",
      arguments: '{"city":"Seattle"}',
    });
    expect(replay).toContainEqual({
      type: "function_call_output",
      call_id: "call_weather",
      output: "Rain",
    });
  });

  it("rejects reuse of an active Responses tool-call output index", async () => {
    const output = createAssistantOutput();
    const { stream, events } = createCapturedAssistantMessageEventStream();

    await expect(
      processResponsesStream(
        streamResponsesEvents([
          itemEvent("added", toolItem("first_index_owner", ""), 0),
          itemEvent("added", toolItem("second_index_owner", ""), 0),
        ]),
        output,
        stream,
        nativeOpenAIModel,
      ),
    ).rejects.toThrow("Responses stream reused active tool-call output index 0");
    expect(events.filter((event) => event.type === "toolcall_start")).toHaveLength(1);
    expect(events.filter((event) => event.type === "toolcall_end")).toHaveLength(0);
  });

  it("routes indexed Responses tool arguments when item ids rotate", async () => {
    const output = createResponsesAssistantOutput(gpt56SolModel);
    const { stream, events } = createCapturedAssistantMessageEventStream();

    await processResponsesStream(
      streamResponsesEvents([
        itemEvent("added", toolItem("read", "", "read"), 0),
        argumentsDelta('{"path":', 0, "encrypted_delta_1"),
        argumentsDelta('"README.md"}', 0, "encrypted_delta_2"),
        {
          type: "response.function_call_arguments.done",
          output_index: 0,
          item_id: "encrypted_done",
          arguments: '{"path":"README.md"}',
        },
        itemEvent("done", toolItem("read", "", "read"), 0),
        completed("resp_read"),
      ]),
      output,
      stream,
      gpt56SolModel,
    );

    expect(output.content).toEqual([
      {
        type: "toolCall",
        id: "call_read|fc_read",
        name: "read",
        arguments: { path: "README.md" },
      },
    ]);
    expect(events.map((event) => event.type)).toEqual([
      "toolcall_start",
      "toolcall_delta",
      "toolcall_delta",
      "toolcall_end",
    ]);
  });

  it("rejects indexed Responses completions when call ids change", async () => {
    const output = createAssistantOutput();
    const { stream, events } = createCapturedAssistantMessageEventStream();

    await expect(
      processResponsesStream(
        streamResponsesEvents([
          {
            type: "response.output_item.added",
            output_index: 0,
            item: {
              type: "function_call",
              id: "fc_read",
              call_id: "call_read_a",
              name: "read",
              arguments: "",
            },
          },
          argumentsDelta('{"path":"README.md"}', 0, "encrypted_delta"),
          {
            type: "response.output_item.done",
            output_index: 0,
            item: {
              type: "function_call",
              id: "fc_read_done",
              call_id: "call_read_b",
              name: "read",
              arguments: '{"path":"README.md"}',
            },
          },
          completed("resp_read"),
        ]),
        output,
        stream,
        nativeOpenAIModel,
      ),
    ).rejects.toThrow("Responses stream changed output item identity");
    expect(events.map((event) => event.type)).toEqual(["toolcall_start", "toolcall_delta"]);
  });

  it("keeps parallel unindexed Responses calls bound by identity without orphans", async () => {
    const output = createAssistantOutput();
    const { stream, events } = createCapturedAssistantMessageEventStream();
    const firstItem = {
      type: "function_call",
      id: "fc_first_unindexed",
      call_id: "call_first_unindexed",
      name: "computer",
      arguments: '{"slot":1}',
      status: "completed",
    };
    const secondItem = {
      type: "function_call",
      id: "fc_second_unindexed",
      call_id: "call_second_unindexed",
      name: "computer",
      arguments: '{"slot":2}',
      status: "completed",
    };

    await processResponsesStream(
      streamResponsesEvents([
        {
          type: "response.output_item.added",
          item: { ...firstItem, arguments: "", status: "in_progress" },
        },
        {
          type: "response.output_item.added",
          item: { ...secondItem, arguments: "", status: "in_progress" },
        },
        argumentsDelta(secondItem.arguments, undefined, secondItem.id),
        argumentsDelta(firstItem.arguments, undefined, firstItem.id),
        {
          type: "response.function_call_arguments.done",
          item_id: firstItem.id,
          arguments: firstItem.arguments,
        },
        {
          type: "response.function_call_arguments.done",
          item_id: secondItem.id,
          arguments: secondItem.arguments,
        },
        { type: "response.output_item.done", item: firstItem },
        { type: "response.output_item.done", item: secondItem },
        {
          type: "response.completed",
          response: {
            id: "resp_parallel_unindexed",
            status: "completed",
            output: [firstItem, secondItem],
          },
        },
      ]),
      output,
      stream,
      nativeOpenAIModel,
    );

    expect(output.content).toEqual([
      {
        type: "toolCall",
        id: "call_first_unindexed|fc_first_unindexed",
        name: "computer",
        arguments: { slot: 1 },
      },
      {
        type: "toolCall",
        id: "call_second_unindexed|fc_second_unindexed",
        name: "computer",
        arguments: { slot: 2 },
      },
    ]);
    expect(
      events
        .filter((event) => event.type === "toolcall_end")
        .map((event) =>
          event.type === "toolcall_end"
            ? [event.contentIndex, event.toolCall.id, event.toolCall.arguments]
            : undefined,
        ),
    ).toEqual([
      [0, "call_first_unindexed|fc_first_unindexed", { slot: 1 }],
      [1, "call_second_unindexed|fc_second_unindexed", { slot: 2 }],
    ]);
    expect(events.filter((event) => event.type === "toolcall_start")).toHaveLength(2);
  });

  it("fails closed on ambiguous unindexed parallel argument events", async () => {
    const output = createAssistantOutput();
    const { stream, events } = createCapturedAssistantMessageEventStream();
    const firstItem = {
      type: "function_call",
      id: "fc_ambiguous_first",
      call_id: "call_ambiguous_first",
      name: "computer",
    };
    const secondItem = {
      type: "function_call",
      id: "fc_ambiguous_second",
      call_id: "call_ambiguous_second",
      name: "computer",
    };

    await expect(
      processResponsesStream(
        streamResponsesEvents([
          { type: "response.output_item.added", item: { ...firstItem, arguments: "" } },
          { type: "response.output_item.added", item: { ...secondItem, arguments: "" } },
          { type: "response.function_call_arguments.delta", delta: '{"slot":1}' },
          { type: "response.output_item.done", item: firstItem },
          { type: "response.output_item.done", item: secondItem },
          completed("resp_ambiguous_unindexed"),
        ]),
        output,
        stream,
        nativeOpenAIModel,
      ),
    ).rejects.toThrow("Responses stream completed with unresolved tool calls");
    expect(events.filter((event) => event.type === "toolcall_start")).toHaveLength(2);
    expect(events.filter((event) => event.type === "toolcall_end")).toHaveLength(0);
  });

  it("recovers parallel arguments from authoritative done events and preserves opening names", async () => {
    const output = createAssistantOutput();
    const { stream, events } = createCapturedAssistantMessageEventStream();
    await processResponsesStream(
      streamResponsesEvents(createResponsesDoneArgumentEvents()),
      output,
      stream,
      nativeOpenAIModel,
    );

    expect(output.content).toEqual([
      {
        type: "toolCall",
        id: "call_recovered_first|fc_recovered_first",
        name: "read",
        arguments: { path: "README.md" },
      },
      {
        type: "toolCall",
        id: "call_recovered_second|fc_recovered_second",
        name: "write",
        arguments: { path: "README.md", text: "ok" },
      },
    ]);
    expect(events.filter((event) => event.type === "toolcall_end")).toHaveLength(2);
  });

  it("rejects a completed Responses tool call whose function name changed", async () => {
    const output = createAssistantOutput();

    await expect(
      processResponsesStream(
        streamResponsesEvents([
          itemEvent("added", toolItem("name_conflict", "", "read"), 0),
          itemEvent("done", toolItem("name_conflict", "{}", "write"), 0),
        ]),
        output,
        new AssistantMessageEventStream(),
        nativeOpenAIModel,
      ),
    ).rejects.toThrow("Responses stream changed tool-call function name from read to write");
  });

  it("routes omitted-index parallel arguments and completions without duplicates", async () => {
    const { output, events } = await collectResponses([
      itemEvent("added", toolItem("first", ""), 0),
      itemEvent("added", toolItem("second", ""), 1),
      argumentsDelta('{"slot":', 0, "fc_first"),
      argumentsDelta("0}", undefined, "fc_first"),
      argumentsDelta('{"slot":', 1),
      itemEvent("done", toolItem("second", '{"slot":1}')),
      itemEvent("done", toolItem("first", '{"slot":0}')),
      completed("resp_suffix"),
    ]);

    expect(output.content).toMatchObject([
      { type: "toolCall", id: "call_first|fc_first", arguments: { slot: 0 } },
      { type: "toolCall", id: "call_second|fc_second", arguments: { slot: 1 } },
    ]);
    expect(
      events
        .filter((event) => event.type === "toolcall_delta")
        .map((event) => ("contentIndex" in event ? event.contentIndex : undefined)),
    ).toEqual([0, 0, 1]);
    expect(events.filter((event) => event.type === "toolcall_start")).toHaveLength(2);
    expect(events.filter((event) => event.type === "toolcall_end")).toHaveLength(2);
  });

  it("rejects omitted-index events whose identity mismatches the sole indexed call", async () => {
    const { output, events } = await collectResponses([
      itemEvent("added", toolItem("first", ""), 0),
      argumentsDelta('{"wrong":true}', undefined, "fc_other"),
      itemEvent("done", toolItem("other", '{"wrong":true}')),
      itemEvent("done", toolItem("first", '{"slot":0}')),
      completed("resp_identity_mismatch"),
    ]);

    expect(output.content).toMatchObject([
      { type: "toolCall", id: "call_first|fc_first", arguments: { slot: 0 } },
    ]);
    expect(events.filter((event) => event.type === "toolcall_start")).toHaveLength(1);
    expect(events.filter((event) => event.type === "toolcall_delta")).toHaveLength(0);
    expect(events.filter((event) => event.type === "toolcall_end")).toHaveLength(1);
  });

  it("keeps sequential omitted-index Responses calls unambiguous", async () => {
    const { output, events } = await collectResponses([
      itemEvent("added", toolItem("first", ""), 7),
      { type: "response.function_call_arguments.delta", delta: '{"slot":0}' },
      itemEvent("done", toolItem("first", '{"slot":0}')),
      itemEvent("added", toolItem("second", ""), 8),
      { type: "response.function_call_arguments.delta", delta: '{"slot":1}' },
      itemEvent("done", toolItem("second", '{"slot":1}')),
      completed("resp_sequential"),
    ]);

    expect(output.content).toMatchObject([
      { type: "toolCall", id: "call_first|fc_first", arguments: { slot: 0 } },
      { type: "toolCall", id: "call_second|fc_second", arguments: { slot: 1 } },
    ]);
    expect(
      events
        .filter((event) => event.type === "toolcall_delta")
        .map((event) => ("contentIndex" in event ? event.contentIndex : undefined)),
    ).toEqual([0, 1]);
  });

  it("pairs an item-only tool call with one generated call id", async () => {
    const { output, events } = await collectResponses([
      {
        type: "response.output_item.done",
        output_index: 0,
        sequence_number: 1,
        item: {
          type: "function_call",
          id: "fc_item_only",
          name: "computer",
          arguments: "{}",
          status: "completed",
        },
      },
      completed("resp_item_only"),
    ]);

    const block = output.content[0];
    const end = events.find((event) => event.type === "toolcall_end");
    if (!block || block.type !== "toolCall" || !end || end.type !== "toolcall_end") {
      throw new Error("missing item-only tool-call lifecycle");
    }
    expect(block.id).toMatch(/^call_[0-9a-f]{24}\|fc_item_only$/);
    expect(end.toolCall.id).toBe(block.id);
  });
});

describe("Azure OpenAI Responses content type support", () => {
  const azureModel = {
    ...nativeOpenAIModel,
    api: "azure-openai-responses",
    provider: "azure",
    baseUrl: "https://test.openai.azure.com/openai/v1",
  } satisfies Model<"azure-openai-responses">;

  it.each([
    { name: "explicit text part", deltaType: "response.output_text.delta", explicitPart: true },
    { name: "implicit text part", deltaType: "response.text.delta", explicitPart: false },
  ])("streams Azure $name", async ({ deltaType, explicitPart }) => {
    const { stream, events } = createCapturedAssistantMessageEventStream();
    const output = createResponsesAssistantOutput(azureModel, azureModel.api);
    const liveTextSignatures: Array<string | undefined> = [];
    const push = stream.push.bind(stream);
    stream.push = (event) => {
      if (event.type === "text_start" || event.type === "text_delta") {
        const block = event.partial?.content[event.contentIndex];
        liveTextSignatures.push(block?.type === "text" ? block.textSignature : undefined);
      }
      push(event);
    };
    const item = { type: "message", role: "assistant", id: "msg_azure", content: [] };
    await processResponsesStream(
      streamResponsesEvents([
        itemEvent("added", { ...item, status: "in_progress" }, 0),
        ...(explicitPart
          ? [
              {
                type: "response.content_part.added",
                output_index: 0,
                part: { type: "text", text: "" },
              },
            ]
          : []),
        { type: deltaType, delta: "Hello", ...(explicitPart ? { output_index: 0 } : {}) },
        { type: deltaType, delta: " from Azure!", ...(explicitPart ? { output_index: 0 } : {}) },
        itemEvent(
          "done",
          {
            ...item,
            status: "completed",
            content: [{ type: "text", text: "Hello from Azure!" }],
          },
          0,
        ),
        {
          type: "response.completed",
          response: {
            id: "resp_azure",
            status: "completed",
            model: azureModel.id,
            output: [],
            usage: {
              input_tokens: 10,
              output_tokens: 5,
              total_tokens: 15,
              input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
              output_tokens_details: { reasoning_tokens: 0 },
            },
          },
        },
      ]),
      output,
      stream,
      azureModel,
    );
    expect(
      events.map((event) =>
        event.type === "text_delta"
          ? event.delta
          : event.type === "text_end"
            ? `[END:${event.content}]`
            : event.type,
      ),
    ).toEqual(["text_start", "Hello", " from Azure!", "[END:Hello from Azure!]"]);
    expect(output.content).toMatchObject([{ type: "text", text: "Hello from Azure!" }]);
    expect(output.usage).toMatchObject({ input: 10, output: 5, totalTokens: 15 });
    expect(output.stopReason).toBe("stop");
    expect(liveTextSignatures).toEqual([undefined, undefined, undefined]);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
