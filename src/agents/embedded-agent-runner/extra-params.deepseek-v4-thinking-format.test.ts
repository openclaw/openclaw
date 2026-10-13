import { describe, expect, it, vi } from "vitest";
import { createLlmStreamSimpleMock } from "../../../test/helpers/agents/llm-stream-simple-mock.js";
import type { ModelCompatConfig } from "../../config/types.models.js";
import type { Model } from "../../llm/types.js";
import { runExtraParamsCase } from "./extra-params.test-support.js";

vi.mock("../../llm/stream.js", () => createLlmStreamSimpleMock());

function runDeepSeekV4Case(params: {
  modelId: string;
  messages?: Array<Record<string, unknown>>;
  payloadExtras?: Record<string, unknown>;
  provider?: string;
  thinkingFormat?: ModelCompatConfig["thinkingFormat"];
  thinkingLevel?: "off" | "high";
}): Record<string, unknown> {
  const provider = params.provider ?? "opencode";
  const compat = params.thinkingFormat ? { thinkingFormat: params.thinkingFormat } : undefined;
  return runExtraParamsCase({
    applyProvider: provider,
    applyModelId: params.modelId,
    mockProviderRuntime: true,
    thinkingLevel: params.thinkingLevel ?? "high",
    model: {
      api: "openai-completions",
      provider,
      id: params.modelId,
      ...(compat ? { compat } : {}),
    } as Model<"openai-completions">,
    payload: {
      model: params.modelId,
      messages: params.messages ?? [],
      ...params.payloadExtras,
    },
  }).payload as Record<string, unknown>;
}

describe("extra-params: DeepSeek OpenAI-compatible thinking fallback", () => {
  it.each(["DeepSeek-V4-Flash", "deepseek-flash"])(
    "injects native thinking for the unowned proxy model %s",
    (modelId) => {
      const payload = runDeepSeekV4Case({ modelId, thinkingLevel: "high" });
      expect(payload.thinking).toEqual({ type: "enabled" });
      expect(payload.reasoning_effort).toBe("high");
    },
  );

  it.each(["microsoft-foundry", "microsoft-foundry-9433"])(
    "suppresses native thinking and replay fields on %s",
    (provider) => {
      const payload = runDeepSeekV4Case({
        modelId: "DeepSeek-V4-Flash",
        provider,
        messages: [
          { role: "user", content: "continue" },
          { role: "assistant", content: "prior", reasoning_content: "native reasoning" },
        ],
      });
      expect(payload).not.toHaveProperty("thinking");
      expect(payload).not.toHaveProperty("reasoning_effort");
      expect((payload.messages as Array<Record<string, unknown>>)[1]).not.toHaveProperty(
        "reasoning_content",
      );
    },
  );

  it("strips native thinking and replay fields when thinkingFormat is openai", () => {
    const payload = runDeepSeekV4Case({
      modelId: "DeepSeek-V4-Flash",
      messages: [
        { role: "user", content: "continue" },
        { role: "assistant", content: "prior", reasoning_content: "native reasoning" },
      ],
      thinkingFormat: "openai",
    });
    expect(payload).not.toHaveProperty("thinking");
    expect(payload).not.toHaveProperty("reasoning_effort");
    expect((payload.messages as Array<Record<string, unknown>>)[1]).not.toHaveProperty(
      "reasoning_content",
    );
  });

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

  it("does not inject thinking:disabled when thinkingFormat is openai and thinking is off", () => {
    const payload = runDeepSeekV4Case({
      modelId: "DeepSeek-V4-Flash",
      thinkingFormat: "openai",
      thinkingLevel: "off",
    });
    expect(payload).not.toHaveProperty("thinking");
  });
});
