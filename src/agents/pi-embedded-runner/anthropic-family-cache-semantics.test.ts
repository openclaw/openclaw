import { describe, expect, it } from "vitest";
import {
  isAnthropicBedrockModel,
  isAnthropicFamilyCacheTtlEligible,
  resolveAnthropicCacheRetentionFamily,
} from "./anthropic-family-cache-semantics.js";

describe("isAnthropicBedrockModel", () => {
  it("matches direct Anthropic Claude model IDs", () => {
    expect(isAnthropicBedrockModel("anthropic.claude-sonnet-4-6")).toBe(true);
    expect(isAnthropicBedrockModel("us.anthropic.claude-sonnet-4-6")).toBe(true);
    expect(isAnthropicBedrockModel("global.anthropic.claude-opus-4-6-v1")).toBe(true);
  });

  it("matches anthropic/claude model refs", () => {
    expect(isAnthropicBedrockModel("anthropic/claude-sonnet-4-6")).toBe(true);
  });

  it("rejects non-Claude model IDs", () => {
    expect(isAnthropicBedrockModel("amazon.nova-micro-v1:0")).toBe(false);
    expect(isAnthropicBedrockModel("meta.llama3-70b")).toBe(false);
  });

  it("matches application inference profile ARN with 'claude' in profile ID", () => {
    const arn =
      "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/my-claude-profile";
    expect(isAnthropicBedrockModel(arn)).toBe(true);
  });

  it("rejects application inference profile ARN with random ID and no modelName", () => {
    const arn = "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/7g9cumu1wd7v";
    expect(isAnthropicBedrockModel(arn)).toBe(false);
  });

  it("matches application inference profile ARN with random ID when modelName contains 'claude'", () => {
    const arn = "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/7g9cumu1wd7v";
    expect(isAnthropicBedrockModel(arn, "Claude Sonnet 4.6 via Inference Profile")).toBe(true);
  });

  it("rejects application inference profile ARN with random ID when modelName does not contain 'claude'", () => {
    const arn = "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/7g9cumu1wd7v";
    expect(isAnthropicBedrockModel(arn, "My Custom LLM")).toBe(false);
  });

  it("matches application inference profile ARN in GovCloud partition with modelName fallback", () => {
    const arn =
      "arn:aws-us-gov:bedrock:us-gov-west-1:123456789012:application-inference-profile/abc123";
    expect(isAnthropicBedrockModel(arn, "Claude Opus 4.6")).toBe(true);
  });

  it("matches application inference profile ARN in China partition with modelName fallback", () => {
    const arn =
      "arn:aws-cn:bedrock:cn-northwest-1:123456789012:application-inference-profile/xyz789";
    expect(isAnthropicBedrockModel(arn, "claude-sonnet")).toBe(true);
  });

  it("ignores modelName for direct model IDs (not inference profiles)", () => {
    // modelName should only matter for application inference profile ARNs
    expect(isAnthropicBedrockModel("amazon.nova-micro-v1:0", "Claude Sonnet 4.6")).toBe(false);
  });
});

describe("isAnthropicFamilyCacheTtlEligible", () => {
  const randomIdArn =
    "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/7g9cumu1wd7v";

  it("returns true for amazon-bedrock with random-ID inference profile when modelName contains 'claude'", () => {
    expect(
      isAnthropicFamilyCacheTtlEligible({
        provider: "amazon-bedrock",
        modelId: randomIdArn,
        modelName: "Claude Sonnet 4.6 via Inference Profile",
      }),
    ).toBe(true);
  });

  it("returns false for amazon-bedrock with random-ID inference profile without modelName", () => {
    expect(
      isAnthropicFamilyCacheTtlEligible({
        provider: "amazon-bedrock",
        modelId: randomIdArn,
      }),
    ).toBe(false);
  });

  it("returns true for anthropic provider regardless of modelName", () => {
    expect(
      isAnthropicFamilyCacheTtlEligible({
        provider: "anthropic",
        modelId: "claude-sonnet-4-6",
      }),
    ).toBe(true);
  });
});

describe("resolveAnthropicCacheRetentionFamily", () => {
  const randomIdArn =
    "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/7g9cumu1wd7v";

  it("returns 'anthropic-bedrock' for random-ID inference profile when modelName contains 'claude'", () => {
    expect(
      resolveAnthropicCacheRetentionFamily({
        provider: "amazon-bedrock",
        modelId: randomIdArn,
        modelName: "Claude Sonnet 4.6 via Inference Profile",
        hasExplicitCacheConfig: true,
      }),
    ).toBe("anthropic-bedrock");
  });

  it("returns undefined for random-ID inference profile without modelName", () => {
    expect(
      resolveAnthropicCacheRetentionFamily({
        provider: "amazon-bedrock",
        modelId: randomIdArn,
        hasExplicitCacheConfig: true,
      }),
    ).toBeUndefined();
  });

  it("returns undefined for random-ID inference profile with non-Claude modelName", () => {
    expect(
      resolveAnthropicCacheRetentionFamily({
        provider: "amazon-bedrock",
        modelId: randomIdArn,
        modelName: "My Custom LLM",
        hasExplicitCacheConfig: true,
      }),
    ).toBeUndefined();
  });

  it("returns 'anthropic-direct' for anthropic provider regardless of modelName", () => {
    expect(
      resolveAnthropicCacheRetentionFamily({
        provider: "anthropic",
        modelId: "claude-sonnet-4-6",
        hasExplicitCacheConfig: false,
      }),
    ).toBe("anthropic-direct");
  });
});
