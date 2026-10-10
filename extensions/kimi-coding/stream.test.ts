import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
} from "openclaw/plugin-sdk/llm";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it } from "vitest";
import { wrapKimiProviderStream } from "./stream.js";

type FakeStream = {
  result: () => Promise<unknown>;
  [Symbol.asyncIterator]: () => AsyncIterator<unknown>;
};

function createFakeStream(params: { events: unknown[]; resultMessage: unknown }): FakeStream {
  return {
    async result() {
      return params.resultMessage;
    },
    async *[Symbol.asyncIterator]() {
      yield* params.events;
    },
  };
}

const KIMI_TOOL_TEXT =
  ' <|tool_calls_section_begin|> <|tool_call_begin|> functions.read:0 <|tool_call_argument_begin|> {"file_path":"./package.json"} <|tool_call_end|> <|tool_calls_section_end|>';
const KIMI_MULTI_TOOL_TEXT =
  ' <|tool_calls_section_begin|> <|tool_call_begin|> functions.read:0 <|tool_call_argument_begin|> {"file_path":"./package.json"} <|tool_call_end|> <|tool_call_begin|> functions.write:1 <|tool_call_argument_begin|> {"file_path":"./out.txt","content":"done"} <|tool_call_end|> <|tool_calls_section_end|>';
const KIMI_MODEL = {
  api: "anthropic-messages",
  provider: "kimi",
  id: "k2p5",
  reasoning: true,
} as Model<"anthropic-messages">;
const KIMI_CONTEXT = { messages: [] } as Context;

function createReadToolCall() {
  return {
    type: "toolCall",
    id: "functions.read:0",
    name: "functions.read",
    arguments: { file_path: "./package.json" },
  };
}

function createAssistantTextMessage(text: string) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
  };
}

function createResultStreamFn(resultMessage: unknown): StreamFn {
  return () =>
    createFakeStream({
      events: [],
      resultMessage,
    }) as ReturnType<StreamFn>;
}

async function callKimiStream(wrapped: StreamFn): Promise<FakeStream> {
  return (await wrapped(KIMI_MODEL, KIMI_CONTEXT, {})) as FakeStream;
}

function createPayloadCapturingStream(initialPayload: Record<string, unknown> = {}) {
  let capturedPayload: Record<string, unknown> | undefined;
  let capturedModel: Model | undefined;
  let capturedOptions: Parameters<StreamFn>[2];
  const streamFn: StreamFn = (model, _context, options) => {
    capturedModel = model;
    capturedOptions = options;
    const payload = structuredClone(initialPayload);
    options?.onPayload?.(payload as never, model as never);
    capturedPayload = payload;
    return createFakeStream({
      events: [],
      resultMessage: { role: "assistant", content: [] },
    }) as never;
  };
  return {
    streamFn,
    getCapturedModel: () => capturedModel,
    getCapturedOptions: () => capturedOptions,
    getCapturedPayload: () => capturedPayload,
  };
}

function wrapKimiStream(streamFn: StreamFn): StreamFn {
  return wrapKimiProviderStream({
    provider: "kimi",
    modelId: KIMI_MODEL.id,
    streamFn,
    extraParams: { thinking: "off" },
  });
}

function captureKimiPayload(
  params: Pick<ProviderWrapStreamFnContext, "modelId" | "thinkingLevel" | "extraParams"> & {
    api?: Model["api"];
  },
  initialPayload: Record<string, unknown> = {},
  options: Parameters<StreamFn>[2] = {},
) {
  const captured = createPayloadCapturingStream(initialPayload);
  const { api = KIMI_MODEL.api, ...ctx } = params;
  const wrapped = wrapKimiProviderStream({
    ...ctx,
    provider: "kimi",
    streamFn: captured.streamFn,
  });
  void wrapped({ ...KIMI_MODEL, api, id: ctx.modelId }, KIMI_CONTEXT, options);
  return captured;
}

