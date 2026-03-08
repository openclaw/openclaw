import { describe, expect, it } from "vitest";
import { isCacheTtlEligibleProvider } from "./cache-ttl.js";

describe("isCacheTtlEligibleProvider", () => {
  it("allows anthropic", () => {
    expect(isCacheTtlEligibleProvider("anthropic", "claude-sonnet-4-20250514")).toBe(true);
  });

  it("allows moonshot and zai providers", () => {
    expect(isCacheTtlEligibleProvider("moonshot", "kimi-k2.5")).toBe(true);
    expect(isCacheTtlEligibleProvider("zai", "glm-5")).toBe(true);
  });

  it("is case-insensitive for native providers", () => {
    expect(isCacheTtlEligibleProvider("Moonshot", "Kimi-K2.5")).toBe(true);
    expect(isCacheTtlEligibleProvider("ZAI", "GLM-5")).toBe(true);
  });

  it("allows openrouter cache-ttl models", () => {
    expect(isCacheTtlEligibleProvider("openrouter", "anthropic/claude-sonnet-4")).toBe(true);
    expect(isCacheTtlEligibleProvider("openrouter", "moonshotai/kimi-k2.5")).toBe(true);
    expect(isCacheTtlEligibleProvider("openrouter", "moonshot/kimi-k2.5")).toBe(true);
    expect(isCacheTtlEligibleProvider("openrouter", "zai/glm-5")).toBe(true);
  });

  it("returns true for LiteLLM with Claude models", () => {
    expect(isCacheTtlEligibleProvider("litellm", "claude-opus-4-5")).toBe(true);
    expect(isCacheTtlEligibleProvider("litellm", "claude-sonnet-4-5")).toBe(true);
    expect(isCacheTtlEligibleProvider("LiteLLM", "Claude-3-Opus")).toBe(true);
  });

  it("returns false for LiteLLM with non-Claude models", () => {
    expect(isCacheTtlEligibleProvider("litellm", "gpt-4")).toBe(false);
    expect(isCacheTtlEligibleProvider("litellm", "gemini-pro")).toBe(false);
    expect(isCacheTtlEligibleProvider("litellm", "llama-3")).toBe(false);
  });

  it("rejects unsupported providers and models", () => {
    expect(isCacheTtlEligibleProvider("openai", "gpt-4o")).toBe(false);
    expect(isCacheTtlEligibleProvider("openrouter", "openai/gpt-4o")).toBe(false);
  });
});
