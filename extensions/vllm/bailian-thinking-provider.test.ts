// Bailian provider tests for thinking policy resolution.
// These tests verify that the 'bailian' provider (Alibaba Cloud) is treated
// the same as 'vllm' for thinking profile resolution.
import { describe, expect, it } from "vitest";
import { resolveThinkingProfile } from "./provider-policy-api.js";

describe("Bailian provider thinking policy", () => {
  it("exposes a binary profile for bailian with qwen-chat-template thinkingFormat", () => {
    expect(
      resolveThinkingProfile({
        provider: "bailian",
        modelId: "Qwen/Qwen3-8B",
        reasoning: true,
        compat: { thinkingFormat: "qwen-chat-template" },
      }),
    ).toEqual({
      levels: [{ id: "off" }, { id: "low", label: "on" }],
      defaultLevel: "off",
    });
  });

  it("exposes a binary profile for bailian with qwen thinkingFormat", () => {
    expect(
      resolveThinkingProfile({
        provider: "bailian",
        modelId: "qwen-max",
        reasoning: true,
        compat: { thinkingFormat: "qwen" },
      }),
    ).toEqual({
      levels: [{ id: "off" }, { id: "low", label: "on" }],
      defaultLevel: "off",
    });
  });

  it("exposes a binary profile for bailian with openai thinkingFormat", () => {
    expect(
      resolveThinkingProfile({
        provider: "bailian",
        modelId: "qwen-plus",
        reasoning: true,
        compat: { thinkingFormat: "openai" },
      }),
    ).toEqual({
      levels: [{ id: "off" }, { id: "low", label: "on" }],
      defaultLevel: "off",
    });
  });

  it("uses configured compat even when catalog reasoning metadata is absent", () => {
    expect(
      resolveThinkingProfile({
        provider: "bailian",
        modelId: "Qwen/Qwen3-8B",
        compat: { thinkingFormat: "qwen-chat-template" },
      }),
    ).toEqual({
      levels: [{ id: "off" }, { id: "low", label: "on" }],
      defaultLevel: "off",
    });
  });

  it("returns null for bailian when reasoning is false", () => {
    expect(
      resolveThinkingProfile({
        provider: "bailian",
        modelId: "Qwen/Qwen3-8B",
        reasoning: false,
        compat: { thinkingFormat: "qwen-chat-template" },
      }),
    ).toBeNull();
  });

  it("returns null for bailian without thinkingFormat compat", () => {
    expect(
      resolveThinkingProfile({
        provider: "bailian",
        modelId: "some-model",
        reasoning: true,
      }),
    ).toBeNull();
  });
});
