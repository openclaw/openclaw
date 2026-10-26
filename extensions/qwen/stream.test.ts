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

function wrap(model: Model, streamFn?: StreamFn, thinkingLevel?: ThinkingLevel) {
  return wrapQwenProviderStream({
    provider: model.provider,
    modelId: model.id,
    model,
    streamFn,
    thinkingLevel,
  });
}

function overridePayload(patch: Record<string, unknown>): NonNullable<Parameters<StreamFn>[2]> {
  return {
    onPayload: (payload) => {
      if (!payload || typeof payload !== "object") {
        throw new Error("Expected a Qwen request payload");
      }
      Object.assign(payload, patch);
    },
  };
}

async function captureProviderPayload(
  model: Model,
  thinkingLevel: ThinkingLevel,
  payload: Record<string, unknown> = {},
  options: NonNullable<Parameters<StreamFn>[2]> & { reasoningEffort?: ThinkingLevel } = {},
): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> | undefined;
  const streamFn: StreamFn = async (_model, _context, streamOptions) => {
    const replacement = await streamOptions?.onPayload?.(payload, _model);
    captured =
      replacement && typeof replacement === "object"
        ? (replacement as Record<string, unknown>)
        : payload;
    return {} as Awaited<ReturnType<StreamFn>>;
  };
  await wrap(model, streamFn, thinkingLevel)?.(model, { messages: [] }, options);
  if (!captured) {
    throw new Error("Qwen wrapper did not invoke the underlying stream");
  }
  return captured;
}

function readToolMessage(id = "call_1", reasoningContent?: string) {
  return {
    role: "assistant",
    tool_calls: [{ id, type: "function", function: { name: "read", arguments: "{}" } }],
    ...(reasoningContent === undefined ? {} : { reasoning_content: reasoningContent }),
  };
}

