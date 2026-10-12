import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { createQwenThinkingWrapper, wrapQwenProviderStream } from "./stream.js";

type ThinkingLevel = Parameters<typeof wrapQwenProviderStream>[0]["thinkingLevel"];

function createModel(id = "qwen3.6-plus", overrides: Partial<Model> = {}): Model {
  return {
    api: "openai-completions",
    provider: "qwen",
    id,
    name: id,
    baseUrl: "https://example.test/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    maxTokens: 8192,
    ...overrides,
  };
}

function tokenPlanModel(id: string, overrides: Partial<Model> = {}): Model {
  return createModel(id, { provider: "qwen-token-plan", ...overrides });
}

function captureProviderPayload(
  model: Model,
  thinkingLevel: ThinkingLevel,
  payload: Record<string, unknown> = {},
  options: NonNullable<Parameters<StreamFn>[2]> & { reasoningEffort?: ThinkingLevel } = {},
  runtimeModel: Model = model,
): Record<string, unknown> {
  let captured: Record<string, unknown> | undefined;
  const streamFn: StreamFn = (_model, _context, streamOptions) => {
    streamOptions?.onPayload?.(payload, _model);
    captured = payload;
    return {} as ReturnType<StreamFn>;
  };
  const wrapped = wrapQwenProviderStream({
    provider: model.provider,
    modelId: model.id,
    model,
    streamFn,
    thinkingLevel,
  });
  void wrapped?.(runtimeModel, { messages: [] }, options);
  if (!captured) {
    throw new Error("Qwen wrapper did not invoke the underlying stream");
  }
  return captured;
}

function createAsyncPayloadCapture(
  model: Model,
  thinkingLevel: ThinkingLevel,
  createPayload: () => Record<string, unknown>,
) {
  let captured: Record<string, unknown> = {};
  const streamFn: StreamFn = async (_model, _context, options) => {
    const payload = createPayload();
    const replacement = await options?.onPayload?.(payload, _model);
    captured =
      replacement && typeof replacement === "object"
        ? (replacement as Record<string, unknown>)
        : payload;
    return {} as Awaited<ReturnType<StreamFn>>;
  };
  const wrapped = wrapQwenProviderStream({
    provider: model.provider,
    modelId: model.id,
    model,
    streamFn,
    thinkingLevel,
  });
  return async (onPayload: NonNullable<Parameters<StreamFn>[2]>["onPayload"]) => {
    await wrapped?.(model, { messages: [] }, { onPayload });
    return captured;
  };
}

function readToolCall(id = "call_1") {
  return { id, type: "function", function: { name: "read", arguments: "{}" } };
}

function readToolMessage(id = "call_1", reasoningContent?: string) {
  return {
    role: "assistant",
    tool_calls: [readToolCall(id)],
    ...(reasoningContent === undefined ? {} : { reasoning_content: reasoningContent }),
  };
}

function capturePayload(params: {
  thinkingLevel?: "off" | "low" | "medium" | "high" | "xhigh" | "max";
  thinkingFormat?: string;
  reasoning?: unknown;
  initialPayload?: Record<string, unknown>;
  model?: Partial<Model>;
}): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...params.initialPayload };
  const baseStreamFn: StreamFn = (_model, _context, options) => {
    options?.onPayload?.(payload, _model);
    return {} as ReturnType<StreamFn>;
  };

  const wrapped = createQwenThinkingWrapper(
    baseStreamFn,
    params.thinkingLevel ?? "high",
    params.thinkingFormat,
  );
  void wrapped(
    createModel(undefined, params.model),
    { messages: [] },
    params.reasoning === undefined ? {} : ({ reasoning: params.reasoning } as never),
  );

  return payload;
}

describe("createQwenThinkingWrapper", () => {
  it("uses the runtime model qwen-chat-template format when the wrapper context omits it", () => {
    expect(
      capturePayload({
        thinkingLevel: "off",
        model: { compat: { thinkingFormat: "qwen-chat-template" } },
        initialPayload: {
          chat_template_kwargs: { enable_thinking: true },
          enable_thinking: true,
        },
      }),
    ).toEqual({
      chat_template_kwargs: { enable_thinking: false, preserve_thinking: true },
    });
  });
});

