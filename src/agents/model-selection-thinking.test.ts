import { describe, expect, it } from "vitest";
import { findReasoningModelFamily } from "./model-families.js";
import { resolveThinkingAwareModelRef } from "./model-selection-thinking.js";

describe("model-families", () => {
  it("detects xai grok-4-1-fast family members", () => {
    expect(findReasoningModelFamily("xai", "grok-4-1-fast")?.reasoningModel).toBe(
      "grok-4-1-fast-reasoning",
    );
    expect(findReasoningModelFamily("xai", "grok-4-1-fast-reasoning")?.nonReasoningModel).toBe(
      "grok-4-1-fast-non-reasoning",
    );
    expect(findReasoningModelFamily("xai", "grok-4-1-fast-non-reasoning")?.reasoningModel).toBe(
      "grok-4-1-fast-reasoning",
    );
  });
});

describe("resolveThinkingAwareModelRef", () => {
  it("switches xai fast model to reasoning variant when thinking is enabled", () => {
    const resolved = resolveThinkingAwareModelRef({
      provider: "xai",
      model: "grok-4-1-fast",
      thinkingLevel: "high",
    });
    expect(resolved).toEqual({
      provider: "xai",
      model: "grok-4-1-fast-reasoning",
    });
  });

  it("switches xai fast model to non-reasoning variant when thinking is off", () => {
    const resolved = resolveThinkingAwareModelRef({
      provider: "xai",
      model: "grok-4-1-fast-reasoning",
      thinkingLevel: "off",
    });
    expect(resolved).toEqual({
      provider: "xai",
      model: "grok-4-1-fast-non-reasoning",
    });
  });

  it("does not switch when thinking level is unknown", () => {
    const resolved = resolveThinkingAwareModelRef({
      provider: "xai",
      model: "grok-4-1-fast",
    });
    expect(resolved).toEqual({
      provider: "xai",
      model: "grok-4-1-fast",
    });
  });

  it("respects allowlist and does not switch to disallowed variants", () => {
    const resolved = resolveThinkingAwareModelRef({
      provider: "xai",
      model: "grok-4-1-fast",
      thinkingLevel: "high",
      allowedModelKeys: new Set(["openai/gpt-5.2"]),
    });
    expect(resolved).toEqual({
      provider: "xai",
      model: "grok-4-1-fast",
    });
  });

  it("allows switching when allowlist includes only base model", () => {
    const resolved = resolveThinkingAwareModelRef({
      provider: "xai",
      model: "grok-4-1-fast",
      thinkingLevel: "high",
      allowedModelKeys: new Set(["xai/grok-4-1-fast"]),
    });
    expect(resolved).toEqual({
      provider: "xai",
      model: "grok-4-1-fast-reasoning",
    });
  });
});
