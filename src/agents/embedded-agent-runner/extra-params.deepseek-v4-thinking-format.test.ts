import { describe, expect, it, vi } from "vitest";
import { createLlmStreamSimpleMock } from "../../../test/helpers/agents/llm-stream-simple-mock.js";
import type { ModelCompatConfig } from "../../config/zod-schema.model-compat.js";
import type { Model } from "../../llm/types.js";
import { runExtraParamsCase } from "./extra-params.test-support.js";

vi.mock("../../llm/stream.js", () => createLlmStreamSimpleMock());

function runDeepSeekV4Case(params: {
  modelId?: string;
  replay?: boolean;
  payloadExtras?: Record<string, unknown>;
  provider?: string;
  thinkingFormat?: ModelCompatConfig["thinkingFormat"];
  thinkingLevel?: "off" | "high";
}): Record<string, unknown> {
  const modelId = params.modelId ?? "DeepSeek-V4-Flash";
  return runExtraParamsCase({
    mockProviderRuntime: true,
    thinkingLevel: params.thinkingLevel ?? "high",
    model: {
      api: "openai-completions",
      provider: params.provider ?? "opencode",
      id: modelId,
      ...(params.thinkingFormat ? { compat: { thinkingFormat: params.thinkingFormat } } : {}),
    } as Model<"openai-completions">,
    payload: {
      model: modelId,
      messages: params.replay
        ? [
            { role: "user", content: "continue" },
            { role: "assistant", content: "prior", reasoning_content: "native reasoning" },
          ]
        : [],
      ...params.payloadExtras,
    },
  }).payload;
}

describe("extra-params: DeepSeek OpenAI-compatible thinking fallback", () => {
  it.each(["DeepSeek-V4-Flash", "deepseek-flash"])(
    "injects native thinking for the unowned proxy model %s",
    (modelId) => {
      const payload = runDeepSeekV4Case({ modelId });
      expect([payload.thinking, payload.reasoning_effort]).toEqual([{ type: "enabled" }, "high"]);
    },
  );

  it.each([
    ["microsoft-foundry", undefined, "high"],
    ["microsoft-foundry-9433", undefined, "high"],
    ["opencode", "openai", "high"],
    ["opencode", "openai", "off"],
  ] as const)(
    "strips native thinking on %s with format %s and thinking %s",
    (provider, thinkingFormat, thinkingLevel) => {
      const payload = runDeepSeekV4Case({ provider, thinkingFormat, thinkingLevel, replay: true });
      expect(payload).not.toHaveProperty("thinking");
      expect(payload).not.toHaveProperty("reasoning_effort");
      expect((payload.messages as Array<Record<string, unknown>>)[1]).not.toHaveProperty(
        "reasoning_content",
      );
    },
  );

  it("preserves OpenRouter auto-detected reasoning for a namespaced model", () => {
    const payload = runDeepSeekV4Case({
      modelId: "deepseek/DeepSeek-Flash:free",
      payloadExtras: { reasoning: { effort: "xhigh" } },
      provider: "openrouter",
    });
    expect(payload.reasoning).toEqual({ effort: "xhigh" });
    expect(payload).not.toHaveProperty("thinking");
    expect(payload).not.toHaveProperty("reasoning_effort");
  });
});
