import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { Context, Model } from "openclaw/plugin-sdk/llm";
import { expect, it } from "vitest";
import { createVllmQwenThinkingWrapper, wrapVllmProviderStream } from "./stream.js";

const baseModel = {
  api: "openai-completions",
  provider: "vllm",
  id: "nemotron-3-super",
  reasoning: true,
} as Model<"openai-completions">;
const qwenThinking = { enable_thinking: true, preserve_thinking: true };
const disabledEffort = { supportedReasoningEfforts: ["high"], supportsReasoningEffort: false };
type PayloadCase = {
  format?: "chat-template" | "top-level";
  thinkingLevel?: "off" | "low" | "medium" | "high" | "xhigh" | "max";
  initialPayload?: Record<string, unknown>;
  contextModelId?: string;
  model?: Partial<Model<"openai-completions">>;
  reasoning?: NonNullable<Parameters<StreamFn>[2]>["reasoning"];
  extraParams?: Record<string, unknown>;
};
function expectPayload(params: PayloadCase, expected: Record<string, unknown>, template = true) {
  let captured: Record<string, unknown> | undefined;
  const baseStreamFn: StreamFn = (_model, _context, options) => {
    const payload = { ...params.initialPayload };
    options?.onPayload?.(payload, _model);
    captured = payload;
    return {} as ReturnType<StreamFn>;
  };

  const model = { ...baseModel, ...params.model };
  const thinkingLevel = params.thinkingLevel ?? "high";
  const wrapped = params.format
    ? createVllmQwenThinkingWrapper({ baseStreamFn, format: params.format, thinkingLevel })
    : wrapVllmProviderStream({
        provider: "vllm",
        modelId: params.contextModelId ?? model.id,
        model,
        thinkingLevel,
        streamFn: baseStreamFn,
        extraParams: params.extraParams,
      } as never);
  // Bypass cases still invoke the base stream and capture its unchanged payload.
  void (wrapped ?? baseStreamFn)(model, { messages: [] } as Context, {
    reasoning: params.reasoning,
  });
  expect(captured).toStrictEqual(template ? { chat_template_kwargs: expected } : expected);
}

it.each([{ reasoning: false }, { api: "openai-responses" as never }])(
  "leaves unsupported Qwen model %j unchanged",
  (model) => {
    expectPayload(
      { format: "chat-template", model, initialPayload: { temperature: 0.2 } },
      { temperature: 0.2 },
      false,
    );
  },
);

it.each(["qwen", "qwen-chat-template"] as const)("sends efforts in %s", (thinkingFormat) => {
  for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
    const enabled = level !== "off";
    const effort = enabled ? { reasoning_effort: level } : {};
    const thinking = { enable_thinking: enabled, ...effort };
    expectPayload(
      {
        thinkingLevel: "off",
        reasoning: level,
        initialPayload: {
          reasoning_effort: "high",
          reasoning: { effort: "high" },
          reasoningEffort: "high",
        },
        model: {
          id: "qwen3:8b",
          compat: {
            thinkingFormat,
            supportedReasoningEfforts: ["minimal", "low", "medium", "high", "xhigh", "max"],
          },
        },
      },
      thinkingFormat === "qwen"
        ? thinking
        : { chat_template_kwargs: { ...thinking, preserve_thinking: true } },
      false,
    );
  }
});

it.each(["compat", "model"] as const)("resolves %s maps and explicit disablement", (source) => {
  const mapping = { low: "LOW", high: "HIGH" };
  for (const supportsReasoningEffort of [true, false]) {
    expectPayload(
      {
        reasoning: "high",
        model: {
          id: "qwen3:8b",
          ...(source === "model" ? { thinkingLevelMap: mapping } : {}),
          compat: {
            thinkingFormat: "qwen-chat-template",
            supportsReasoningEffort,
            supportedReasoningEfforts: ["LOW", "HIGH"],
            ...(source === "compat" ? { reasoningEffortMap: mapping } : {}),
          },
        },
      },
      { ...qwenThinking, ...(supportsReasoningEffort ? { reasoning_effort: "HIGH" } : {}) },
    );
  }
});

it.each(["off", "max"] as const)("maps DeepSeek %s and strips hosted fields", (reasoning) => {
  expectPayload(
    {
      contextModelId: "nemotron-3-super",
      reasoning,
      initialPayload: { thinking: { type: "enabled" }, reasoning_effort: "high" },
      model: {
        id: "deepseek-ai/DeepSeek-V4-Flash",
        compat: { supportedReasoningEfforts: ["high", "max"] },
      },
    },
    {
      thinking: reasoning !== "off",
      enable_thinking: reasoning !== "off",
      ...(reasoning !== "off" ? { reasoning_effort: reasoning } : {}),
    },
  );
});

it.each<[PayloadCase, Record<string, unknown>]>([
  [{ format: "chat-template" }, qwenThinking],
  [{ format: "chat-template", reasoning: "high", model: { compat: disabledEffort } }, qwenThinking],
  [
    {
      initialPayload: {
        chat_template_kwargs: { thinking: false, enable_thinking: false, drop_thinking: false },
      },
      model: { id: "DeepSeek-V4-Flash" },
    },
    { thinking: false, enable_thinking: false, drop_thinking: false, reasoning_effort: "high" },
  ],
  ...[["invalid"], false].map((template): [PayloadCase, Record<string, unknown>] => [
    {
      thinkingLevel: "off",
      model: { id: "yk_nemotron-3-super" },
      initialPayload: { chat_template_kwargs: template },
    },
    { enable_thinking: false, force_nonempty_content: true },
  ]),
  [
    {
      thinkingLevel: "off",
      contextModelId: "Qwen/Qwen3-8B",
      model: { compat: { thinkingFormat: "qwen-chat-template" } },
    },
    { enable_thinking: false, preserve_thinking: true, force_nonempty_content: true },
  ],
])("patches template defaults for %j", (params, expected) => expectPayload(params, expected));

it("ignores request params when Qwen thinking format compat is not configured", () => {
  expectPayload(
    {
      extraParams: { qwenThinkingFormat: "chat-template" },
      model: { id: "Qwen/Qwen3-8B" },
    },
    {},
    false,
  );
});
