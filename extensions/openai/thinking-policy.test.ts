import { describe, expect, it } from "vitest";
import { resolveThinkingProfile } from "./provider-policy-api.js";
import { resolveUnifiedOpenAIThinkingProfile } from "./thinking-policy.js";

function levelIds(params: {
  api: "openai-responses" | "openai-chatgpt-responses";
  efforts: string[];
}) {
  return resolveUnifiedOpenAIThinkingProfile(
    "gpt-5.6-sol",
    "codex",
    { supportedReasoningEfforts: params.efforts },
    params.api,
  ).levels.map((level) => level.id);
}

describe("OpenAI thinking route provenance", () => {
  it.each(["gpt-daybreak-blue-latest", "gpt-daybreak-red-latest"])(
    "exposes the Daybreak Platform efforts for %s",
    (modelId) => {
      for (const agentRuntime of ["openclaw", "codex"]) {
        const profile = resolveThinkingProfile({ provider: "openai", modelId, agentRuntime });
        expect(profile?.levels.map(({ id }) => id)).toEqual([
          ...(modelId.includes("red") && agentRuntime === "openclaw" ? ["off"] : []),
          "low",
          "medium",
          "high",
          "xhigh",
          "max",
          ...(agentRuntime === "openclaw" ? ["ultra"] : []),
        ]);
        expect(profile?.defaultLevel).toBe("medium");
      }
    },
  );

  it("honors declared alias efforts instead of name heuristics", () => {
    for (const agentRuntime of ["openclaw", "codex"]) {
      expect(
        resolveThinkingProfile({
          provider: "openai",
          modelId: "configured-alias",
          agentRuntime,
          api: "openai-responses",
          compat: { supportedReasoningEfforts: ["low", "xhigh"] },
        })?.levels.map(({ id }) => id),
      ).toEqual(["low", "xhigh"]);
    }
  });

  it("keeps Daybreak scalar opt-outs authoritative", () => {
    for (const compat of [{ supportedReasoningEfforts: [] }, { supportsReasoningEffort: false }]) {
      expect(
        resolveThinkingProfile({
          provider: "openai",
          modelId: "gpt-daybreak-blue-latest",
          agentRuntime: "openclaw",
          compat,
        })?.levels,
      ).toEqual([]);
    }
    expect(
      resolveThinkingProfile({
        provider: "openai",
        modelId: "gpt-daybreak-blue-latest",
        agentRuntime: "openclaw",
        thinkingLevelMap: { max: null },
      })?.levels.map(({ id }) => id),
    ).not.toContain("ultra");
  });

  it("retains Ultra with scalar API metadata on the native runtime", () => {
    expect(
      resolveUnifiedOpenAIThinkingProfile(
        "gpt-6-astra",
        "codex",
        { supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"] },
        "openai-responses",
      ).levels.map((level) => level.id),
    ).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
  });

  it.each([
    { efforts: ["high"], defaultLevel: undefined },
    { efforts: ["low", "high"], defaultLevel: "low" },
    { efforts: ["medium", "high"], defaultLevel: "medium" },
  ])("retains Astra account efforts $efforts", ({ efforts, defaultLevel }) => {
    const profile = resolveUnifiedOpenAIThinkingProfile("gpt-6-astra", "codex", {
      supportedReasoningEfforts: efforts,
    });
    expect(profile.levels.map((level) => level.id)).toEqual(efforts);
    expect(profile.defaultLevel).toBe(defaultLevel);
  });

  it.each([
    { efforts: ["low", "high", "max"], expected: ["low", "high", "max"] },
    { efforts: ["none", "low", "high"], expected: ["off", "low", "high"] },
  ])("uses native account efforts without a host transport: $efforts", ({ efforts, expected }) => {
    expect(
      resolveUnifiedOpenAIThinkingProfile("account-model", "codex", {
        supportedReasoningEfforts: efforts,
      }).levels.map((level) => level.id),
    ).toEqual(expected);
  });

  it("keeps native fallback capabilities for a direct OpenAI route", () => {
    expect(
      levelIds({
        api: "openai-responses",
        efforts: ["low", "medium", "high", "xhigh", "max"],
      }),
    ).toContain("ultra");
  });

  it("retains known native capabilities when ChatGPT metadata is incomplete", () => {
    expect(
      levelIds({
        api: "openai-chatgpt-responses",
        efforts: ["low", "high"],
      }),
    ).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
  });
});
