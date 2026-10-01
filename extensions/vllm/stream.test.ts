import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { Context, Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { createVllmQwenThinkingWrapper, wrapVllmProviderStream } from "./stream.js";

function capturePayload(params: {
  format: "chat-template" | "top-level";
  thinkingLevel?: "off" | "low" | "medium" | "high" | "xhigh" | "max";
  initialPayload?: Record<string, unknown>;
  model?: Partial<Model<"openai-completions">>;
}): Record<string, unknown> | undefined {
  let captured: Record<string, unknown> | undefined;
  const baseStreamFn: StreamFn = (_model, _context, options) => {
    const payload = { ...params.initialPayload };
    options?.onPayload?.(payload, _model);
    captured = payload;
    return {} as ReturnType<StreamFn>;
  };

  const wrapped = createVllmQwenThinkingWrapper({
    baseStreamFn,
    format: params.format,
    thinkingLevel: params.thinkingLevel ?? "high",
  });
  void wrapped(
    {
      api: "openai-completions",
      provider: "vllm",
      id: "Qwen/Qwen3-8B",
      reasoning: true,
      ...params.model,
    } as Model<"openai-completions">,
    { messages: [] } as Context,
    {},
  );

  return captured;
}

describe("createVllmQwenThinkingWrapper", () => {
  it("maps Qwen top-level thinking format to enable_thinking", () => {
    expect(capturePayload({ format: "top-level", thinkingLevel: "off" })).toEqual({
      enable_thinking: false,
    });
    expect(capturePayload({ format: "top-level", thinkingLevel: "high" })).toEqual({
      enable_thinking: true,
    });
  });

  it("patches configured Qwen models unless reasoning is explicitly disabled", () => {
    expect(capturePayload({ format: "chat-template", model: { reasoning: undefined } })).toEqual({
      chat_template_kwargs: {
        enable_thinking: true,
        preserve_thinking: true,
      },
    });
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
});

describe("vLLM provider thinking composition", () => {
  function captureProviderPayload(params: {
    thinkingLevel?: "off" | "low" | "medium" | "high" | "xhigh" | "max";
    initialPayload?: Record<string, unknown>;
    contextModelId?: string;
    model?: Partial<Model<"openai-completions">>;
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
      id: "nemotron-3-super",
      reasoning: true,
      ...params.model,
    } as Model<"openai-completions">;
    const wrapped = wrapVllmProviderStream({
      provider: "vllm",
      modelId: params.contextModelId ?? model.id,
      model,
      thinkingLevel: params.thinkingLevel ?? "high",
      streamFn: baseStreamFn,
    } as never);
    void (wrapped ?? baseStreamFn)(model, { messages: [] } as Context, {});

    return captured;
  }

  it("injects Nemotron 3 chat-template kwargs when thinking is off", () => {
    expect(captureProviderPayload({ thinkingLevel: "off" })).toEqual({
      chat_template_kwargs: {
        enable_thinking: false,
        force_nonempty_content: true,
      },
    });
  });

  it("does not inject Nemotron 3 chat-template kwargs when thinking is enabled", () => {
    expect(
      captureProviderPayload({
        thinkingLevel: "low",
        initialPayload: { temperature: 0.2 },
      }),
    ).toStrictEqual({ temperature: 0.2 });
  });

  it("preserves existing Nemotron 3 chat-template kwargs over defaults", () => {
    expect(
      captureProviderPayload({
        thinkingLevel: "off",
        initialPayload: {
          chat_template_kwargs: {
            enable_thinking: true,
          },
        },
      }),
    ).toEqual({
      chat_template_kwargs: {
        enable_thinking: true,
        force_nonempty_content: true,
      },
    });
  });

  it("composes Qwen thinking with runtime Nemotron payload defaults", () => {
    expect(
      captureProviderPayload({
        thinkingLevel: "off",
        contextModelId: "Qwen/Qwen3-8B",
        model: {
          compat: { thinkingFormat: "qwen-chat-template" },
        },
      }),
    ).toEqual({
      chat_template_kwargs: {
        enable_thinking: false,
        preserve_thinking: true,
        force_nonempty_content: true,
      },
    });
  });
});

describe("wrapVllmProviderStream", () => {
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
        streamFn: undefined,
      } as never),
    ).toBeUndefined();
  });

  it("uses model compat to map request thinking and strip OpenAI reasoning fields", () => {
    let captured: Record<string, unknown> = {};
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      const payload = {
        reasoning_effort: "high",
        reasoning: { effort: "high" },
        reasoningEffort: "high",
      };
      options?.onPayload?.(payload, _model);
      captured = payload;
      return {} as ReturnType<StreamFn>;
    };
    const model = {
      api: "openai-completions",
      provider: "vllm",
      id: "Qwen/Qwen3-8B",
      reasoning: true,
      compat: { thinkingFormat: "qwen-chat-template" },
    } as unknown as Model<"openai-completions">;
    const wrapped = wrapVllmProviderStream({
      provider: "vllm",
      modelId: "Qwen/Qwen3-8B",
      extraParams: {},
      thinkingLevel: "high",
      model,
      streamFn: baseStreamFn,
    } as never);

    expect(wrapped).toBeTypeOf("function");
    void wrapped?.(model, { messages: [] } as Context, { reasoning: "off" });

    expect(captured).toEqual({
      chat_template_kwargs: {
        enable_thinking: false,
        preserve_thinking: true,
      },
    });
  });

  it("skips non-vLLM providers even with Qwen compat configured", () => {
    expect(
      wrapVllmProviderStream({
        provider: "openai",
        modelId: "gpt-5.4",
        extraParams: {},
        model: {
          api: "openai-completions",
          provider: "openai",
          id: "gpt-5.4",
          compat: { thinkingFormat: "qwen-chat-template" },
        } as Model<"openai-completions">,
        streamFn: undefined,
      } as never),
    ).toBeUndefined();
  });
});
