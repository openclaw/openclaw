import assert from "node:assert/strict";
import {
  createAssistantMessageEventStream,
  type Context,
  type Model,
} from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { resolveAgentModelPrimaryValue } from "openclaw/plugin-sdk/provider-onboard";
import { buildOpenAICompletionsParams } from "openclaw/plugin-sdk/provider-transport-runtime";
import { makeAgentAssistantMessage } from "openclaw/plugin-sdk/test-fixtures";
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
    assert(definition, "LongCat catalog did not provide a model");
    const model = {
      ...definition,
      api: "openai-completions",
      baseUrl: catalog.baseUrl,
      provider: "longcat",
    } as Model<"openai-completions">;
    const tool = {
      name: "read",
      description: "Read",
      parameters: { type: "object", properties: {} },
    };
    const context = {
      systemPrompt: "system",
      messages: [
        { role: "user", content: "read it", timestamp: 1 },
        makeAgentAssistantMessage({
          api: "openai-completions",
          provider: "longcat",
          model: "LongCat-2.0",
          content: [
            { type: "thinking", thinking: "read", thinkingSignature: "reasoning_content" },
            { type: "toolCall", id: "call_1", name: "read", arguments: {} },
          ],
          stopReason: "toolUse",
          timestamp: 2,
        }),
      ],
      tools: [tool],
    } as Context;
    let payload: Record<string, unknown> | undefined;
    const wrappedStreamFn = provider.wrapStreamFn?.({
      streamFn: (streamModel, streamContext, options) => {
        options?.onPayload?.(
          buildOpenAICompletionsParams(streamModel as Model<"openai-completions">, streamContext, {
            maxTokens: 2048,
            reasoning: "high",
          } as never),
          streamModel,
        );
        const stream = createAssistantMessageEventStream();
        queueMicrotask(() => stream.end());
        return stream;
      },
      thinkingLevel: "high",
      provider: "longcat",
      modelId: model.id,
    });
    assert(wrappedStreamFn, "LongCat stream wrapper was not registered");
    void wrappedStreamFn(model, context, {
      onPayload: (nextPayload) => {
        payload = nextPayload as Record<string, unknown>;
      },
    });
    assert(payload, "LongCat payload was not captured");
    expect(payload).toMatchObject({ max_tokens: 2048, thinking: { type: "enabled" } });
    for (const key of ["max_completion_tokens", "reasoning_effort", "store", "stream_options"]) {
      expect(payload).not.toHaveProperty(key);
    }
    expect(payload.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "system", content: "system" }),
        expect.objectContaining({ role: "assistant", reasoning_content: "read" }),
      ]),
    );
  });
});
