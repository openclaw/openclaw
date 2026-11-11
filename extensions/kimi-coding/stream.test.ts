/// <reference lib="esnext.array" />
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Model,
} from "openclaw/plugin-sdk/llm";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { createZeroUsageFixture } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";
import { wrapKimiProviderStream } from "./stream.js";

function createFakeStream<T, E>(resultMessage: T, events: E[] = []) {
  return {
    async result() {
      return resultMessage;
    },
    async *[Symbol.asyncIterator]() {
      yield* events;
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

const readToolCall = {
  type: "toolCall",
  id: "functions.read:0",
  name: "functions.read",
  arguments: { file_path: "./package.json" },
};

const createAssistantTextMessage = (text: string) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  stopReason: "stop",
});

function createResultStreamFn(resultMessage: unknown): StreamFn {
  return () => createFakeStream(resultMessage) as ReturnType<StreamFn>;
}

async function callKimiStream(wrapped: StreamFn) {
  return await wrapped(KIMI_MODEL, KIMI_CONTEXT, {});
}

function createPayloadCapturingStream(initialPayload: Record<string, unknown> = {}) {
  const captured: {
    payload?: Record<string, unknown>;
    model?: Model;
    options?: Parameters<StreamFn>[2];
  } = {};
  const streamFn: StreamFn = (model, _context, options) => {
    Object.assign(captured, { model, options });
    const payload = structuredClone(initialPayload);
    options?.onPayload?.(payload as never, model as never);
    captured.payload = payload;
    return createFakeStream({ role: "assistant", content: [] }) as never;
  };
  return { streamFn, captured };
}

function wrapKimiStream(streamFn: StreamFn): StreamFn {
  return wrapKimiProviderStream({
    provider: "kimi",
    modelId: KIMI_MODEL.id,
    streamFn,
    extraParams: { thinking: "off" },
  });
}

function expectPayload(
  params: Pick<ProviderWrapStreamFnContext, "modelId" | "thinkingLevel" | "extraParams"> & {
    api?: Model["api"];
  },
  expected: Record<string, unknown>,
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
  expect(captured.captured.payload).toEqual(expected);
  return captured.captured;
}

const adaptiveThinking = { type: "adaptive", display: "summarized" };
const budgetedThinking = (budget_tokens: number, max_tokens = 16000) => ({
  max_tokens,
  thinking: { type: "enabled", budget_tokens },
});
const replayToolCall = {
  role: "assistant",
  content: null,
  tool_calls: [
    { id: "call_1", type: "function", function: { name: "exec", arguments: '{"command":"pwd"}' } },
  ],
};

describe("kimi tool-call markup wrapper", () => {
  it("converts tagged Kimi tool-call text into structured tool calls", async () => {
    const partial: AssistantMessage = {
      role: "assistant",
      api: KIMI_MODEL.api,
      provider: KIMI_MODEL.provider,
      model: KIMI_MODEL.id,
      usage: createZeroUsageFixture(),
      timestamp: 1,
      content: [{ type: "text", text: KIMI_TOOL_TEXT }],
      stopReason: "stop",
    };
    const message = structuredClone(partial);
    const thinking = { type: "thinking", thinking: "Need to read the file first." } as const;
    const finalMessage: AssistantMessage = {
      ...structuredClone(partial),
      content: [thinking, ...partial.content],
    };

    const baseStreamFn: StreamFn = () =>
      createFakeStream(finalMessage, [
        { type: "start", partial },
        { type: "done", reason: "stop", message },
      ] satisfies AssistantMessageEvent[]);

    const stream = await wrapKimiStream(baseStreamFn)(KIMI_MODEL, KIMI_CONTEXT, {});
    const events: AssistantMessageEvent[] = await Array.fromAsync(stream);
    const result = await stream.result();
    const toolMessage = {
      role: "assistant",
      content: [readToolCall],
      stopReason: "toolUse",
    };

    expect(events).toMatchObject([
      { type: "start", partial: toolMessage },
      { type: "done", reason: "stop", message: toolMessage },
    ]);
    expect(result).toMatchObject({
      ...toolMessage,
      content: [thinking, readToolCall],
    });
  });

  it("leaves normal assistant text unchanged", async () => {
    const finalMessage = createAssistantTextMessage("normal response");
    const stream = await callKimiStream(wrapKimiStream(createResultStreamFn(finalMessage)));

    await expect(stream.result()).resolves.toBe(finalMessage);
  });

  it("parses multiple tagged tool calls from an async stream function", async () => {
    const finalMessage = createAssistantTextMessage(KIMI_MULTI_TOOL_TEXT);
    const baseStreamFn: StreamFn = async (model, context, options) =>
      createResultStreamFn(finalMessage)(model, context, options);
    const stream = await callKimiStream(wrapKimiStream(baseStreamFn));

    await expect(stream.result()).resolves.toEqual({
      role: "assistant",
      content: [
        readToolCall,
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

  it("defaults K3-256k to adaptive high thinking", () => {
    const { model } = expectPayload(
      { modelId: "k3-256k" },
      {
        thinking: adaptiveThinking,
        output_config: { effort: "high", format: { type: "json_schema" } },
      },
      {
        thinking: { type: "disabled", budget_tokens: 8192 },
        output_config: { effort: "low", format: { type: "json_schema" } },
        reasoning: { effort: "low" },
        reasoning_effort: "low",
        reasoningEffort: "low",
      },
    );

    expect(model?.compat).toMatchObject({ allowEmptySignature: true });
  });

  it.each([
    ["k3", "minimal", undefined, "low"],
    ["k3", "medium", undefined, "high"],
    ["k3", "adaptive", undefined, "high"],
    ["k3", "xhigh", undefined, "max"],
    ["k3", "off", undefined, undefined],
    ["k3-256k", "max", "off", undefined],
    ["k3.1-pro", "off", undefined, "high"],
    ["k3.1-pro-highspeed", "off", undefined, "high"],
    ["k3", "off", "enabled", "high"],
  ] as const)(
    "maps %s session %s / explicit %s to effort %s",
    (modelId, thinkingLevel, thinking, effort) => {
      expectPayload(
        { modelId, extraParams: { thinking }, thinkingLevel },
        {
          thinking: effort ? adaptiveThinking : { type: "disabled" },
          output_config: { format: { type: "json_schema" }, ...(effort ? { effort } : {}) },
        },
        {
          thinking: { type: "adaptive" },
          output_config: { effort: "max", format: { type: "json_schema" } },
          reasoning: { effort: "max" },
          reasoning_effort: "max",
          reasoningEffort: "max",
        },
      );
    },
  );

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
    expectPayload(
      { modelId: "Kimi-K3", api: "openai-completions", thinkingLevel },
      {
        thinking: { type: thinkingLevel === "off" ? "disabled" : "enabled" },
        ...(effort ? { reasoning_effort: effort } : {}),
      },
      { reasoning_effort: "medium", reasoningEffort: "medium", reasoning: { effort: "medium" } },
    );
  });

  it.each([
    ["max", "off", { thinking: { type: "disabled" } }],
    ["off", "enabled", { thinking: { type: "enabled" }, reasoning_effort: "high" }],
  ] as const)("overrides OpenAI K3 session %s with %s", (thinkingLevel, thinking, expected) => {
    expectPayload(
      { modelId: "kimi-k3", api: "openai-completions", thinkingLevel, extraParams: { thinking } },
      expected,
    );
  });

  it.each([
    { chat_template_kwargs: { reasoning_effort: "low" } },
    { chatTemplateKwargs: { reasoning_effort: "low" } },
    { extra_body: { chat_template_kwargs: { reasoning_effort: "low" } } },
  ])("does not shadow explicit K3 template effort with a generated root effort", (extraParams) => {
    expectPayload(
      { modelId: "kimi-k3", api: "openai-completions", thinkingLevel: "max", extraParams },
      { thinking: { type: "enabled" } },
    );
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
    expectPayload(
      { modelId: "kimi-code", extraParams: { thinking: "enabled" } },
      {
        ...budgetedThinking(1024),
        system: [{ type: "text", text: "stable" }],
        messages: [{ role: "user", content: [text, toolResult, toolUse, plainText] }],
      },
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
  });

  it.each([
    ["off", "high", "max", { thinking: { type: "disabled" } }],
    ["enabled", "off", "off", budgetedThinking(1024)],
  ] as const)(
    "explicit %s overrides session %s and call %s",
    (thinking, thinkingLevel, reasoning, expected) => {
      expectPayload(
        { modelId: "kimi-code", extraParams: { thinking }, thinkingLevel },
        expected,
        {},
        { reasoning },
      );
    },
  );

  it("backfills Kimi OpenAI-compatible tool-call reasoning_content when thinking is enabled", () => {
    const user = { role: "user", content: "run pwd" };
    const nativeReasoning = {
      role: "assistant",
      content: "kept",
      reasoning_content: "native reasoning",
      tool_calls: [{ id: "call_2", type: "function", function: { name: "read", arguments: "{}" } }],
    };
    expectPayload(
      {
        modelId: "kimi-for-coding",
        api: "openai-completions",
        extraParams: { thinking: "enabled" },
      },
      {
        messages: [user, { ...replayToolCall, reasoning_content: "" }, nativeReasoning],
        thinking: { type: "enabled" },
      },
      { messages: [user, replayToolCall, nativeReasoning] },
    );
  });

  it("strips Kimi OpenAI-compatible replay reasoning_content when thinking is disabled", () => {
    expectPayload(
      { modelId: "kimi-for-coding", api: "openai-completions", extraParams: { thinking: "off" } },
      { messages: [replayToolCall], thinking: { type: "disabled" } },
      { messages: [{ ...replayToolCall, reasoning_content: "old reasoning" }] },
    );
  });

  it.each([
    ["enabled", undefined, 1024, "low", undefined],
    [true, undefined, 1024, "low", undefined],
    [{ type: "enabled" }, undefined, 1024, "low", undefined],
    ["enabled", "medium", 4096, "medium", undefined],
    [{ type: "enabled", budget_tokens: 4096 }, "adaptive", 4096, "high", undefined],
    [undefined, "high", 8192, "high", 32768],
  ] as const)(
    "resolves Anthropic budget for %j at %s",
    (thinking, thinkingLevel, budget, reasoning, max_tokens) => {
      const { options } = expectPayload(
        { modelId: "kimi-code", extraParams: { thinking }, thinkingLevel },
        budgetedThinking(budget, max_tokens),
        { max_tokens },
      );
      expect(options?.reasoning).toBe(reasoning);
    },
  );

  it("bounds per-call Kimi Anthropic thinking and lowers its adaptive default to native high", () => {
    const cases = [
      ["off", 1024],
      ["max", 8192],
      [undefined, 8192],
      ["minimal", 1024],
      ["low", 1024],
      ["medium", 4096],
      ["high", 8192],
      ["xhigh", 8192],
    ] as const;
    const { streamFn, captured } = createPayloadCapturingStream();
    const wrapped = wrapKimiProviderStream({
      provider: "kimi",
      modelId: "kimi-code",
      thinkingLevel: "adaptive",
      streamFn,
    } as never);

    for (const [reasoning, budgetTokens] of cases) {
      void wrapped(KIMI_MODEL, KIMI_CONTEXT, { reasoning });

      expect(captured.options?.reasoning).toBe(reasoning === "off" ? "low" : (reasoning ?? "high"));
      expect(captured.payload).toEqual(budgetedThinking(budgetTokens));
    }
  });
});
