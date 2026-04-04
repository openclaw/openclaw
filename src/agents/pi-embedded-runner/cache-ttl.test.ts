import { describe, expect, it, vi } from "vitest";

vi.mock("../../plugins/provider-runtime.js", () => ({
  resolveProviderCacheTtlEligibility: (params: {
    context: { provider: string; modelId: string; modelApi?: string };
  }) => {
    if (params.context.provider === "anthropic") {
      return true;
    }
    if (params.context.provider === "moonshot" || params.context.provider === "zai") {
      return true;
    }
    if (params.context.provider === "openrouter") {
      return ["anthropic/", "moonshot/", "moonshotai/", "zai/"].some((prefix) =>
        params.context.modelId.startsWith(prefix),
      );
    }
    return undefined;
  },
}));

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

  it("rejects unsupported providers and models", () => {
    expect(isCacheTtlEligibleProvider("openai", "gpt-4o")).toBe(false);
    expect(isCacheTtlEligibleProvider("openrouter", "openai/gpt-4o")).toBe(false);
  });

  it("allows custom anthropic-messages providers", () => {
    expect(isCacheTtlEligibleProvider("litellm", "claude-sonnet-4-6", "anthropic-messages")).toBe(
      true,
    );
  });

  it("allows anthropic Bedrock models", () => {
    expect(
      isCacheTtlEligibleProvider(
        "amazon-bedrock",
        "us.anthropic.claude-sonnet-4-20250514-v1:0",
        "anthropic-messages",
      ),
    ).toBe(true);
  });
});
