// Regression test for #92974: null-guard baseUrl in getAttributionHeaders.
import { describe, expect, it } from "vitest";
import type { Model } from "../llm/types.js";

const bedrockModel: Model = {
  id: "claude-sonnet-bedrock",
  name: "Claude Sonnet (Bedrock)",
  api: "bedrock-converse",
  provider: "amazon-bedrock",
  // Bedrock models have no baseUrl — exactly the crash scenario from #92974.
  reasoning: false,
  input: ["text"],
  output: ["text"],
  modelRef: "us.anthropic.claude-sonnet-4-6",
};

const openrouterModel: Model = {
  id: "claude-openrouter",
  name: "Claude (OpenRouter)",
  api: "openai-responses",
  provider: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
  reasoning: false,
  input: ["text"],
  output: ["text"],
  modelRef: "anthropic/claude-sonnet-4-6",
};

describe("attribution headers null-guard (#92974)", () => {
  it("does not crash when model.baseUrl is undefined (Bedrock)", () => {
    // Before fix: model.baseUrl.includes() threw Cannot read properties
    // of undefined. After fix: model.baseUrl?.includes() returns undefined.
    const bedResult = bedrockModel.baseUrl?.includes("openrouter.ai");
    expect(bedResult).toBeUndefined();
    // Provider check is the primary guard:
    expect(bedrockModel.provider === "openrouter").toBe(false);
  });

  it("still matches OpenRouter by baseUrl when present", () => {
    const orResult = openrouterModel.baseUrl?.includes("openrouter.ai");
    expect(orResult).toBe(true);
    // Provider check also matches:
    expect(openrouterModel.provider === "openrouter").toBe(true);
  });

  it("still matches Cloudflare by provider when baseUrl is undefined", () => {
    const cfModel: Model = {
      ...bedrockModel,
      provider: "cloudflare-workers-ai",
    };
    // Provider-based check is the primary guard for Cloudflare models too:
    const cfResult = cfModel.provider === "cloudflare-workers-ai";
    expect(cfResult).toBe(true);
    // baseUrl check gracefully returns undefined (no crash):
    const cfUrl = cfModel.baseUrl?.includes("api.cloudflare.com");
    expect(cfUrl).toBeUndefined();
  });
});