describe("wrapQwenProviderStream", () => {
  it.each([
    { provider: "qwen-token-plan", id: "qwen3.8-flash", level: "medium", effort: "medium" },
  ] as const)(
    "maps $provider/$id $level without changing reasoning replay",
    ({ provider, id, level, effort }) => {
      const messages = [
        { role: "assistant", content: "done", reasoning_content: "original reasoning" },
      ];
      const captured = captureProviderPayload(createModel(id, { provider }), level, {
        messages,
        thinking: { type: "enabled" },
      });
      expect(captured).toEqual({
        messages,
        enable_thinking: true,
        ...(effort ? { reasoning_effort: effort } : {}),
      });
      expect(messages[0]?.reasoning_content).toBe("original reasoning");
    },
  );

  it("honors caller budgets and reasoning overrides after async payload replacement", async () => {
    const capture = createAsyncPayloadCapture(createModel("qwen3.8-max"), "high", () => ({
      messages: [],
    }));
    for (const [replacement, expected] of [
      [{ thinking_budget: 512 }, { thinking_budget: 512, enable_thinking: true }],
      [{ reasoning_effort: "low" }, { reasoning_effort: "low", enable_thinking: true }],
      [{ reasoning_effort: "none" }, { enable_thinking: false }],
    ]) {
      const captured = await capture(async () => ({ ...replacement }));
      expect(captured).toEqual(expected);
    }
  });

  it("only registers for Qwen-family OpenAI-compatible providers", () => {
    const streamFn = wrapQwenProviderStream({
      provider: "qwencloud",
      modelId: "qwen3.6-plus",
      model: createModel(),
      streamFn: undefined,
    });
    expect(streamFn).toBeTypeOf("function");

    expect(
      wrapQwenProviderStream({
        provider: "openai",
        modelId: "gpt-5.4",
        model: createModel("gpt-5.4", { provider: "openai" }),
        streamFn: undefined,
      }),
    ).toBeUndefined();
  });

  it("strips DeepSeek V4 replay reasoning when Token Plan thinking is off", () => {
    const captured = captureProviderPayload(tokenPlanModel("deepseek-v4-pro"), "off", {
      messages: [
        { role: "assistant", content: "earlier answer", reasoning_content: "earlier reasoning" },
      ],
      thinking: { type: "disabled" },
      reasoning_effort: "max",
    });

    expect(captured).toStrictEqual({
      messages: [{ role: "assistant", content: "earlier answer" }],
      enable_thinking: false,
    });
  });

  it("backfills Kimi thinking tool-call replay", () => {
    const captured = captureProviderPayload(tokenPlanModel("kimi-k2.6"), "high", {
      thinking: { type: "enabled" },
      reasoning_effort: "high",
      tool_choice: "required",
      messages: [
        { role: "user", content: "continue" },
        readToolMessage(),
        readToolMessage("call_2", "native reasoning"),
        { role: "assistant", content: "done" },
      ],
    });

    expect(captured).toStrictEqual({
      messages: [
        { role: "user", content: "continue" },
        readToolMessage("call_1", ""),
        readToolMessage("call_2", "native reasoning"),
        { role: "assistant", content: "done" },
      ],
      enable_thinking: true,
      tool_choice: "auto",
    });
  });

  it.each([
    {
      modelId: "glm-5.2",
      thinkingLevel: "high",
      callerOverride: {
        enable_thinking: true,
        reasoning_effort: "none",
      },
      expected: { enable_thinking: true, reasoning_effort: "none" },
    },
    {
      modelId: "deepseek-v4-pro",
      thinkingLevel: "high",
      callerOverride: {
        enable_thinking: true,
        reasoning_effort: "xhigh",
      },
      expected: { enable_thinking: true, reasoning_effort: "max" },
    },
    {
      modelId: "qwen3.7-plus",
      thinkingLevel: "high",
      callerOverride: {
        enable_thinking: true,
        tool_choice: { type: "none" },
      },
      expected: { enable_thinking: true, tool_choice: "none" },
    },
  ] as const)(
    "reapplies Token Plan wire constraints after caller hooks for $modelId",
    ({ modelId, thinkingLevel, callerOverride, expected }) => {
      const captured = captureProviderPayload(
        tokenPlanModel(modelId),
        thinkingLevel,
        { messages: [] },
        {
          onPayload(payload) {
            Object.assign(payload as Record<string, unknown>, callerOverride);
          },
        },
      );

      expect(captured).toStrictEqual({ messages: [], ...expected });
    },
  );

  it("keeps pinned Kimi tool choice by disabling thinking before replay backfill", () => {
    const captured = captureProviderPayload(tokenPlanModel("kimi-k2.6"), "high", {
      messages: [readToolMessage()],
      tool_choice: { type: "function", function: { name: "read" } },
    });

    expect(captured).toStrictEqual({
      messages: [readToolMessage()],
      enable_thinking: false,
      tool_choice: { type: "function", function: { name: "read" } },
    });
  });

  it("leaves non-reasoning legacy custom models untouched", () => {
    const captured = captureProviderPayload(
      tokenPlanModel("custom-model", { provider: "bailian-token-plan", reasoning: false }),
      "high",
      {
        messages: [],
        reasoning_effort: "custom",
        tool_choice: "required",
      },
    );

    expect(captured).toStrictEqual({
      messages: [],
      reasoning_effort: "custom",
      tool_choice: "required",
    });
  });

  it.each([{ providerId: "bailian-token-plan", modelId: "qwen3.7-plus" }])(
    "preserves explicit qwen-chat-template transport for $providerId/$modelId",
    ({ providerId, modelId }) => {
      const captured = captureProviderPayload(
        tokenPlanModel(modelId, {
          provider: providerId,
          compat: { thinkingFormat: "qwen-chat-template" },
        }),
        "off",
        {
          chat_template_kwargs: { enable_thinking: true },
          enable_thinking: true,
        },
      );

      expect(captured).toStrictEqual({
        chat_template_kwargs: { enable_thinking: false, preserve_thinking: true },
      });
    },
  );

  it("defers explicit non-Qwen legacy thinking formats to the configured transport", () => {
    const baseStreamFn: StreamFn = () => ({}) as ReturnType<StreamFn>;
    const model = createModel("deepseek-v4-pro", { provider: "bailian-token-plan" });

    expect(
      wrapQwenProviderStream({
        provider: model.provider,
        modelId: model.id,
        model: { ...model, compat: { thinkingFormat: "deepseek" } },
        streamFn: baseStreamFn,
        thinkingLevel: "high",
      }),
    ).toBe(baseStreamFn);
  });

  it("forces GLM tool streaming after caller hooks", () => {
    const captured = captureProviderPayload(
      tokenPlanModel("glm-5.2"),
      "high",
      {
        messages: [],
        tools: [{ type: "function", function: { name: "read", parameters: {} } }],
      },
      {
        onPayload(payload) {
          (payload as Record<string, unknown>).tool_stream = false;
        },
      },
    );

    expect(captured).toStrictEqual({
      messages: [],
      tools: [{ type: "function", function: { name: "read", parameters: {} } }],
      enable_thinking: true,
      reasoning_effort: "high",
      tool_stream: true,
    });
  });

  it.each([
    {
      modelId: "glm-5.2",
      thinkingLevel: "max",
      expected: { messages: [], enable_thinking: true, reasoning_effort: "max" },
    },
  ] as const)(
    "preserves requested thinking when caller hooks replace the $modelId payload",
    async ({ modelId, thinkingLevel, expected }) => {
      const capture = createAsyncPayloadCapture(tokenPlanModel(modelId), thinkingLevel, () => ({
        messages: [{ role: "user", content: "hi" }],
      }));
      const captured = await capture(async () => ({ messages: [] }));

      expect(captured).toStrictEqual(expected);
    },
  );

  it.each([
    {
      modelId: "glm-5.2",
      thinkingLevel: "max",
      options: { reasoning: "medium" },
      expected: { enable_thinking: true, reasoning_effort: "medium" },
    },
  ] as const)(
    "uses the runtime reasoning override for $modelId ($thinkingLevel)",
    ({ modelId, thinkingLevel, options, expected }) => {
      const captured = captureProviderPayload(tokenPlanModel(modelId), thinkingLevel, {}, options);

      expect(captured).toStrictEqual(expected);
    },
  );

  it.each([
    ["bailian-token-plan", "glm-5.1", "max", "xhigh"],
    ["bailian-token-plan", "glm-5.2", "off", undefined],
  ] as const)(
    "maps Token Plan GLM reasoning for %s/%s at %s",
    (providerId, modelId, thinkingLevel, expectedEffort) => {
      const captured = captureProviderPayload(
        tokenPlanModel(modelId, { provider: providerId }),
        thinkingLevel,
        {
          messages: [
            {
              role: "assistant",
              content: "earlier answer",
              reasoning_content: "earlier reasoning",
            },
          ],
          thinking: { type: "enabled" },
          reasoning_effort: "stale",
        },
      );

      expect(captured).toStrictEqual({
        messages: [
          { role: "assistant", content: "earlier answer", reasoning_content: "earlier reasoning" },
        ],
        enable_thinking: thinkingLevel !== "off",
        ...(expectedEffort ? { reasoning_effort: expectedEffort } : {}),
      });
    },
  );
});
