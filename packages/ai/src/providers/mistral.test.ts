import {
  contentChunkFromJSON,
  toolCallFromJSON,
  type ChatCompletionStreamRequest,
} from "@mistralai/mistralai/models/components";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { configureAiTransportHost } from "../host.js";
import { createAssistantOutput } from "../transports/assistant-output.js";
import { withProviderAcceptanceObserver } from "../transports/transport-stream-shared.js";
import type { Context } from "../types.js";
import { onLlmRequestActivity } from "../utils/llm-request-activity.js";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "../utils/system-prompt-cache-boundary.js";

const mistralMockState = vi.hoisted(() => ({
  payloads: [] as unknown[],
  requestOptions: [] as unknown[],
  nextUUID: 429244,
  requestThroughHttpClient: false,
  streamResult: undefined as unknown,
}));

vi.mock("node:crypto", async () => {
  const actual = await vi.importActual<typeof import("node:crypto")>("node:crypto");
  return {
    ...actual,
    randomUUID: () =>
      `00000000-0000-4000-8000-${String(mistralMockState.nextUUID++).padStart(12, "0")}`,
  };
});

vi.mock("@mistralai/mistralai/sdk/chat", () => {
  return {
    Chat: class MockMistralChat {
      constructor(
        private readonly config: { httpClient?: { request(request: Request): Promise<Response> } },
      ) {}

      stream = vi.fn(async (payload: unknown, requestOptions: unknown) => {
        mistralMockState.payloads.push(payload);
        mistralMockState.requestOptions.push(requestOptions);
        if (mistralMockState.requestThroughHttpClient) {
          const response = await this.config.httpClient?.request(
            new Request("https://api.mistral.ai/chat"),
          );
          if (response && !response.ok) {
            throw Object.assign(new Error(`Mistral HTTP ${response.status}`), {
              statusCode: response.status,
            });
          }
        }
        if (mistralMockState.streamResult !== undefined) {
          return mistralMockState.streamResult;
        }
        throw new Error("stop before network");
      });
    },
  };
});

import { streamMistral, streamSimpleMistral } from "./mistral.js";
import { makeProviderModel } from "./provider-model.test-support.js";

const makeMistralModel = () =>
  makeProviderModel("mistral-conversations", "mistral", "mistral-large-latest", {
    name: "Mistral Large",
    baseUrl: "https://api.mistral.ai",
    reasoning: false,
  });

const context = { messages: [{ role: "user", content: "hello", timestamp: 0 }] } satisfies Context;

function makeUnreadableParameterTool() {
  return {
    name: "broken_tool",
    description: "broken tool",
    get parameters(): never {
      throw new Error("fuzzplugin parameters getter exploded");
    },
  };
}

function makeHealthyTool(parameters: Record<string, unknown> = { type: "object", properties: {} }) {
  return {
    name: "healthy_tool",
    description: "healthy tool",
    parameters,
  };
}

function parseMistralToolCall(value: unknown) {
  const parsed = toolCallFromJSON(JSON.stringify(value));
  assert(parsed.ok, "Mistral SDK failed to parse tool-call fixture");
  return parsed.value;
}

async function* mistralEvents<T>(events: T[]) {
  yield* events;
}

function mistralEvent(content: unknown, extra: Record<string, unknown> = {}) {
  return {
    data: {
      id: "response-fixture",
      model: "mistral-large-latest",
      choices: [{ finishReason: "stop", delta: { content } }],
      ...extra,
    },
  };
}

function wireTool(
  name: string,
  args: string,
  identity: { id?: string; index?: number; type?: "function" } = {},
) {
  return { ...identity, function: { name, arguments: args } };
}

function mistralToolStream(
  responseId: string,
  ...chunks: ReturnType<typeof parseMistralToolCall>[][]
) {
  return mistralEvents(
    chunks.map((toolCalls) =>
      mistralEvent(null, {
        id: responseId,
        choices: [{ finishReason: "tool_calls", delta: { content: null, toolCalls } }],
      }),
    ),
  );
}

type MistralTestOptions = NonNullable<Parameters<typeof streamMistral>[2]>;
type SimpleMistralTestOptions = NonNullable<Parameters<typeof streamSimpleMistral>[2]>;
const payload = () => mistralMockState.payloads[0] as ChatCompletionStreamRequest;
const toolMessage = () => payload().messages.find((message) => message.role === "tool");

