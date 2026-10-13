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

type PayloadCapture = {
  payload?: Record<string, unknown>;
};

const emptyUsage = createZeroUsageFixture();

const readToolCall = { type: "toolCall", id: "call_1", name: "read", arguments: {} };
const readToolResult = {
  role: "toolResult",
  toolCallId: "call_1",
  toolName: "read",
  content: [{ type: "text", text: "ok" }],
  isError: false,
  timestamp: 3,
};
const readTool = {
  name: "read",
  description: "Read data",
  parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
};

function deepSeekV4Model(id: string): OpenAICompletionsModel {
  const provider = buildDeepSeekProvider();
  const model = provider.models.find((entry) => entry.id === id);
  if (!model) {
    throw new Error(`DeepSeek bundled catalog does not include ${id}`);
  }
  return {
    ...model,
    provider: "deepseek",
    api: "openai-completions",
    baseUrl: provider.baseUrl,
  } as OpenAICompletionsModel;
}

function replayAssistantMessage(params: {
  provider: string;
  model: string;
  content: Array<Record<string, unknown>>;
  stopReason: "stop" | "toolUse";
}) {
  return {
    role: "assistant",
    api: "openai-completions",
    provider: params.provider,
    model: params.model,
    content: params.content,
    usage: emptyUsage,
    stopReason: params.stopReason,
    timestamp: 2,
  };
}

function readToolReplayContext(assistantMessage: ReturnType<typeof replayAssistantMessage>) {
  return {
    messages: [{ role: "user", content: "hi", timestamp: 1 }, assistantMessage, readToolResult],
    tools: [readTool],
  } as Context;
}

function deepSeekReasoningToolReplayContext(modelId = "deepseek-v4-flash") {
  return readToolReplayContext(
    replayAssistantMessage({
      provider: "deepseek",
      model: modelId,
      content: [
        {
          type: "thinking",
          thinking: "call reasoning",
          thinkingSignature: "reasoning_content",
        },
        readToolCall,
      ],
      stopReason: "toolUse",
    }),
  );
}

function createPayloadCapturingStream(capture: PayloadCapture) {
  return (
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
}

function readPayloadMessage(
  capture: PayloadCapture,
  index: number,
): Record<string, unknown> | undefined {
  return (capture.payload?.messages as Array<Record<string, unknown>> | undefined)?.[index];
}

async function captureThinkingPayload(
  model: OpenAICompletionsModel,
  context: Context,
  thinkingLevel: Parameters<typeof createDeepSeekV4ThinkingWrapper>[1],
) {
  const capture: PayloadCapture = {};
  const wrapped = expectDefined(
    createDeepSeekV4ThinkingWrapper(createPayloadCapturingStream(capture) as never, thinkingLevel),
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
    const capture = await captureThinkingPayload(
      deepSeekV4Model("deepseek-v4-flash"),
      deepSeekReasoningToolReplayContext(),
      "none" as never,
    );
    expect(capture.payload?.thinking).toMatchObject({ type: "disabled" });
    expect(capture.payload).not.toHaveProperty("reasoning_effort");
    expect(readPayloadMessage(capture, 1)).not.toHaveProperty("reasoning_content");
  });

  it("publishes configured DeepSeek models through plugin-owned catalog augmentation", async () => {
    const provider = await registerSingleProviderPlugin(deepseekPlugin);

    expect(
      provider.augmentModelCatalog?.({
        config: {
          models: {
            providers: {
              deepseek: {
                models: [
                  {
                    id: "deepseek-chat",
                    name: "DeepSeek Chat",
                    input: ["text"],
                    reasoning: false,
                    contextWindow: 65536,
                  },
                ],
              },
            },
          },
        },
      } as never),
    ).toEqual([
      {
        provider: "deepseek",
        id: "deepseek-chat",
        name: "DeepSeek Chat",
        input: ["text"],
        reasoning: false,
        contextWindow: 65536,
      },
    ]);
  });
});
