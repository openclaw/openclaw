import { expectDefined } from "@openclaw/normalization-core";
import type { Context, Model } from "openclaw/plugin-sdk/llm";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { buildOpenAICompletionsParams } from "openclaw/plugin-sdk/provider-transport-runtime";
import { createProviderUsageFetch, makeResponse } from "openclaw/plugin-sdk/test-env";
import { createZeroUsageFixture } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";
import deepseekPlugin from "./index.js";
import { buildDeepSeekProvider } from "./provider-catalog.js";
import { createDeepSeekV4ThinkingWrapper } from "./stream.js";

type OpenAICompletionsModel = Model<"openai-completions">;

async function captureThinkingPayload() {
  const capture: { payload?: Record<string, unknown> } = {};
  const provider = buildDeepSeekProvider();
  const model = {
    ...expectDefined(
      provider.models.find((entry) => entry.id === "deepseek-v4-flash"),
      "DeepSeek V4 catalog model",
    ),
    provider: "deepseek",
    api: "openai-completions",
    baseUrl: provider.baseUrl,
  } as OpenAICompletionsModel;
  const context = {
    messages: [
      { role: "user", content: "hi", timestamp: 1 },
      {
        role: "assistant",
        api: "openai-completions",
        provider: "deepseek",
        model: model.id,
        content: [
          {
            type: "thinking",
            thinking: "call reasoning",
            thinkingSignature: "reasoning_content",
          },
          { type: "toolCall", id: "call_1", name: "read", arguments: {} },
        ],
        usage: createZeroUsageFixture(),
        stopReason: "toolUse",
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "read",
        content: [{ type: "text", text: "ok" }],
        isError: false,
        timestamp: 3,
      },
    ],
    tools: [
      {
        name: "read",
        description: "Read data",
        parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
      },
    ],
  } as Context;
  const streamFn = (
    streamModel: OpenAICompletionsModel,
    streamContext: Context,
    options?: { onPayload?: (payload: unknown, model: unknown) => unknown },
  ) => {
    capture.payload = buildOpenAICompletionsParams(streamModel, streamContext, {
      reasoning: "high",
    } as never);
    options?.onPayload?.(capture.payload, streamModel);
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => stream.end());
    return stream;
  };
  const wrapped = expectDefined(
    createDeepSeekV4ThinkingWrapper(streamFn as never, "none" as never),
    "DeepSeek thinking wrapper",
  );
  await wrapped(model, context, {});
  return capture;
}

describe("deepseek provider plugin", () => {
  it("resolves API-key usage auth from DeepSeek config sources", async () => {
    const provider = await registerSingleProviderPlugin(deepseekPlugin);

    await expect(
      provider.resolveUsageAuth?.({
        env: {},
        resolveApiKeyCandidatesFromConfigAndStore: async (options?: {
          envDirect?: Array<string | undefined>;
        }) => {
          expect(options?.envDirect).toEqual([undefined]);
          return ["config-deepseek-key"];
        },
      } as never),
    ).resolves.toEqual({ token: "config-deepseek-key" });
  });

  it("fetches DeepSeek usage balance through the provider hook", async () => {
    const provider = await registerSingleProviderPlugin(deepseekPlugin);
    const mockFetch = createProviderUsageFetch(async () =>
      makeResponse(200, {
        is_available: true,
        balance_infos: [{ currency: "CNY", total_balance: "8.88", granted_balance: "1.00" }],
      }),
    );

    await expect(
      provider.fetchUsageSnapshot?.({
        token: "deepseek-key",
        timeoutMs: 5000,
        fetchFn: mockFetch,
      } as never),
    ).resolves.toMatchObject({
      provider: "deepseek",
      displayName: "DeepSeek",
      windows: [],
      summary: "Balance ¥8.88 · Granted ¥1.00",
    });
  });

  it("advertises max thinking levels for DeepSeek V4 models only", async () => {
    const provider = await registerSingleProviderPlugin(deepseekPlugin);
    const resolveThinkingProfile = expectDefined(
      provider.resolveThinkingProfile,
      "DeepSeek thinking profile resolver",
    );
    const expectedV4Levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

    for (const modelId of [
      "deepseek-flash",
      "deepseek-v4-flash",
      "deepseek-v4-pro",
      "deepseek-v4-flash-vision-exp",
    ]) {
      const profile = resolveThinkingProfile({ provider: "deepseek", modelId } as never);
      expect(profile?.defaultLevel).toBe("high");
      expect(profile?.levels.map((level) => level.id)).toEqual(expectedV4Levels);
    }
    expect(
      resolveThinkingProfile({ provider: "deepseek", modelId: "deepseek-chat" } as never),
    ).toBe(undefined);
    expect(
      resolveThinkingProfile({ provider: "deepseek", modelId: "deepseek-reasoner" } as never),
    ).toBe(undefined);
  });

  it("strips replayed reasoning_content when DeepSeek V4 thinking is disabled", async () => {
    const capture = await captureThinkingPayload();
    expect(capture.payload?.thinking).toMatchObject({ type: "disabled" });
    expect(capture.payload).not.toHaveProperty("reasoning_effort");
    expect(
      (capture.payload?.messages as Array<Record<string, unknown>> | undefined)?.[1],
    ).not.toHaveProperty("reasoning_content");
  });

  it("publishes configured DeepSeek models through plugin-owned catalog augmentation", async () => {
    const provider = await registerSingleProviderPlugin(deepseekPlugin);
    const model = {
      id: "deepseek-chat",
      name: "DeepSeek Chat",
      input: ["text"],
      reasoning: false,
      contextWindow: 65536,
    };
    const config = { models: { providers: { deepseek: { models: [model] } } } };

    expect(provider.augmentModelCatalog?.({ config } as never)).toEqual([
      { ...model, provider: "deepseek" },
    ]);
  });
});
