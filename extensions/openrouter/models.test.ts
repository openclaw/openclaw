import { describe, expect, it } from "vitest";
import { isOpenRouterDeepSeekV4ModelId } from "./models.js";

describe("isOpenRouterDeepSeekV4ModelId", () => {
  it("matches namespaced DeepSeek V4 refs", () => {
    expect(isOpenRouterDeepSeekV4ModelId("openrouter/deepseek/deepseek-v4-flash")).toBe(true);
    expect(isOpenRouterDeepSeekV4ModelId("openrouter/deepseek/deepseek-v4-pro")).toBe(true);
    expect(isOpenRouterDeepSeekV4ModelId("deepseek/deepseek-v4-flash")).toBe(true);
    expect(isOpenRouterDeepSeekV4ModelId("openrouter/anthropic/claude-sonnet-4-6")).toBe(false);
    expect(isOpenRouterDeepSeekV4ModelId(null)).toBe(false);
  });
});
