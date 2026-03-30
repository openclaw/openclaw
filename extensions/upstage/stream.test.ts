import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Context, Model } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { createUpstagePayloadCompatibilityWrapper, prepareUpstageExtraParams } from "./stream.js";

describe("upstage extra params", () => {
  it("keeps only documented Upstage-compatible extra params", () => {
    expect(
      prepareUpstageExtraParams({
        maxTokens: 1024,
        topP: 0.8,
        promptCacheKey: "abc",
        serviceTier: "priority",
        prediction: { type: "content" },
      }),
    ).toEqual({
      maxTokens: 1024,
      topP: 0.8,
      promptCacheKey: "abc",
    });
  });
});

describe("upstage stream wrapper", () => {
  it("normalizes aliases and strips unsupported payload fields", () => {
    const payload: Record<string, unknown> = {
      model: "solar-pro3",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 512,
      topP: 0.9,
      toolChoice: "auto",
      promptCacheKey: "cache-key",
      parallelToolCalls: true,
      reasoningEffort: "high",
      reasoning: { effort: "high" },
      serviceTier: "priority",
      store: false,
      metadata: { trace: "1" },
      prompt_cache_retention: "short",
      tools: [
        {
          type: "function",
          function: {
            name: "lookup",
            parameters: { type: "object", properties: {} },
            strict: true,
          },
        },
      ],
    };
    const baseStreamFn: StreamFn = (_model, _context, options) => {
      options?.onPayload?.(payload, {} as Model<"openai-completions">);
      return {} as ReturnType<StreamFn>;
    };

    const wrapped = createUpstagePayloadCompatibilityWrapper(baseStreamFn);
    void wrapped(
      {
        api: "openai-completions",
        provider: "upstage",
        id: "solar-pro3",
      } as Model<"openai-completions">,
      { messages: [] } as Context,
      {},
    );

    expect(payload).toMatchObject({
      model: "solar-pro3",
      max_tokens: 512,
      top_p: 0.9,
      tool_choice: "auto",
      prompt_cache_key: "cache-key",
      parallel_tool_calls: true,
      reasoning_effort: "high",
    });
    expect(payload).not.toHaveProperty("maxTokens");
    expect(payload).not.toHaveProperty("topP");
    expect(payload).not.toHaveProperty("toolChoice");
    expect(payload).not.toHaveProperty("promptCacheKey");
    expect(payload).not.toHaveProperty("parallelToolCalls");
    expect(payload).not.toHaveProperty("reasoningEffort");
    expect(payload).not.toHaveProperty("reasoning");
    expect(payload).not.toHaveProperty("serviceTier");
    expect(payload).not.toHaveProperty("store");
    expect(payload).not.toHaveProperty("metadata");
    expect(payload).not.toHaveProperty("prompt_cache_retention");
    expect((payload.tools as Array<Record<string, unknown>>)[0]?.function).not.toHaveProperty(
      "strict",
    );
  });
});
