import { describe, expect, it } from "vitest";
import { isAnthropicBedrockModel } from "./anthropic-family-cache-semantics.js";

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
