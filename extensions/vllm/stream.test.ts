import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { Context, Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { createVllmQwenThinkingWrapper, wrapVllmProviderStream } from "./stream.js";

function capturePayload(params: {
  format?: "chat-template" | "top-level";
  thinkingLevel?: "off" | "low" | "medium" | "high" | "xhigh" | "max";
  initialPayload?: Record<string, unknown>;
  contextModelId?: string;
  model?: Partial<Model<"openai-completions">>;
  reasoning?: NonNullable<Parameters<StreamFn>[2]>["reasoning"];
}): Record<string, unknown> | undefined {
  let captured: Record<string, unknown> | undefined;
  const baseStreamFn: StreamFn = (_model, _context, options) => {
    const payload = { ...params.initialPayload };
    options?.onPayload?.(payload, _model);
    captured = payload;
    return {} as ReturnType<StreamFn>;
  };

  const model = {
    api: "openai-completions",
    provider: "vllm",
    id: params.format ? "Qwen/Qwen3-8B" : "nemotron-3-super",
    reasoning: true,
    ...params.model,
  } as Model<"openai-completions">;
  const thinkingLevel = params.thinkingLevel ?? "high";
  const wrapped = params.format
    ? createVllmQwenThinkingWrapper({ baseStreamFn, format: params.format, thinkingLevel })
    : wrapVllmProviderStream({
        provider: "vllm",
        modelId: params.contextModelId ?? model.id,
        model,
        thinkingLevel,
        streamFn: baseStreamFn,
      } as never);
  // Bypass cases still invoke the base stream and capture its unchanged payload.
  void (wrapped ?? baseStreamFn)(model, { messages: [] } as Context, {
    reasoning: params.reasoning,
  });
  return captured;
}

function expectTemplate(
  params: Parameters<typeof capturePayload>[0],
  kwargs: Record<string, unknown>,
) {
  expect(capturePayload(params)).toEqual({ chat_template_kwargs: kwargs });
}

describe("vLLM streaming", () => {
  it("patches configured Qwen reasoning models and skips non-reasoning models", () => {
    expectTemplate({ format: "chat-template" }, { enable_thinking: true, preserve_thinking: true });
    expect(
      capturePayload({
        format: "chat-template",
        model: { reasoning: false },
        initialPayload: { temperature: 0.2 },
      }),
    ).toStrictEqual({ temperature: 0.2 });
  });

  it("skips non-completions models", () => {
    expect(
      capturePayload({
        format: "chat-template",
        model: { api: "openai-responses" as never },
        initialPayload: { temperature: 0.2 },
      }),
    ).toStrictEqual({ temperature: 0.2 });
  });

  it.each(["qwen", "qwen-chat-template"] as const)("sends efforts in %s", (thinkingFormat) => {
    for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
      const enabled = level !== "off";
      const effort = enabled ? { reasoning_effort: level } : {};
      const thinking = { enable_thinking: enabled, ...effort };
      expect(
        capturePayload({
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
        }),
      ).toEqual(
        thinkingFormat === "qwen"
          ? thinking
          : { chat_template_kwargs: { ...thinking, preserve_thinking: true } },
      );
    }
  });

  it.each(["compat", "model"] as const)("resolves %s maps and explicit disablement", (source) => {
    const mapping = { low: "LOW", high: "HIGH" };
    for (const supportsReasoningEffort of [true, false]) {
      expectTemplate(
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
        {
          enable_thinking: true,
          preserve_thinking: true,
          ...(supportsReasoningEffort ? { reasoning_effort: "HIGH" } : {}),
        },
      );
    }
  });

  it.each(["off", "max"] as const)("maps DeepSeek %s and strips hosted fields", (reasoning) => {
    expectTemplate(
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

  it("preserves explicit DeepSeek template kwargs over generated defaults", () => {
    expectTemplate(
      {
        initialPayload: {
          chat_template_kwargs: { thinking: false, enable_thinking: false, drop_thinking: false },
        },
        model: { id: "DeepSeek-V4-Flash" },
      },
      { thinking: false, enable_thinking: false, drop_thinking: false, reasoning_effort: "high" },
    );
  });

  it("disables thinking for an underscore-prefixed Nemotron alias", () => {
    expectTemplate(
      { thinkingLevel: "off", model: { id: "yk_nemotron-3-super" } },
      { enable_thinking: false, force_nonempty_content: true },
    );
  });

  it("composes Qwen thinking with runtime Nemotron payload defaults", () => {
    expectTemplate(
      {
        thinkingLevel: "off",
        contextModelId: "Qwen/Qwen3-8B",
        model: { compat: { thinkingFormat: "qwen-chat-template" } },
      },
      { enable_thinking: false, preserve_thinking: true, force_nonempty_content: true },
    );
  });

  it("ignores request params when Qwen thinking format compat is not configured", () => {
    expect(
      wrapVllmProviderStream({
        provider: "vllm",
        modelId: "Qwen/Qwen3-8B",
        extraParams: { qwenThinkingFormat: "chat-template" },
        model: {
          api: "openai-completions",
          provider: "vllm",
          id: "Qwen/Qwen3-8B",
          reasoning: true,
        } as Model<"openai-completions">,
      } as never),
    ).toBeUndefined();
  });
});
