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

  it("matches DeepSeek V4 point releases and their dated snapshots", () => {
    expect(isOpenRouterDeepSeekV4ModelId("openrouter/deepseek/deepseek-v4.1-flash")).toBe(true);
    expect(isOpenRouterDeepSeekV4ModelId("deepseek/deepseek-v4.1-flash-1017")).toBe(true);
    expect(isOpenRouterDeepSeekV4ModelId("deepseek/deepseek-v4.1-flash:nitro")).toBe(true);
    expect(isOpenRouterDeepSeekV4ModelId("deepseek/deepseek-v4.2-pro")).toBe(true);
    expect(isOpenRouterDeepSeekV4ModelId("deepseek/deepseek-v4-flash-vision-exp")).toBe(false);
    expect(isOpenRouterDeepSeekV4ModelId("deepseek/deepseek-v4.1-flash-vision-exp")).toBe(false);
    expect(isOpenRouterDeepSeekV4ModelId("deepseek/deepseek-v41-flash")).toBe(false);
  });
});
