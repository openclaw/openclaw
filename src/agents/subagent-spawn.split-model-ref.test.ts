import { describe, expect, it } from "vitest";
import { splitModelRef } from "./subagent-spawn.js";

describe("splitModelRef", () => {
  it("splits a simple provider/model ref", () => {
    expect(splitModelRef("openai/gpt-4o")).toEqual({ provider: "openai", model: "gpt-4o" });
  });

  it("preserves multi-segment model IDs (huggingface/org/model)", () => {
    // Regression for https://github.com/openclaw/openclaw/issues/23481
    // String.split("/", 2) was truncating "mistralai/Mistral-7B" to just "mistralai"
    expect(splitModelRef("huggingface/mistralai/Mistral-7B-Instruct-v0.3")).toEqual({
      provider: "huggingface",
      model: "mistralai/Mistral-7B-Instruct-v0.3",
    });
  });

  it("preserves deeply nested model IDs", () => {
    expect(splitModelRef("huggingface/Qwen/Qwen2.5-72B-Instruct")).toEqual({
      provider: "huggingface",
      model: "Qwen/Qwen2.5-72B-Instruct",
    });
  });

  it("returns model-only when no slash is present", () => {
    expect(splitModelRef("gpt-4o")).toEqual({ provider: undefined, model: "gpt-4o" });
  });

  it("returns undefined for empty or missing ref", () => {
    expect(splitModelRef(undefined)).toEqual({ provider: undefined, model: undefined });
    expect(splitModelRef("")).toEqual({ provider: undefined, model: undefined });
    expect(splitModelRef("  ")).toEqual({ provider: undefined, model: undefined });
  });
});
