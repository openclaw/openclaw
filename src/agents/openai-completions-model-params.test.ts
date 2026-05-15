import { describe, expect, it } from "vitest";
import { applyOpenAICompletionsModelParams } from "./openai-completions-model-params.js";

describe("applyOpenAICompletionsModelParams", () => {
  it("applies raw OpenAI completions model params and normalizes max token aliases", () => {
    const payload: Record<string, unknown> = {
      max_tokens: 32_000,
    };

    applyOpenAICompletionsModelParams(payload, {
      params: {
        max_completion_tokens: 64_000,
        temperature: 0.2,
      },
    });

    expect(payload).toMatchObject({
      max_completion_tokens: 64_000,
      temperature: 0.2,
    });
    expect(payload).not.toHaveProperty("max_tokens");
  });

  it("does not forward reserved, prototype-polluting, or OpenClaw control params", () => {
    const payload: Record<string, unknown> = {};

    applyOpenAICompletionsModelParams(payload, {
      params: {
        __proto__: { polluted: true },
        constructor: "bad",
        model: "bad",
        messages: [],
        prototype: "bad",
        stream: false,
        stream_options: {},
        extra_body: { thinking: { type: "enabled" } },
        extraBody: { store: false },
        fastMode: true,
        fast_mode: true,
        chat_template_kwargs: { enable_thinking: false },
        chatTemplateKwargs: { enable_thinking: false },
        reasoning_effort: "high",
        reasoningEffort: "high",
        service_tier: "flex",
        serviceTier: "flex",
        transport: "websocket",
        openaiWsWarmup: true,
        cachedContent: "cached",
        responseCache: true,
        text_verbosity: "low",
        top_p: 0.9,
      },
    });

    expect(payload).toEqual({ top_p: 0.9 });
    expect(Object.getPrototypeOf(payload)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
