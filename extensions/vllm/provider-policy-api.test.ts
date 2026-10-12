import { describe, expect, it } from "vitest";
import { resolveThinkingProfile } from "./provider-policy-api.js";

describe("vLLM provider thinking policy", () => {
  it.each(["qwen", "qwen-chat-template"])(
    "uses the declared %s effort ladder",
    (thinkingFormat) => {
      expect(
        resolveThinkingProfile({
          provider: "vllm",
          modelId: "qwen3:8b",
          reasoning: true,
          compat: {
            thinkingFormat,
            supportedReasoningEfforts: ["xhigh", " low ", "medium", "low"],
          },
        }),
      ).toEqual({
        levels: [{ id: "off" }, { id: "low" }, { id: "medium" }, { id: "xhigh" }],
        defaultLevel: "off",
      });
    },
  );

  it.each(["compat", "model"] as const)(
    "exposes logical %s map keys with native wire labels",
    (source) => {
      const mapping = { low: "LOW", high: "HIGH", max: "UNSUPPORTED" };
      expect(
        resolveThinkingProfile({
          provider: "vllm",
          modelId: "qwen3:8b",
          ...(source === "model" ? { thinkingLevelMap: mapping } : {}),
          compat: {
            thinkingFormat: "qwen-chat-template",
            supportedReasoningEfforts: [" LOW ", "HIGH"],
            ...(source === "compat" ? { reasoningEffortMap: mapping } : {}),
          },
        }),
      ).toEqual({ levels: [{ id: "off" }, { id: "low" }, { id: "high" }], defaultLevel: "off" });
    },
  );

  it.each([
    { supportedReasoningEfforts: [] },
    { supportedReasoningEfforts: ["LOW", "HIGH"] },
    { supportsReasoningEffort: false, supportedReasoningEfforts: ["low", "high"] },
  ])("keeps binary thinking when no selectable effort is supported: %j", (compat) => {
    expect(
      resolveThinkingProfile({
        provider: "vllm",
        modelId: "qwen3:8b",
        compat: { thinkingFormat: "qwen-chat-template", ...compat },
      }),
    ).toEqual({
      levels: [{ id: "off" }, { id: "low", label: "on" }],
      defaultLevel: "off",
    });
  });

  it("uses configured Qwen compat even when catalog reasoning metadata is absent", () => {
    expect(
      resolveThinkingProfile({
        provider: "vllm",
        modelId: "Qwen/Qwen3-8B",
        compat: { thinkingFormat: "qwen-chat-template" },
      }),
    ).toEqual({
      levels: [{ id: "off" }, { id: "low", label: "on" }],
      defaultLevel: "off",
    });
  });

  it("exposes a binary profile for vLLM Nemotron 3 reasoning models", () => {
    expect(
      resolveThinkingProfile({
        provider: "vllm",
        modelId: "nemotron-3-super",
        reasoning: true,
      }),
    ).toEqual({
      levels: [{ id: "off" }, { id: "low", label: "on" }],
      defaultLevel: "off",
    });
  });

  it("does not flatten unconfigured or non-reasoning vLLM models", () => {
    expect(
      resolveThinkingProfile({
        provider: "vllm",
        modelId: "Qwen/Qwen3-8B",
        reasoning: true,
      }),
    ).toBeNull();
    expect(
      resolveThinkingProfile({
        provider: "vllm",
        modelId: "Qwen/Qwen3-8B",
        reasoning: false,
        compat: { thinkingFormat: "qwen-chat-template" },
      }),
    ).toBeNull();
  });
});
