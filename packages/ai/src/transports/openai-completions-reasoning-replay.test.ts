import { describe, expect, it } from "vitest";
import { requiresReasoningContentReplay } from "./openai-completions-reasoning-replay.js";

describe("requiresReasoningContentReplay", () => {
  it.each([
    "deepseek-v4-flash",
    "deepseek-v4-pro",
    // V4.1 Flash reports the short vendor id; it carries the same replay contract.
    "deepseek-flash",
    "openrouter/deepseek/deepseek-flash",
    "kimi-k3",
    "mimo-v2-pro",
  ])("requires replay for %s", (modelId) => {
    expect(requiresReasoningContentReplay(modelId)).toBe(true);
  });

  it.each(["gpt-6.1-terra", "anthropic/claude-sonnet-5", "", undefined, null])(
    "does not require replay for %s",
    (modelId) => {
      expect(requiresReasoningContentReplay(modelId as unknown as string)).toBe(false);
    },
  );

  it("ignores access-tier suffixes", () => {
    expect(requiresReasoningContentReplay("deepseek-flash-free")).toBe(true);
  });
});
