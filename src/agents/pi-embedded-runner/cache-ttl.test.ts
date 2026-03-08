import { describe, expect, it } from "vitest";
import { isCacheTtlEligibleProvider } from "./cache-ttl.js";

describe("isCacheTtlEligibleProvider", () => {
  it("allows anthropic", () => {
    expect(isCacheTtlEligibleProvider("anthropic", "claude-sonnet-4-20250514")).toBe(true);
  });

  it("allows other native providers", () => {
    expect(isCacheTtlEligibleProvider("moonshot", "kimi-k2.5")).toBe(true);
    expect(isCacheTtlEligibleProvider("zai", "glm-5")).toBe(true);
    expect(isCacheTtlEligibleProvider("google", "gemini-2.5-pro")).toBe(true);
    expect(isCacheTtlEligibleProvider("ollama", "glm-5")).toBe(true);
  });

  it("is case-insensitive for provider names", () => {
    expect(isCacheTtlEligibleProvider("Moonshot", "Kimi-K2.5")).toBe(true);
    expect(isCacheTtlEligibleProvider("ZAI", "GLM-5")).toBe(true);
    expect(isCacheTtlEligibleProvider("Google", "Gemini-2.5-Flash")).toBe(true);
    expect(isCacheTtlEligibleProvider("OLLAMA", "GLM-5")).toBe(true);
  });

  it("allows openrouter models", () => {
    expect(isCacheTtlEligibleProvider("openrouter", "anthropic/claude-sonnet-4")).toBe(true);
    expect(isCacheTtlEligibleProvider("openrouter", "moonshotai/kimi-k2.5")).toBe(true);
    expect(isCacheTtlEligibleProvider("openrouter", "moonshot/kimi-k2.5")).toBe(true);
    expect(isCacheTtlEligibleProvider("openrouter", "zai/glm-5")).toBe(true);
    expect(isCacheTtlEligibleProvider("openrouter", "google/gemini-2.5-pro")).toBe(true);
    expect(isCacheTtlEligibleProvider("openrouter", "openai/gpt-4o")).toBe(true);
  });
});
