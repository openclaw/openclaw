import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { buildOpenAICompletionsParams } from "openclaw/plugin-sdk/provider-transport-runtime";
import { createZeroUsageFixture } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it, vi } from "vitest";
import openrouterPlugin from "./index.js";

async function captureProviderPayload(
  modelId: string,
  thinkingLevel: string | undefined,
  payload: Record<string, unknown>,
  compat: Parameters<StreamFn>[0]["compat"] = {},
) {
  const provider = await registerSingleProviderPlugin(openrouterPlugin);
  const baseStreamFn = vi.fn((...args: Parameters<StreamFn>): ReturnType<StreamFn> => {
    void args[2]?.onPayload?.(payload, args[0]);
    return createAssistantMessageEventStream();
  });
  const wrapped = provider.wrapStreamFn?.({
    provider: "openrouter",
    modelId,
    thinkingLevel,
    streamFn: baseStreamFn,
  } as never);

  void wrapped?.(
    {
      provider: "openrouter",
      api: "openai-completions",
      id: modelId,
      baseUrl: "https://openrouter.ai/api/v1",
      compat,
    } as never,
    { messages: [] },
    {},
  );

  expect(baseStreamFn).toHaveBeenCalledOnce();
  return payload;
}

describe("OpenRouter chat owner invariants", () => {
  it.each([false, true])(
    "reads each request's DeepSeek effort from one wrapper (catalog efforts=%s)",
    async (hasEffortMetadata) => {
      const provider = await registerSingleProviderPlugin(openrouterPlugin);
      const model: Parameters<StreamFn>[0] = {
        provider: "openrouter",
        id: "deepseek/deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
        api: "openclaw-provider-simple:synthetic",
        baseUrl: "https://openrouter.ai/api/v1",
        reasoning: true,
        input: ["text"],
        compat: hasEffortMetadata ? { supportedReasoningEfforts: ["none", "high", "xhigh"] } : {},
        contextWindow: 100_000,
        maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      };
      const requests: Record<string, unknown>[] = [];
      const baseStreamFn: StreamFn = async (runtimeModel, context, options) => {
        const payload = buildOpenAICompletionsParams(
          { ...runtimeModel, api: "openai-completions" },
          context,
          options,
        );
        await options?.onPayload?.(payload, runtimeModel);
        requests.push(payload);
        return createAssistantMessageEventStream();
      };
      const wrapped = provider.wrapSimpleCompletionStreamFn?.({
        provider: "openrouter",
        modelId: model.id,
        model,
        sourceApi: "openai-completions",
        streamFn: baseStreamFn,
      });
      expect(wrapped).toBeTypeOf("function");
      for (const reasoning of ["off", "max", undefined] as const) {
        await wrapped?.(model, { messages: [] }, { reasoning });
      }
      expect(requests.map((request) => request.reasoning)).toEqual([
        { effort: "none" },
        { effort: "xhigh" },
        { effort: "high" },
      ]);
    },
  );

  it("preserves default-on DeepSeek replay when effort is omitted", async () => {
    const payload = await captureProviderPayload(
      "deepseek/deepseek-v4-pro",
      undefined,
      {
        messages: [
          {
            role: "assistant",
            content: "Earlier answer",
            reasoning_content: "Synthetic reasoning",
          },
        ],
      },
      { supportedReasoningEfforts: ["none", "high", "xhigh"] },
    );
    expect(payload).not.toHaveProperty("reasoning");
    expect(payload.messages).toEqual([
      { role: "assistant", content: "Earlier answer", reasoning_content: "Synthetic reasoning" },
    ]);
  });

  it.each(["auto", "openrouter/auto"])(
    "omits automatic reasoning injection for %s standalone completions",
    async (modelId) => {
      const provider = await registerSingleProviderPlugin(openrouterPlugin);
      const model: Parameters<StreamFn>[0] = {
        provider: "openrouter",
        id: modelId,
        name: "OpenRouter Auto",
        api: "openclaw-provider-simple:synthetic",
        baseUrl: "https://openrouter.ai/api/v1",
        reasoning: false,
        input: ["text", "image"],
        contextWindow: 200_000,
        maxTokens: 8192,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      };
      let payload: Record<string, unknown> | undefined;
      const baseStreamFn: StreamFn = async (runtimeModel, context, options) => {
        payload = buildOpenAICompletionsParams(
          { ...runtimeModel, api: "openai-completions" },
          context,
          options,
        );
        await options?.onPayload?.(payload, runtimeModel);
        return createAssistantMessageEventStream();
      };
      const wrapped = provider.wrapSimpleCompletionStreamFn?.({
        provider: "openrouter",
        modelId,
        model,
        sourceApi: "openai-completions",
        thinkingLevel: "high",
        streamFn: baseStreamFn,
      });
      expect(wrapped).toBeTypeOf("function");
      await wrapped?.(model, { messages: [] }, { reasoning: "high" });

      expect(payload?.model).toBe(modelId);
      expect(payload).not.toHaveProperty("reasoning");
      expect(payload).not.toHaveProperty("reasoning_effort");
    },
  );

  it.each(["off", "high"] as const)(
    "applies %s DeepSeek replay policy through standalone completion",
    async (thinkingLevel) => {
      const provider = await registerSingleProviderPlugin(openrouterPlugin);
      const model: Parameters<StreamFn>[0] = {
        provider: "openrouter",
        id: "deepseek/deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
        api: "openclaw-provider-simple:synthetic",
        baseUrl: "https://openrouter.ai/api/v1",
        reasoning: true,
        input: ["text"],
        compat: { supportedReasoningEfforts: ["none", "high", "xhigh"] },
        thinkingLevelMap: { off: "none" },
        contextWindow: 100_000,
        maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      };
      let payload: Record<string, unknown> | undefined;
      const baseStreamFn: StreamFn = async (runtimeModel, context, options) => {
        const request = buildOpenAICompletionsParams(
          { ...runtimeModel, api: "openai-completions" },
          context,
          options,
        );
        await options?.onPayload?.(request, runtimeModel);
        payload = request;
        return createAssistantMessageEventStream();
      };
      const wrapped =
        provider.wrapSimpleCompletionStreamFn?.({
          provider: "openrouter",
          modelId: model.id,
          model,
          sourceApi: "openai-completions",
          thinkingLevel,
          streamFn: baseStreamFn,
        }) ?? baseStreamFn;
      await wrapped(
        model,
        {
          messages: [
            { role: "user", content: "Start the fixture.", timestamp: 1 },
            {
              role: "assistant",
              provider: "openrouter",
              model: model.id,
              api: "openai-completions",
              content:
                thinkingLevel === "off"
                  ? [
                      {
                        type: "thinking",
                        thinking: "earlier reasoning",
                        thinkingSignature: "reasoning_content",
                      },
                      { type: "text", text: "Ready." },
                    ]
                  : [{ type: "text", text: "Ready." }],
              usage: createZeroUsageFixture(),
              stopReason: "stop",
              timestamp: 2,
            },
            { role: "user", content: "Continue the fixture.", timestamp: 3 },
          ],
        },
        { reasoning: thinkingLevel },
      );

      expect(payload?.reasoning).toEqual({ effort: thinkingLevel === "off" ? "none" : "high" });
      expect(payload?.messages).toEqual(
        expect.arrayContaining([
          thinkingLevel === "off"
            ? { role: "assistant", content: "Ready." }
            : { role: "assistant", content: "Ready.", reasoning_content: "" },
        ]),
      );
    },
  );

  it.each([
    "openrouter/anthropic/claude-sonnet-5",
    "openrouter/deepseek/deepseek-v4-pro",
    "openrouter/moonshotai/kimi-k3",
    "z-ai/glm-5.2",
    "openrouter/z-ai/glm-5.2",
    "~anthropic/claude-opus-latest",
    "~moonshotai/kimi-latest",
  ])("recognizes the live upstream cacheable model reference %s", async (modelId) => {
    const provider = await registerSingleProviderPlugin(openrouterPlugin);

    expect(provider.isCacheTtlEligible?.({ provider: "openrouter", modelId } as never)).toBe(true);
  });

  it.each(["openai/gpt-5.4", "~openai/gpt-5.4", "openrouter/openai/gpt-5.4"])(
    "does not infer provider cache support for unrelated model reference %s",
    async (modelId) => {
      const provider = await registerSingleProviderPlugin(openrouterPlugin);

      expect(provider.isCacheTtlEligible?.({ provider: "openrouter", modelId } as never)).toBe(
        false,
      );
    },
  );

  it("preserves assistant prefill when the provider reasoning object disables reasoning", async () => {
    const payload = await captureProviderPayload("anthropic/claude-opus-5", "off", {
      reasoning: { enabled: false },
      messages: [
        { role: "user", content: "Return JSON." },
        { role: "assistant", content: "{" },
      ],
    });

    expect(payload.messages).toEqual([
      { role: "user", content: "Return JSON." },
      { role: "assistant", content: "{" },
    ]);
  });

  it.each(["~anthropic/claude-opus-latest", "openrouter/~anthropic/claude-opus-latest"])(
    "removes unsupported assistant prefill for reasoning model alias %s",
    async (modelId) => {
      const payload = await captureProviderPayload(modelId, "high", {
        reasoning: { effort: "high" },
        messages: [
          { role: "user", content: "Continue." },
          { role: "assistant", content: "{" },
        ],
      });

      expect(payload.messages).toEqual([{ role: "user", content: "Continue." }]);
    },
  );

  it("recognizes the live dated DeepSeek V4 model in its owner thinking profile", async () => {
    const provider = await registerSingleProviderPlugin(openrouterPlugin);

    expect(
      provider.resolveThinkingProfile?.({
        provider: "openrouter",
        modelId: "deepseek/deepseek-v4-flash-0731",
      } as never),
    ).toMatchObject({ defaultLevel: "high" });
  });

  it("backfills reasoning replay for the live dated DeepSeek V4 model", async () => {
    const payload = await captureProviderPayload("deepseek/deepseek-v4-flash-0731", "high", {
      messages: [{ role: "assistant", content: "done" }],
    });

    expect(payload.reasoning).toEqual({ effort: "high" });
    expect(payload.messages).toEqual([
      { role: "assistant", content: "done", reasoning_content: "" },
    ]);
  });
});
