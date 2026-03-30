import { describe, expect, it } from "vitest";
import { isAnthropicBedrockModel } from "./bedrock-stream-wrappers.js";

describe("isAnthropicBedrockModel", () => {
  describe("standard Bedrock model IDs", () => {
    it("should return true for standard Anthropic Bedrock model IDs with dot notation", () => {
      expect(isAnthropicBedrockModel("anthropic.claude-3-opus-20240229-v1:0")).toBe(true);
      expect(isAnthropicBedrockModel("anthropic.claude-3-sonnet-20240229-v1:0")).toBe(true);
      expect(isAnthropicBedrockModel("anthropic.claude-3-haiku-20240307-v1:0")).toBe(true);
      expect(isAnthropicBedrockModel("anthropic.claude-v2:1")).toBe(true);
      expect(isAnthropicBedrockModel("anthropic.claude-instant-v1")).toBe(true);
    });

    it("should return true for standard Anthropic Bedrock model IDs with slash notation", () => {
      expect(isAnthropicBedrockModel("anthropic/claude-3-opus-20240229-v1:0")).toBe(true);
      expect(isAnthropicBedrockModel("anthropic/claude-3-sonnet-20240229-v1:0")).toBe(true);
    });

    it("should return true for regional Anthropic Bedrock model IDs", () => {
      expect(isAnthropicBedrockModel("us.anthropic.claude-opus-4-6-v1:0")).toBe(true);
      expect(isAnthropicBedrockModel("us.anthropic.claude-sonnet-4-6-v1:0")).toBe(true);
      expect(isAnthropicBedrockModel("us.anthropic.claude-haiku-4-5-v1:0")).toBe(true);
    });

    it("should handle case-insensitive matching", () => {
      expect(isAnthropicBedrockModel("ANTHROPIC.CLAUDE-3-OPUS-20240229-V1:0")).toBe(true);
      expect(isAnthropicBedrockModel("Anthropic.Claude-3-Opus-20240229-v1:0")).toBe(true);
    });

    it("should return false for non-Anthropic Bedrock model IDs", () => {
      expect(isAnthropicBedrockModel("amazon.titan-text-express-v1")).toBe(false);
      expect(isAnthropicBedrockModel("amazon.titan-embed-text-v1")).toBe(false);
      expect(isAnthropicBedrockModel("meta.llama2-13b-chat-v1")).toBe(false);
      expect(isAnthropicBedrockModel("cohere.command-text-v14")).toBe(false);
      expect(isAnthropicBedrockModel("ai21.j2-ultra-v1")).toBe(false);
      expect(isAnthropicBedrockModel("stability.stable-diffusion-xl-v1")).toBe(false);
    });
  });

  describe("Application Inference Profile ARNs", () => {
    it("should return true when ARN profile ID segment contains 'claude'", () => {
      expect(
        isAnthropicBedrockModel(
          "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/my-claude-profile",
        ),
      ).toBe(true);
      expect(
        isAnthropicBedrockModel(
          "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/claude-sonnet",
        ),
      ).toBe(true);
      expect(
        isAnthropicBedrockModel(
          "arn:aws:bedrock:eu-west-1:987654321098:application-inference-profile/prod-claude",
        ),
      ).toBe(true);
    });

    it("should return false when ARN profile ID segment does not contain 'claude'", () => {
      expect(
        isAnthropicBedrockModel(
          "arn:aws:bedrock:us-west-2:123456789012:application-inference-profile/llama-profile",
        ),
      ).toBe(false);
      expect(
        isAnthropicBedrockModel(
          "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/my-profile",
        ),
      ).toBe(false);
      expect(
        isAnthropicBedrockModel(
          "arn:aws:bedrock:ap-southeast-1:111222333444:application-inference-profile/test",
        ),
      ).toBe(false);
    });

    it("should support aws-cn and aws-us-gov partitions", () => {
      expect(
        isAnthropicBedrockModel(
          "arn:aws-cn:bedrock:cn-north-1:123456789012:application-inference-profile/claude-profile",
        ),
      ).toBe(true);
      expect(
        isAnthropicBedrockModel(
          "arn:aws-us-gov:bedrock:us-gov-west-1:123456789012:application-inference-profile/claude-profile",
        ),
      ).toBe(true);
    });
  });

  describe("bare Application Inference Profile names", () => {
    it("should return true when bare profile name contains 'claude'", () => {
      expect(isAnthropicBedrockModel("my-claude-profile")).toBe(true);
      expect(isAnthropicBedrockModel("claude-sonnet-profile")).toBe(true);
    });

    it("should return true for profile names with underscores containing 'claude'", () => {
      expect(isAnthropicBedrockModel("my_claude_profile")).toBe(true);
      expect(isAnthropicBedrockModel("claude_sonnet_prod")).toBe(true);
    });

    it("should return false when bare profile name does not contain 'claude'", () => {
      expect(isAnthropicBedrockModel("my-profile-id")).toBe(false);
      expect(isAnthropicBedrockModel("prod-inference")).toBe(false);
      expect(isAnthropicBedrockModel("test-profile")).toBe(false);
      expect(isAnthropicBedrockModel("team_a_sonnet")).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("should handle empty strings", () => {
      expect(isAnthropicBedrockModel("")).toBe(false);
    });

    it("should handle special characters in model IDs", () => {
      expect(isAnthropicBedrockModel("anthropic.claude-3_opus@v1:0")).toBe(true);
      // IDs with special characters don't match bare profile name pattern
      expect(isAnthropicBedrockModel("model-with-special-chars!@#")).toBe(false);
    });
  });
});