describe("Qwen streams", () => {
  it.each([
    ["https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen3.8-flash", "medium"],
    ["https://dashscope-intl.aliyuncs.com/compatible-mode/v1", "qwen3.8-flash", "medium"],
    ["https://coding.dashscope.aliyuncs.com/v1", "qwen3.8-flash", "medium"],
    ["https://coding-intl.dashscope.aliyuncs.com/v1", "qwen3.8-flash", "medium"],
    [
      "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
      "deepseek-v4-pro",
      "high",
    ],
    [
      "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
      "deepseek-v4-pro",
      "high",
    ],
  ])("translates thinking for a custom provider on %s", async (baseUrl, modelId, effort) => {
    const captured = await captureProviderPayload(
      createModel(modelId, { provider: "custom-dashscope", baseUrl }),
      "medium",
      { messages: [], thinking: { type: "enabled" } },
    );
    expect(captured).toStrictEqual({
      messages: [],
      enable_thinking: true,
      reasoning_effort: effort,
    });
  });

  it("does not apply Qwen payload policy to an unrelated custom endpoint", () => {
    expect(wrap(createModel("qwen3.8-flash", { provider: "custom-provider" }))).toBeUndefined();
  });

  it("uses the runtime model qwen-chat-template format when the wrapper context omits it", () => {
    const payload = { chat_template_kwargs: { enable_thinking: true }, enable_thinking: true };
    const stream: StreamFn = (model, _context, options) => {
      options?.onPayload?.(payload, model);
      return {} as ReturnType<StreamFn>;
    };
    void createQwenThinkingWrapper(stream, "off")(
      createModel(undefined, { compat: { thinkingFormat: "qwen-chat-template" } }),
      { messages: [] },
    );
    expect(payload).toEqual({
      chat_template_kwargs: { enable_thinking: false, preserve_thinking: true },
    });
  });
  it.each([
    ["qwen3.8-flash", "medium", "medium", "original reasoning", "qwen-token-plan"],
    ["deepseek-v4-pro", "off", undefined, undefined, "qwen-token-plan"],
    ["glm-5.1", "max", "xhigh", "original reasoning", "bailian-token-plan"],
    ["glm-5.2", "off", undefined, "original reasoning", "bailian-token-plan"],
  ] as const)("maps %s replay at %s", async (id, level, effort, reasoning, provider) => {
    const message = { role: "assistant", content: "done" };
    const captured = await captureProviderPayload(tokenPlanModel(id, { provider }), level, {
      messages: [{ ...message, reasoning_content: "original reasoning" }],
      thinking: { type: "enabled" },
      reasoning_effort: "stale",
    });
    expect(captured).toStrictEqual({
      messages: [
        { ...message, ...(reasoning === undefined ? {} : { reasoning_content: reasoning }) },
      ],
      enable_thinking: level !== "off",
      ...(effort ? { reasoning_effort: effort } : {}),
    });
  });

  it.each(["in-place mutation", "sync replacement", "async replacement"] as const)(
    "honors caller budgets and reasoning overrides after %s",
    async (mode) => {
      for (const [replacement, expected] of [
        [{ thinking_budget: 512 }, { thinking_budget: 512, enable_thinking: true }],
        [{ reasoning_effort: "low" }, { reasoning_effort: "low", enable_thinking: true }],
        [{ reasoning_effort: "none" }, { enable_thinking: false }],
      ]) {
        const captured = await captureProviderPayload(
          createModel("qwen3.8-max"),
          "high",
          { messages: [] },
          {
            onPayload: (payload) => {
              expect(payload).toEqual({
                messages: [],
                enable_thinking: true,
                reasoning_effort: "xhigh",
              });
              if (mode === "in-place mutation") {
                if (!payload || typeof payload !== "object") {
                  throw new Error("Expected a Qwen request payload");
                }
                Object.assign(payload, replacement);
                return undefined;
              }
              const next = { ...replacement };
              return mode === "async replacement" ? Promise.resolve(next) : next;
            },
          },
        );
        expect(captured).toEqual({
          ...(mode === "in-place mutation" ? { messages: [] } : {}),
          ...expected,
        });
      }
    },
  );

  it("only registers for Qwen-family OpenAI-compatible providers", () => {
    expect(wrap(createModel(undefined, { provider: "qwencloud" }))).toBeTypeOf("function");
    expect(wrap(createModel("gpt-5.4", { provider: "openai" }))).toBeUndefined();
  });

  it.each([false, true])("normalizes Kimi replay with pinned tool choice: %s", async (pinned) => {
    const user = { role: "user", content: "continue" };
    const done = { role: "assistant", content: "done" };
    const native = readToolMessage("call_2", "native reasoning");
    const toolChoice = { type: "function", function: { name: "read" } };
    const captured = await captureProviderPayload(tokenPlanModel("kimi-k2.6"), "high", {
      thinking: { type: "enabled" },
      reasoning_effort: "high",
      tool_choice: pinned ? toolChoice : "required",
      messages: structuredClone([user, readToolMessage(), native, done]),
    });
    expect(captured).toStrictEqual({
      messages: [user, pinned ? readToolMessage() : readToolMessage("call_1", ""), native, done],
      enable_thinking: !pinned,
      tool_choice: pinned ? toolChoice : "auto",
    });
  });

  it.each([
    ["glm-5.2", { reasoning_effort: "none" }, { reasoning_effort: "none" }],
    ["deepseek-v4-pro", { reasoning_effort: "xhigh" }, { reasoning_effort: "max" }],
    ["qwen3.7-plus", { tool_choice: { type: "none" } }, { tool_choice: "none" }],
  ] as const)(
    "reapplies Token Plan wire constraints after caller hooks for %s",
    async (modelId, callerOverride, expected) => {
      const captured = await captureProviderPayload(
        tokenPlanModel(modelId),
        "high",
        { messages: [] },
        overridePayload({ enable_thinking: true, ...callerOverride }),
      );

      expect(captured).toStrictEqual({ messages: [], enable_thinking: true, ...expected });
    },
  );

  it("leaves non-reasoning legacy custom models untouched", async () => {
    const payload = { messages: [], reasoning_effort: "custom", tool_choice: "required" };
    const captured = await captureProviderPayload(
      tokenPlanModel("custom-model", { provider: "bailian-token-plan", reasoning: false }),
      "high",
      structuredClone(payload),
    );

    expect(captured).toStrictEqual(payload);
  });

  it("preserves explicit qwen-chat-template transport for bailian-token-plan/qwen3.7-plus", async () => {
    const captured = await captureProviderPayload(
      tokenPlanModel("qwen3.7-plus", {
        provider: "bailian-token-plan",
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
  });

  it("defers explicit non-Qwen legacy thinking formats to the configured transport", () => {
    const baseStreamFn: StreamFn = () => ({}) as ReturnType<StreamFn>;
    const model = createModel("deepseek-v4-pro", { provider: "bailian-token-plan" });

    expect(wrap({ ...model, compat: { thinkingFormat: "deepseek" } }, baseStreamFn, "high")).toBe(
      baseStreamFn,
    );
  });

  it("forces GLM tool streaming after caller hooks", async () => {
    const tools = [{ type: "function", function: { name: "read", parameters: {} } }];
    const captured = await captureProviderPayload(
      tokenPlanModel("glm-5.2"),
      "high",
      { messages: [], tools: structuredClone(tools) },
      overridePayload({ tool_stream: false }),
    );

    expect(captured).toStrictEqual({
      messages: [],
      tools,
      enable_thinking: true,
      reasoning_effort: "high",
      tool_stream: true,
    });
  });

  it("preserves requested thinking when caller hooks replace the glm-5.2 payload", async () => {
    const captured = await captureProviderPayload(
      tokenPlanModel("glm-5.2"),
      "max",
      {
        messages: [{ role: "user", content: "hi" }],
      },
      { onPayload: async () => ({ messages: [] }) },
    );

    expect(captured).toStrictEqual({
      messages: [],
      enable_thinking: true,
      reasoning_effort: "max",
    });
  });

  it("uses the runtime reasoning override for glm-5.2 (max)", async () => {
    const captured = await captureProviderPayload(
      tokenPlanModel("glm-5.2"),
      "max",
      {},
      { reasoning: "medium" },
    );
    expect(captured).toStrictEqual({ enable_thinking: true, reasoning_effort: "medium" });
  });
});