describe("kimi tool-call markup wrapper", () => {
  it("converts tagged Kimi tool-call text into structured tool calls", async () => {
    const partial: AssistantMessage = {
      role: "assistant",
      api: KIMI_MODEL.api,
      provider: KIMI_MODEL.provider,
      model: KIMI_MODEL.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      timestamp: 1,
      content: [{ type: "text", text: KIMI_TOOL_TEXT }],
      stopReason: "stop",
    };
    const message = structuredClone(partial);
    const finalMessage: AssistantMessage = {
      ...structuredClone(partial),
      content: [
        { type: "thinking", thinking: "Need to read the file first." },
        { type: "text", text: KIMI_TOOL_TEXT },
      ],
    };

    const baseStreamFn: StreamFn = () => ({
      async result() {
        return finalMessage;
      },
      async *[Symbol.asyncIterator](): AsyncGenerator<AssistantMessageEvent> {
        yield { type: "start", partial };
        yield { type: "done", reason: "stop", message };
      },
    });

    const wrapped = wrapKimiStream(baseStreamFn);
    const stream = await wrapped(KIMI_MODEL, KIMI_CONTEXT, {});

    const events: AssistantMessageEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }
    const result = await stream.result();
    const toolMessage = {
      role: "assistant",
      content: [createReadToolCall()],
      stopReason: "toolUse",
    };

    expect(events).toMatchObject([
      {
        type: "start",
        partial: toolMessage,
      },
      {
        type: "done",
        reason: "stop",
        message: toolMessage,
      },
    ]);
    expect(result).toMatchObject({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Need to read the file first." },
        createReadToolCall(),
      ],
      stopReason: "toolUse",
    });
  });

  it("leaves normal assistant text unchanged", async () => {
    const finalMessage = createAssistantTextMessage("normal response");
    const stream = await callKimiStream(wrapKimiStream(createResultStreamFn(finalMessage)));

    await expect(stream.result()).resolves.toBe(finalMessage);
  });

  it("supports async stream functions", async () => {
    const finalMessage = createAssistantTextMessage(KIMI_TOOL_TEXT);
    const baseStreamFn: StreamFn = async (model, context, options) =>
      createResultStreamFn(finalMessage)(model, context, options);

    const wrapped = wrapKimiStream(baseStreamFn);
    const stream = await callKimiStream(wrapped);

    await expect(stream.result()).resolves.toEqual({
      role: "assistant",
      content: [createReadToolCall()],
      stopReason: "toolUse",
    });
  });

  it("parses multiple tagged tool calls in one section", async () => {
    const finalMessage = createAssistantTextMessage(KIMI_MULTI_TOOL_TEXT);
    const baseStreamFn = createResultStreamFn(finalMessage);

    const wrapped = wrapKimiStream(baseStreamFn);
    const stream = await callKimiStream(wrapped);

    await expect(stream.result()).resolves.toEqual({
      role: "assistant",
      content: [
        createReadToolCall(),
        {
          type: "toolCall",
          id: "functions.write:1",
          name: "functions.write",
          arguments: { file_path: "./out.txt", content: "done" },
        },
      ],
      stopReason: "toolUse",
    });
  });

  it("keeps tagged tool-call conversion when one wrapper changes thinking modes", async () => {
    const baseStreamFn: StreamFn = () =>
      createFakeStream({
        events: [],
        resultMessage: createAssistantTextMessage(KIMI_TOOL_TEXT),
      }) as ReturnType<StreamFn>;
    const wrapped = wrapKimiProviderStream({
      streamFn: baseStreamFn,
    } as never);
    for (const reasoning of ["off", "max", undefined] as const) {
      const stream = await wrapped(KIMI_MODEL, KIMI_CONTEXT, { reasoning });
      await expect(stream.result()).resolves.toEqual({
        role: "assistant",
        content: [createReadToolCall()],
        stopReason: "toolUse",
      });
    }
  });

  it("defaults K3-256k to adaptive high thinking", () => {
    const modelId = "k3-256k";
    const { getCapturedModel, getCapturedPayload } = captureKimiPayload(
      { modelId },
      {
        thinking: { type: "disabled", budget_tokens: 8192 },
        output_config: { effort: "low", format: { type: "json_schema" } },
        reasoning: { effort: "low" },
        reasoning_effort: "low",
        reasoningEffort: "low",
      },
    );

    expect(getCapturedPayload()).toEqual({
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "high", format: { type: "json_schema" } },
    });
    expect(getCapturedModel()?.compat).toMatchObject({ allowEmptySignature: true });
  });

  it.each([
    ["minimal", "low"],
    ["medium", "high"],
    ["adaptive", "high"],
    ["xhigh", "max"],
  ] as const)("maps K3 %s thinking to %s effort", (thinkingLevel, effort) => {
    const { getCapturedPayload } = captureKimiPayload({ modelId: "k3", thinkingLevel });

    expect(getCapturedPayload()).toEqual({
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort },
    });
  });

  it.each([
    { modelId: "k3", extraParams: undefined, thinkingLevel: "off" },
    { modelId: "k3-256k", extraParams: { thinking: "off" }, thinkingLevel: "max" },
  ] as const)("honors $modelId thinking off", ({ modelId, extraParams, thinkingLevel }) => {
    const { getCapturedPayload } = captureKimiPayload(
      { modelId, extraParams, thinkingLevel },
      {
        thinking: { type: "adaptive" },
        output_config: { effort: "max", format: { type: "json_schema" } },
        reasoning: { effort: "max" },
        reasoning_effort: "max",
        reasoningEffort: "max",
      },
    );

    expect(getCapturedPayload()).toEqual({
      thinking: { type: "disabled" },
      output_config: { format: { type: "json_schema" } },
    });
  });

  it("lets explicit K3 thinking enablement override session off", () => {
    const { getCapturedPayload } = captureKimiPayload({
      modelId: "k3",
      extraParams: { thinking: "enabled" },
      thinkingLevel: "off",
    });
    expect(getCapturedPayload()).toEqual({
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { effort: "high" },
    });
  });

  it.each([
    ["off", undefined],
    ["minimal", "low"],
    ["low", "low"],
    ["medium", "high"],
    ["high", "high"],
    ["adaptive", "high"],
    ["xhigh", "max"],
    ["max", "max"],
  ] as const)("sends OpenAI-compatible K3 %s as %s effort", (thinkingLevel, effort) => {
    const { getCapturedPayload } = captureKimiPayload(
      { modelId: "Kimi-K3", api: "openai-completions", thinkingLevel },
      { reasoning_effort: "medium", reasoningEffort: "medium", reasoning: { effort: "medium" } },
    );
    expect(getCapturedPayload()).toEqual({
      thinking: { type: thinkingLevel === "off" ? "disabled" : "enabled" },
      ...(effort ? { reasoning_effort: effort } : {}),
    });
  });

  it.each([
    { thinkingLevel: "max", thinking: "off", expected: { thinking: { type: "disabled" } } },
    {
      thinkingLevel: "off",
      thinking: "enabled",
      expected: { thinking: { type: "enabled" }, reasoning_effort: "high" },
    },
  ] as const)("honors explicit OpenAI-compatible K3 thinking $thinking", (row) => {
    const { getCapturedPayload } = captureKimiPayload({
      modelId: "kimi-k3",
      api: "openai-completions",
      thinkingLevel: row.thinkingLevel,
      extraParams: { thinking: row.thinking },
    });
    expect(getCapturedPayload()).toEqual(row.expected);
  });

  it.each([
    { chat_template_kwargs: { reasoning_effort: "low" } },
    { chatTemplateKwargs: { reasoning_effort: "low" } },
    { extra_body: { chat_template_kwargs: { reasoning_effort: "low" } } },
  ])("does not shadow explicit K3 template effort with a generated root effort", (extraParams) => {
    const { getCapturedPayload } = captureKimiPayload({
      modelId: "kimi-k3",
      api: "openai-completions",
      thinkingLevel: "max",
      extraParams,
    });
    expect(getCapturedPayload()).toEqual({ thinking: { type: "enabled" } });
  });

  it("strips Anthropic cache_control markers before Kimi requests are sent", () => {
    const text = { type: "text", text: "hello" };
    const nestedText = { type: "text", text: "done" };
    const toolResult = { type: "tool_result", tool_use_id: "tool_1", content: [nestedText] };
    const toolUse = {
      type: "tool_use",
      id: "tool_2",
      name: "persist",
      input: { cache_control: "tool argument", nested: { cache_control: "nested argument" } },
    };
    const plainText = { type: "text", text: "bye" };
    const cache_control = { type: "ephemeral" };
    const { getCapturedPayload } = captureKimiPayload(
      { modelId: "kimi-code", extraParams: { thinking: "enabled" } },
      {
        system: [{ type: "text", text: "stable", cache_control: { ...cache_control, ttl: "1h" } }],
        messages: [
          {
            role: "user",
            content: [
              { ...text, cache_control },
              { ...toolResult, content: [{ ...nestedText, cache_control }], cache_control },
              { ...toolUse, cache_control },
              plainText,
            ],
          },
        ],
      },
    );

    expect(getCapturedPayload()).toEqual({
      max_tokens: 16000,
      system: [{ type: "text", text: "stable" }],
      messages: [{ role: "user", content: [text, toolResult, toolUse, plainText] }],
      thinking: { type: "enabled", budget_tokens: 1024 },
    });
  });

  it.each([
    {
      name: "lets explicit model params disable session thinking",
      extraParams: { thinking: "off" },
      thinkingLevel: "high",
      reasoning: "max",
      expected: { thinking: { type: "disabled" } },
    },
    {
      name: "lets explicit model params enable thinking when the session disables it",
      extraParams: { thinking: "enabled" },
      thinkingLevel: "off",
      reasoning: "off",
      expected: {
        max_tokens: 16000,
        thinking: { type: "enabled", budget_tokens: 1024 },
      },
    },
  ] as const)("$name", ({ extraParams, thinkingLevel, reasoning, expected }) => {
    const { getCapturedPayload } = captureKimiPayload(
      { modelId: "kimi-code", extraParams, thinkingLevel },
      {},
      { reasoning },
    );

    expect(getCapturedPayload()).toEqual(expected);
  });

  it("backfills Kimi OpenAI-compatible tool-call reasoning_content when thinking is enabled", () => {
    const user = { role: "user", content: "run pwd" };
    const toolCall = {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "exec", arguments: '{"command":"pwd"}' },
        },
      ],
    };
    const nativeReasoning = {
      role: "assistant",
      content: "kept",
      reasoning_content: "native reasoning",
      tool_calls: [{ id: "call_2", type: "function", function: { name: "read", arguments: "{}" } }],
    };
    const { getCapturedPayload } = captureKimiPayload(
      {
        modelId: "kimi-for-coding",
        api: "openai-completions",
        extraParams: { thinking: "enabled" },
      },
      { messages: [user, toolCall, nativeReasoning] },
    );

    expect(getCapturedPayload()).toEqual({
      messages: [user, { ...toolCall, reasoning_content: "" }, nativeReasoning],
      thinking: { type: "enabled" },
    });
  });

  it("strips Kimi OpenAI-compatible replay reasoning_content when thinking is disabled", () => {
    const toolCall = {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "exec", arguments: '{"command":"pwd"}' },
        },
      ],
    };
    const { getCapturedPayload } = captureKimiPayload(
      { modelId: "kimi-for-coding", api: "openai-completions", extraParams: { thinking: "off" } },
      { messages: [{ ...toolCall, reasoning_content: "old reasoning" }] },
    );

    expect(getCapturedPayload()).toEqual({
      messages: [toolCall],
      thinking: { type: "disabled" },
    });
  });

  it("adds the default Kimi Anthropic thinking budget for explicit enabled params", () => {
    const cases = ["enabled", true, { type: "enabled" }] as const;

    for (const configuredThinking of cases) {
      const { getCapturedPayload } = captureKimiPayload({
        modelId: "kimi-code",
        extraParams: { thinking: configuredThinking },
      });

      expect(getCapturedPayload()).toEqual({
        max_tokens: 16000,
        thinking: { type: "enabled", budget_tokens: 1024 },
      });
    }
  });

  it("uses the session Kimi Anthropic budget for explicit enabled params when available", () => {
    const { getCapturedPayload } = captureKimiPayload({
      modelId: "kimi-code",
      extraParams: { thinking: "enabled" },
      thinkingLevel: "medium",
    });

    expect(getCapturedPayload()).toEqual({
      max_tokens: 16000,
      thinking: { type: "enabled", budget_tokens: 4096 },
    });
  });

  it("preserves explicit Kimi Anthropic thinking budgets", () => {
    const { getCapturedOptions, getCapturedPayload } = captureKimiPayload({
      modelId: "kimi-code",
      extraParams: { thinking: { type: "enabled", budget_tokens: 4096 } },
      thinkingLevel: "adaptive",
    });

    expect(getCapturedOptions()?.reasoning).toBe("high");
    expect(getCapturedPayload()).toEqual({
      max_tokens: 16000,
      thinking: { type: "enabled", budget_tokens: 4096 },
    });
  });

  it("preserves larger Kimi Anthropic max_tokens values", () => {
    const { getCapturedPayload } = captureKimiPayload(
      { modelId: "kimi-code", thinkingLevel: "high" },
      { max_tokens: 32768 },
    );

    expect(getCapturedPayload()).toEqual({
      max_tokens: 32768,
      thinking: { type: "enabled", budget_tokens: 8192 },
    });
  });

  it("bounds per-call Kimi Anthropic thinking and lowers its adaptive default to native high", () => {
    const cases = [
      ["off", undefined],
      ["max", 8192],
      [undefined, 8192],
      ["minimal", 1024],
      ["low", 1024],
      ["medium", 4096],
      ["high", 8192],
      ["xhigh", 8192],
    ] as const;
    const {
      streamFn: baseStreamFn,
      getCapturedOptions,
      getCapturedPayload,
    } = createPayloadCapturingStream();
    const wrapped = wrapKimiProviderStream({
      provider: "kimi",
      modelId: "kimi-code",
      thinkingLevel: "adaptive",
      streamFn: baseStreamFn,
    } as never);

    for (const [reasoning, budgetTokens] of cases) {
      void wrapped(KIMI_MODEL, KIMI_CONTEXT, { reasoning });

      expect(getCapturedOptions()?.reasoning).toBe(reasoning ?? "high");
      expect(getCapturedPayload()).toEqual(
        reasoning === "off"
          ? { thinking: { type: "disabled" } }
          : {
              max_tokens: 16000,
              thinking: { type: "enabled", budget_tokens: budgetTokens },
            },
      );
    }
  });
});