function runner(stream: typeof streamMistral | typeof streamSimpleMistral) {
  return (
    testContext: Context = context,
    options: MistralTestOptions & SimpleMistralTestOptions = {},
    testModel = makeMistralModel(),
  ) => stream(testModel, testContext, { apiKey: "sk-mistral-provider", ...options }).result();
}
const runMistralFixture = runner(streamMistral);
const runSimpleMistralFixture = runner(streamSimpleMistral);

async function runMistralToolFixture(responseId: string, rawChunks: unknown[][]) {
  const parsedChunks = rawChunks.map((chunk) => chunk.map(parseMistralToolCall));
  mistralMockState.streamResult = mistralToolStream(responseId, ...parsedChunks);
  const result = await runMistralFixture();
  return { result, toolCalls: result.content.filter((block) => block.type === "toolCall") };
}

function makeMistralToolResultContext(
  toolName: string,
  content: unknown[],
  options: { toolCallId?: string; includeUser?: boolean; includeToolResultName?: boolean } = {},
): Context {
  const toolCallId = options.toolCallId ?? "tool_1";
  return {
    messages: [
      ...(options.includeUser === false ? [] : [{ role: "user", content: "hello", timestamp: 1 }]),
      {
        ...createAssistantOutput(makeMistralModel()),
        stopReason: "toolUse",
        timestamp: 0,
        content: [{ type: "toolCall", id: toolCallId, name: toolName, arguments: {} }],
      },
      {
        role: "toolResult",
        toolCallId,
        ...(options.includeToolResultName ? { toolName } : {}),
        content,
        isError: false,
        timestamp: 0,
      },
    ],
  } as unknown as Context;
}

