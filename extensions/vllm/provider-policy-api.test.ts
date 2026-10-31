import { describe, expect, it } from "vitest";
import { resolveThinkingProfile } from "./provider-policy-api.js";

function profile(overrides: Partial<Parameters<typeof resolveThinkingProfile>[0]>) {
  return resolveThinkingProfile({ provider: "vllm", modelId: "qwen3:8b", ...overrides });
}

const binaryProfile = {
  levels: [{ id: "off" }, { id: "low", label: "on" }],
  defaultLevel: "off",
};

describe("vLLM provider thinking policy", () => {
  it.each(["qwen", "qwen-chat-template"])("uses %s efforts", (thinkingFormat) => {
    expect(
      profile({
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
  });

  it.each(["compat", "model"] as const)("maps %s keys to wire labels", (source) => {
    const mapping = { low: "LOW", high: "HIGH", max: "UNSUPPORTED" };
    expect(
      profile({
        ...(source === "model" ? { thinkingLevelMap: { ...mapping, off: null } } : {}),
        compat: {
          thinkingFormat: "qwen-chat-template",
          supportedReasoningEfforts: [" LOW ", "HIGH"],
          ...(source === "compat" ? { reasoningEffortMap: mapping } : {}),
        },
      }),
    ).toEqual({ levels: [{ id: "off" }, { id: "low" }, { id: "high" }], defaultLevel: "off" });
  });

  it.each([
    { supportedReasoningEfforts: [] },
    { supportedReasoningEfforts: ["LOW", "HIGH"] },
    { supportsReasoningEffort: false, supportedReasoningEfforts: ["low", "high"] },
  ])("keeps binary thinking without selectable efforts: %j", (compat) => {
    expect(profile({ compat: { thinkingFormat: "qwen-chat-template", ...compat } })).toEqual(
      binaryProfile,
    );
  });

  it("uses configured Qwen compat even when catalog reasoning metadata is absent", () => {
    expect(
      profile({
        modelId: "Qwen/Qwen3-8B",
        compat: { thinkingFormat: "qwen-chat-template" },
      }),
    ).toEqual(binaryProfile);
  });

  it.each(["nemotron-3-super", "yk_nemotron-3-super"])("uses binary thinking for %s", (modelId) => {
    expect(profile({ modelId, reasoning: true })).toEqual(binaryProfile);
  });

  it.each([
    { modelId: "yk_nemotron-3-super", reasoning: false },
    { modelId: "yk_deepseek_v4", reasoning: false },
    { modelId: "Qwen/Qwen3-8B", reasoning: true },
    {
      modelId: "Qwen/Qwen3-8B",
      reasoning: false,
      compat: { thinkingFormat: "qwen-chat-template" },
    },
  ])("returns no profile for %j", (context) => {
    expect(profile(context)).toBeNull();
  });
});
