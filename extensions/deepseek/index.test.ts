import { expectDefined } from "@openclaw/normalization-core";
import type { Context, Model, StreamFunction } from "openclaw/plugin-sdk/llm";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { buildOpenAICompletionsParams } from "openclaw/plugin-sdk/provider-transport-runtime";
import { createProviderUsageFetch, makeResponse } from "openclaw/plugin-sdk/test-env";
import { makeAgentAssistantMessage } from "openclaw/plugin-sdk/test-fixtures";
import { expect, it } from "vitest";
import { makeTextToolResult } from "../test-support/message-fixtures.test-support.js";
import deepseekPlugin from "./index.js";
import { buildDeepSeekProvider } from "./provider-catalog.js";
import { createDeepSeekV4ThinkingWrapper } from "./stream.js";

it("strips replayed reasoning_content when DeepSeek V4 thinking is disabled", async () => {
  expect.hasAssertions();
  const provider = buildDeepSeekProvider();
  const model = {
    ...expectDefined(
      provider.models.find((entry) => entry.id === "deepseek-v4-flash"),
      "DeepSeek V4 catalog model",
    ),
    provider: "deepseek",
    baseUrl: provider.baseUrl,
  } as Model<"openai-completions">;
  const context = {
    messages: [
      { role: "user", content: "hi", timestamp: 1 },
      makeAgentAssistantMessage({
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
        stopReason: "toolUse",
      }),
      makeTextToolResult("call_1", "read", "ok", false, 3),
    ],
    tools: [
      {
        name: "read",
        description: "Read data",
        parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
      },
    ],
  } as Context;
  const streamFn: StreamFunction<"openai-completions"> = (streamModel, streamContext, options) => {
    const payload = buildOpenAICompletionsParams(streamModel, streamContext, {
      reasoning: "high",
    } as never);
    options?.onPayload?.(payload, streamModel);
    expect(payload.thinking).toMatchObject({ type: "disabled" });
    expect(payload).not.toHaveProperty("reasoning_effort");
    expect((payload.messages as Array<Record<string, unknown>>)[1]).not.toHaveProperty(
      "reasoning_content",
    );
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => stream.end());
    return stream;
  };
  const wrapped = createDeepSeekV4ThinkingWrapper(streamFn as never, "none" as never);
  await expectDefined(wrapped, "DeepSeek thinking wrapper")(model, context, {});
});

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
  await expect(
    provider.fetchUsageSnapshot?.({
      token: "deepseek-key",
      timeoutMs: 5000,
      fetchFn: createProviderUsageFetch(async () =>
        makeResponse(200, {
          is_available: true,
          balance_infos: [{ currency: "CNY", total_balance: "8.88", granted_balance: "1.00" }],
        }),
      ),
    } as never),
  ).resolves.toMatchObject({
    provider: "deepseek",
    displayName: "DeepSeek",
    windows: [],
    summary: "Balance ¥8.88 · Granted ¥1.00",
  });
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