describe("Mistral provider", () => {
  it("exposes cumulative tool input before the provider completes the call", async ({
    onTestFinished,
  }) => {
    const gates = [createDeferred(), createDeferred()];
    onTestFinished(() => gates.forEach((gate) => gate.resolve()));
    const chunks = ['{"content":"line', ' end"}'].map((args) => [
      parseMistralToolCall(wireTool("write", args, { id: "progress", type: "function" })),
    ]);
    const source = mistralToolStream("progress", ...chunks);
    mistralMockState.streamResult = {
      async *[Symbol.asyncIterator]() {
        let index = 0;
        for await (const event of source) {
          yield event;
          await gates[index++]?.promise;
        }
      },
    };
    const stream = streamMistral(makeMistralModel(), context, { apiKey: crypto.randomUUID() });
    const inputs: unknown[] = [];
    try {
      for await (const event of stream) {
        if (event.type === "toolcall_delta") {
          inputs.push(structuredClone(event.partial.content[event.contentIndex]));
          gates[inputs.length - 1]?.resolve();
        }
      }
    } finally {
      gates.forEach((gate) => gate.resolve());
    }
    expect(inputs).toMatchObject([
      { partialJson: '{"content":"line' },
      { partialJson: '{"content":"line end"}' },
    ]);
    expect((await stream.result()).content[0]).not.toHaveProperty("partialJson");
  });

  beforeEach(() => {
    mistralMockState.payloads = [];
    mistralMockState.requestOptions = [];
    mistralMockState.nextUUID = 429244;
    mistralMockState.requestThroughHttpClient = false;
    mistralMockState.streamResult = undefined;
  });

  afterEach(() => {
    configureAiTransportHost({});
  });

  it("reports every parsed Mistral event as request activity", async () => {
    const events = [
      mistralEvent(null, { id: "resp-activity", choices: [], usage: {} }),
      mistralEvent("ok", { id: "resp-activity" }),
    ];
    mistralMockState.streamResult = mistralEvents(events);
    const controller = new AbortController();
    const onActivity = vi.fn();
    const unsubscribe = onLlmRequestActivity(controller.signal, onActivity);

    try {
      await runMistralFixture(context, { signal: controller.signal });
    } finally {
      unsubscribe();
    }

    expect(onActivity).toHaveBeenCalledTimes(events.length);
  });

  it.each([200, 429])(
    "settles HTTP %i without confusing acceptance and rejection",
    async (status) => {
      mistralMockState.requestThroughHttpClient = true;
      const cancel = vi.fn(async () => undefined);
      mistralMockState.streamResult = Object.assign(mistralEvents([mistralEvent("ok")]), {
        cancel,
      });
      configureAiTransportHost({
        buildModelFetch: () => async () =>
          new Response("stream", {
            status,
            headers: { "x-mistral-request-id": "req-fixture" },
          }),
      });
      const hookError = new Error("acceptance observer failed");
      const accepted = vi.fn(() => {
        throw hookError;
      });
      const onResponse = vi.fn();
      const result = await runSimpleMistralFixture(
        context,
        withProviderAcceptanceObserver({ onResponse }, accepted),
      );
      expect(result.stopReason).toBe("error");
      if (status === 200) {
        expect(result.errorMessage).toBe("acceptance observer failed");
        expect(cancel).toHaveBeenCalledWith(hookError);
      } else {
        expect(result.errorMessage).toBe("429: Mistral HTTP 429");
        expect(accepted).not.toHaveBeenCalled();
        expect(onResponse).toHaveBeenCalledWith(
          {
            status: 429,
            headers: expect.objectContaining({ "x-mistral-request-id": "req-fixture" }),
          },
          expect.objectContaining({ provider: "mistral" }),
        );
      }
    },
  );

  it.each([
    [{ stop: ["STOP"] }, { stop: ["STOP"] }],
    [{ maxTokens: 360 }, { maxTokens: 360 }],
  ])(
    "preserves simple request options %j with an unknown output limit",
    async (options, expected) => {
      const model = makeMistralModel();
      Reflect.deleteProperty(model, "maxTokens");
      await runSimpleMistralFixture(context, options, model);
      expect(payload()).toMatchObject(expected);
    },
  );

  it.each([
    ["mistral-medium-3-5", "minimal", "reasoningEffort", "none", "promptMode"],
    ["mistral-medium-3-5", "high", "reasoningEffort", "high", "promptMode"],
    ["magistral-small", "off", "promptMode", undefined, "reasoningEffort"],
    ["magistral-small", "high", "promptMode", "reasoning", "reasoningEffort"],
  ] as const)(
    "%s maps %s thinking through %s",
    async (modelId, reasoning, key, value, absentKey) => {
      await runSimpleMistralFixture(
        context,
        { reasoning },
        { ...makeMistralModel(), id: modelId, reasoning: true },
      );
      expect(payload()[key]).toBe(value);
      expect(payload()).not.toHaveProperty(absentKey);
    },
  );

  it("keeps request bytes stable across equivalent tool input order", async () => {
    const tools = [
      { ...makeHealthyTool(), name: "zeta_tool", description: "Zeta tool" },
      { ...makeHealthyTool(), name: "alpha_tool", description: "Alpha tool" },
    ];

    await runMistralFixture({ ...context, tools } as never);
    await runMistralFixture({ ...context, tools: tools.toReversed() } as never);

    expect(JSON.stringify(mistralMockState.payloads[0])).toBe(
      JSON.stringify(mistralMockState.payloads[1]),
    );
    expect(payload().tools).toMatchObject([
      { function: { name: "alpha_tool" } },
      { function: { name: "zeta_tool" } },
    ]);
  });

  it("reports unreadable tool parameters beside a usable tool before sending", async () => {
    const tools = [makeUnreadableParameterTool(), makeHealthyTool()];
    const toolChoice = { type: "function" as const, function: { name: "broken_tool" } };
    const result = await runMistralFixture({ ...context, tools: tools as never }, { toolChoice });
    expect(result).toMatchObject({
      stopReason: "error",
      errorMessage: expect.stringContaining("fuzzplugin parameters getter exploded"),
    });
    expect(mistralMockState.payloads).toHaveLength(0);
  });

  it("keeps omitted streamed tool ids stable within a response and unique across responses", async () => {
    const responseIds: string[][] = [];
    for (const responseId of ["response-a", "response-b"]) {
      mistralMockState.streamResult = mistralToolStream(
        responseId,
        [
          wireTool("computer", '{"step"', { index: 0, id: "null" }),
          wireTool("computer", '{"other"', {
            index: 1,
            id: responseId === "response-a" ? "explicitA" : "explicitB",
          }),
        ],
        [wireTool("", ":1}", { index: 0 }), wireTool("", ":true}", { index: 1 })],
      );
      const result = await runMistralFixture();
      const toolCalls = result.content.filter((block) => block.type === "toolCall");
      expect(toolCalls.map((call) => call.arguments)).toEqual([{ step: 1 }, { other: true }]);
      responseIds.push(toolCalls.map((toolCall) => toolCall.id));
    }

    expect(responseIds.flat().every((id) => /^[a-zA-Z0-9]{9}$/.test(id))).toBe(true);
    expect(responseIds[0]?.[1]).toBe("explicitA");
    expect(responseIds[1]?.[1]).toBe("explicitB");
    expect(responseIds[1]?.[0]).not.toBe(responseIds[0]?.[0]);
  });

  const firstCall = (args: string, identity: Parameters<typeof wireTool>[2] = {}) =>
    wireTool("first_tool", args, identity);
  const secondCall = (args: string, identity: Parameters<typeof wireTool>[2] = {}) =>
    wireTool("second_tool", args, identity);
  const identified = [
    firstCall('{"value"', { id: "explicitA" }),
    secondCall('{"value"', { id: "explicitB" }),
  ];
  it.each(["explicit IDs", "asymmetric name"])("routes unindexed siblings by %s", async (mode) => {
    const chunks =
      mode === "explicit IDs"
        ? [identified, [firstCall(":1}"), secondCall(":2}")]]
        : [[firstCall('{"value":1}'), secondCall('{"value"', { index: 1 })], [secondCall(":2}")]];
    const { toolCalls } = await runMistralToolFixture("response-unindexed", chunks);
    expect(toolCalls).toMatchObject([
      { name: "first_tool", arguments: { value: 1 } },
      { name: "second_tool", arguments: { value: 2 } },
    ]);
    if (mode === "explicit IDs") {
      expect(toolCalls.map((call) => call.id)).toEqual(["explicitA", "explicitB"]);
    }
  });

  it.each([
    ["nameless", "first_tool", "second_tool", "", "value"],
    ["same-name", "computer", "computer", "computer", "step"],
  ])("rejects ambiguous %s omitted-index continuation", async (kind, first, second, name, key) => {
    const { result, toolCalls } = await runMistralToolFixture(`response-${kind}-unindexed`, [
      [wireTool(first, `{"${key}"`), wireTool(second, `{"${key}"`)],
      [wireTool(name, ":2}")],
    ]);
    if (kind === "same-name") {
      expect(toolCalls).toHaveLength(0);
    }
    expect(result).toMatchObject({
      stopReason: "error",
      errorMessage: expect.stringContaining("tool-call continuation is ambiguous"),
    });
  });

  it("keeps a later same-name call distinct when it has a nonzero index", async () => {
    const calls = [1, 2].map((step, index) =>
      parseMistralToolCall(wireTool("computer", JSON.stringify({ step }), { index })),
    );
    mistralMockState.streamResult = {
      async *[Symbol.asyncIterator]() {
        for (const [id, toolCall] of calls.entries()) {
          yield* mistralToolStream(`response-same-name-indexed-${id}`, [toolCall]);
        }
      },
    };

    const result = await runMistralFixture();
    const toolCalls = result.content.filter((block) => block.type === "toolCall");

    expect(toolCalls).toMatchObject([
      { name: "computer", arguments: { step: 1 } },
      { name: "computer", arguments: { step: 2 } },
    ]);
    expect(new Set(toolCalls.map((toolCall) => toolCall.id)).size).toBe(2);
  });

  it("rejects a continuation whose existing id and name identify different siblings", async () => {
    const { result, toolCalls } = await runMistralToolFixture("response-conflicting-identities", [
      identified,
      [secondCall(":1}", { id: "explicitA" })],
    ]);

    expect(result).toMatchObject({
      stopReason: "error",
      errorMessage: "Mistral streamed tool-call identities conflict; refusing to merge arguments",
    });
    expect(toolCalls).toEqual([]);
  });

  it("joins thinking text before string content and skips empty reference-only chunks", async () => {
    const textPart = (text: string) => ({ type: "text", text });
    const thinkingParts = [
      [{ type: "reference", reference_ids: [1] }, textPart("")],
      [
        ...["", "\ud83d"].map(textPart),
        { type: "tool_reference", tool: "search", title: "source" },
        ...["\ude00 ", "\ud83dx", ""].map(textPart),
      ],
      [],
    ];
    const chunks = thinkingParts.map((thinking) => {
      const parsed = contentChunkFromJSON(JSON.stringify({ type: "thinking", thinking }));
      assert(parsed.ok, "Mistral SDK failed to parse thinking fixture");
      return parsed.value;
    });
    mistralMockState.streamResult = mistralEvents(
      [...chunks.map((chunk) => [chunk]), "done"].map((content) =>
        mistralEvent(content, { id: "response-thinking-parts" }),
      ),
    );
    const stream = streamMistral(makeMistralModel(), context, { apiKey: "fixture" });
    const events = [];
    for await (const event of stream) {
      events.push(event);
    }
    expect((await stream.result()).content).toEqual([
      { type: "thinking", thinking: "😀 x" },
      { type: "text", text: "done" },
    ]);
    expect(
      events.filter((event) => event.type === "thinking_delta").map((event) => event.delta),
    ).toEqual(["😀 x"]);
    expect(events.map((event) => event.type)).toEqual(
      "start thinking_start thinking_delta thinking_end text_start text_delta text_end done".split(
        " ",
      ),
    );
  });

  it("validates and emits one snapshot of a pinned Mistral tool name", async () => {
    let nameReads = 0;
    await runMistralFixture(
      { ...context, tools: [makeHealthyTool()] as never },
      {
        toolChoice: {
          type: "function",
          function: {
            get name() {
              nameReads += 1;
              return nameReads === 1 ? "healthy_tool" : "broken_tool";
            },
          },
        },
      },
    );

    expect(nameReads).toBe(1);
    expect(mistralMockState.payloads[0]).toHaveProperty("toolChoice", {
      type: "function",
      function: { name: "healthy_tool" },
    });
  });

  it("strips the internal cache boundary marker from the system message", async () => {
    await runSimpleMistralFixture({
      systemPrompt: `Stable${SYSTEM_PROMPT_CACHE_BOUNDARY}Dynamic`,
      messages: [{ role: "user", content: "hello", timestamp: 0 }],
    });

    const systemMessage = payload().messages.find((message) => message.role === "system");
    expect(systemMessage?.content).toBe("Stable\nDynamic");
    expect(JSON.stringify(payload())).not.toContain("OPENCLAW_CACHE_BOUNDARY");
  });

  it.each([
    [undefined, "prompt-cache-key", "prompt-cache-key", "session-affinity", undefined],
    ["none", "prompt-cache-key", undefined, undefined, undefined],
    [undefined, undefined, "session-affinity", "session-affinity", undefined],
    [undefined, "prompt-cache-key", "prompt-cache-key", "session-affinity", { "X-Affinity": "" }],
    [undefined, "prompt-cache-key", "prompt-cache-key", "explicit", { "X-Affinity": "explicit" }],
    [undefined, "prompt-cache-key", "prompt-cache-key", undefined, { "X-Affinity": null }],
  ] as const)(
    "resolves cache retention %s and key %s (key %s, affinity %s, headers %j)",
    async (cacheRetention, promptCacheKey, key, affinity, headers) => {
      await runSimpleMistralFixture(context, {
        sessionId: "session-affinity",
        promptCacheKey,
        cacheRetention,
        headers,
      });
      const options = mistralMockState.requestOptions[0] as { headers?: Record<string, string> };
      expect(payload().promptCacheKey).toBe(key);
      expect(new Headers(options.headers).get("x-affinity") ?? undefined).toBe(affinity);
    },
  );

  it.each([
    ["SDK camel case", { promptTokensDetails: { cachedTokens: 64 } }],
    ["wire snake case", { prompt_tokens_details: { cached_tokens: 64 } }],
  ])("accounts for cached prompt tokens from %s usage", async (_label, cacheUsage) => {
    mistralMockState.streamResult = mistralEvents([
      mistralEvent("ok", {
        id: "response-cache-usage",
        model: "mistral-small-latest",
        usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110, ...cacheUsage },
        choices: [{ finishReason: "stop", delta: { content: "ok", toolCalls: [] } }],
      }),
    ]);

    const result = await runMistralFixture(context, { apiKey: "fixture" });

    expect(result).toMatchObject({
      usage: { input: 36, output: 10, cacheRead: 64, cacheWrite: 0, totalTokens: 110 },
      responseId: "response-cache-usage",
      responseModel: "mistral-small-latest",
    });
  });

  it("preserves tool-result boundary whitespace in the request payload", async () => {
    await runMistralFixture(
      makeMistralToolResultContext("read_file", [{ type: "text", text: "  indented\n" }]),
    );
    expect(toolMessage()?.content).toContainEqual({ type: "text", text: "  indented\n" });
  });

  it("does not emit image chunks or placeholders for payload-less tool media", async () => {
    const testContext = makeMistralToolResultContext(
      "screenshot",
      [{ type: "image", mimeType: "image/png", data: "" }],
      { toolCallId: "tool_husk", includeUser: false, includeToolResultName: true },
    );

    await runMistralFixture(
      testContext,
      { apiKey: "fake" },
      { ...makeMistralModel(), input: ["text", "image"] },
    );

    expect(toolMessage()?.content).toEqual([{ type: "text", text: "(no tool output)" }]);
  });
});
