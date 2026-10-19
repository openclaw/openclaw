import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import {
  createAssistantMessageEventStream,
  type Context,
  type Model,
} from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { resolveAgentModelPrimaryValue } from "openclaw/plugin-sdk/provider-onboard";
import { buildOpenAICompletionsParams } from "openclaw/plugin-sdk/provider-transport-runtime";
import { createZeroUsageFixture } from "openclaw/plugin-sdk/test-fixtures";
import { describe, expect, it } from "vitest";
import plugin from "./index.js";
import { LONGCAT_DEFAULT_MODEL_REF } from "./models.js";
import { applyLongCatConfig } from "./onboard.js";
import { buildLongCatProvider } from "./provider-catalog.js";

describe("LongCat provider plugin", () => {
  it("applies the LongCat catalog without replacing an existing primary model", () => {
    const result = applyLongCatConfig({
      agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
    });

    expect(resolveAgentModelPrimaryValue(result.agents?.defaults?.model)).toBe("openai/gpt-5.5");
    expect(result.agents?.defaults?.models?.[LONGCAT_DEFAULT_MODEL_REF]).toEqual({
      alias: "LongCat 2.0",
    });
  });

  it("uses LongCat thinking and replay fields through the registered provider", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const catalog = buildLongCatProvider();
    const definition = catalog.models[0];
    if (!definition) {
      throw new Error("LongCat catalog did not provide a model");
    }
    const model = {
      ...definition,
      api: "openai-completions",
      baseUrl: catalog.baseUrl,
      provider: "longcat",
    } as Model<"openai-completions">;
    const context = {
      systemPrompt: "system",
      messages: [
        { role: "user", content: "read it", timestamp: 1 },
        {
          role: "assistant",
          api: "openai-completions",
          provider: "longcat",
          model: "LongCat-2.0",
          content: [
            {
              type: "thinking",
              thinking: "use the read tool",
              thinkingSignature: "reasoning_content",
            },
            { type: "toolCall", id: "call_1", name: "read", arguments: {} },
          ],
          usage: createZeroUsageFixture(),
          stopReason: "toolUse",
          timestamp: 2,
        },
      ],
      tools: [
        {
          name: "read",
          description: "Read data",
          parameters: { type: "object", properties: {} },
        },
      ],
    } as Context;
    let payload: Record<string, unknown> | undefined;
    const baseStreamFn: StreamFn = (streamModel, streamContext, options) => {
      const params = buildOpenAICompletionsParams(
        streamModel as Model<"openai-completions">,
        streamContext,
        { maxTokens: 2048, reasoning: "high" } as never,
      ) as Record<string, unknown>;
      options?.onPayload?.(params, streamModel);
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => stream.end());
      return stream;
    };
    const wrappedStreamFn = provider.wrapStreamFn?.({
      streamFn: baseStreamFn,
      thinkingLevel: "high",
      provider: "longcat",
      modelId: model.id,
    });
    if (!wrappedStreamFn) {
      throw new Error("LongCat stream wrapper was not registered");
    }

    void wrappedStreamFn(model, context, {
      onPayload: (nextPayload) => {
        payload = nextPayload as Record<string, unknown>;
      },
    });
    if (!payload) {
      throw new Error("LongCat payload was not captured");
    }

    expect(payload).toMatchObject({
      max_tokens: 2048,
      thinking: { type: "enabled" },
    });
    expect(payload).not.toHaveProperty("max_completion_tokens");
    expect(payload).not.toHaveProperty("reasoning_effort");
    expect(payload).not.toHaveProperty("store");
    expect(payload).not.toHaveProperty("stream_options");
    expect(payload.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "system", content: "system" }),
        expect.objectContaining({
          role: "assistant",
          reasoning_content: "use the read tool",
        }),
      ]),
    );
  });
});
