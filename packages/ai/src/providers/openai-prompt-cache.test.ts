import { describe, expect, it } from "vitest";
import { clampOpenAIPromptCacheKey } from "./openai-prompt-cache.js";

describe("clampOpenAIPromptCacheKey", () => {
  it.each([
    ["absent", undefined],
    ["at the cap", "a".repeat(64)],
    ["astral over the cap", "🦞".repeat(74)],
  ] as const)("preserves the 64-code-point contract: %s", (_name, key) => {
    expect(clampOpenAIPromptCacheKey(key)).toBe(
      key === undefined ? undefined : Array.from(key).slice(0, 64).join(""),
    );
  });
});
