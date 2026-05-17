import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Context, Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { createQwenThinkingWrapper, wrapQwenProviderStream } from "./stream.js";

function capturePayload(params: {
  thinkingLevel?: "off" | "low" | "medium" | "high" | "xhigh" | "max";
  reasoning?: unknown;
  initialPayload?: Record<string, unknown>;
  model?: Partial<Model<"openai-completions">>;
}): Record<string, unknown> {
  let captured: Record<string, unknown> = {};
  const baseStreamFn: StreamFn = (_model, _context, options) => {
    const payload = { ...params.initialPayload };
    options?.onPayload?.(payload, _model);
    captured = payload;
    return {} as ReturnType<StreamFn>;
  };

  const wrapped = createQwenThinkingWrapper(baseStreamFn, params.thinkingLevel ?? "high");
  void wrapped(
    {
      api: "openai-completions",
      provider: "qwen",
      id: "qwen3.6-plus",
      reasoning: true,
      ...params.model,
    } as Model<"openai-completions">,
    { messages: [] } as Context,
    params.reasoning === undefined ? {} : ({ reasoning: params.reasoning } as never),
  );

  return captured;
}

describe("createQwenThinkingWrapper", () => {
  it("maps disabled thinking to Qwen top-level enable_thinking", () => {
    const payload = capturePayload({
      reasoning: "none",
      initialPayload: {
        reasoning_effort: "high",
        reasoning: { effort: "high" },
        reasoningEffort: "high",
      },
    });

    expect(payload).toEqual({ enable_thinking: false });
  });

  it("maps enabled thinking to Qwen top-level enable_thinking", () => {
    expect(capturePayload({ reasoning: "medium" })).toEqual({ enable_thinking: true });
  });

  it("falls back to the session thinking level", () => {
    expect(capturePayload({ thinkingLevel: "off" })).toEqual({ enable_thinking: false });
    expect(capturePayload({ thinkingLevel: "high" })).toEqual({ enable_thinking: true });
  });

  it("skips non-reasoning and non-completions models", () => {
    expect(capturePayload({ model: { reasoning: false } })).toStrictEqual({});
    expect(capturePayload({ model: { api: "openai-responses" as never } })).toStrictEqual({});
  });

  describe("qwen-chat-template thinking format", () => {
    const qwenChatTemplateModel: Partial<Model<"openai-completions">> = {
      compat: { thinkingFormat: "qwen-chat-template" } as Model<"openai-completions">["compat"],
    };

    it("mirrors disabled session thinking into chat_template_kwargs.enable_thinking", () => {
      const payload = capturePayload({
        thinkingLevel: "off",
        model: qwenChatTemplateModel,
        // The transport's qwen-chat-template formatter writes
        // enable_thinking: true when no explicit reasoning is in options.
        initialPayload: { chat_template_kwargs: { enable_thinking: true } },
      });

      expect(payload).toEqual({
        enable_thinking: false,
        chat_template_kwargs: { enable_thinking: false },
      });
    });

    it("mirrors enabled session thinking into chat_template_kwargs.enable_thinking", () => {
      const payload = capturePayload({
        thinkingLevel: "medium",
        model: qwenChatTemplateModel,
      });

      expect(payload).toEqual({
        enable_thinking: true,
        chat_template_kwargs: { enable_thinking: true },
      });
    });

    it("preserves unrelated chat_template_kwargs entries", () => {
      const payload = capturePayload({
        thinkingLevel: "off",
        model: qwenChatTemplateModel,
        initialPayload: {
          chat_template_kwargs: { enable_thinking: true, custom_kwarg: "keep" },
        },
      });

      expect(payload).toEqual({
        enable_thinking: false,
        chat_template_kwargs: { enable_thinking: false, custom_kwarg: "keep" },
      });
    });

    it("lets explicit request reasoning override the session thinking level", () => {
      const payload = capturePayload({
        thinkingLevel: "off",
        reasoning: "high",
        model: qwenChatTemplateModel,
        initialPayload: { chat_template_kwargs: { enable_thinking: true } },
      });

      expect(payload).toEqual({
        enable_thinking: true,
        chat_template_kwargs: { enable_thinking: true },
      });
    });

    it("does not touch chat_template_kwargs for non-chat-template Qwen models", () => {
      expect(capturePayload({ thinkingLevel: "off" })).toEqual({ enable_thinking: false });
    });
  });
});

describe("wrapQwenProviderStream", () => {
  it("only registers for Qwen-family OpenAI-compatible providers", () => {
    expect(
      wrapQwenProviderStream({
        provider: "qwencloud",
        modelId: "qwen3.6-plus",
        model: {
          api: "openai-completions",
          provider: "qwen",
          id: "qwen3.6-plus",
          reasoning: true,
        } as Model<"openai-completions">,
        streamFn: undefined,
      } as never),
    ).toBeTypeOf("function");

    expect(
      wrapQwenProviderStream({
        provider: "openai",
        modelId: "gpt-5.4",
        model: {
          api: "openai-completions",
          provider: "openai",
          id: "gpt-5.4",
        } as Model<"openai-completions">,
        streamFn: undefined,
      } as never),
    ).toBeUndefined();
  });
});
