import { describe, expect, it } from "vitest";
import { isAnthropicBedrockModel } from "./anthropic-stream-wrappers.js";

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

    it("should return true for new US Anthropic Bedrock model IDs", () => {
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
    it("should return true for Application Inference Profile ARNs when model name contains 'claude'", () => {
      const arn =
        "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/my-claude-profile";
      expect(isAnthropicBedrockModel(arn, "Claude 3 Opus Profile")).toBe(true);
      expect(isAnthropicBedrockModel(arn, "My Claude Model")).toBe(true);
      expect(isAnthropicBedrockModel(arn, "claude-profile")).toBe(true);
      expect(isAnthropicBedrockModel(arn, "CLAUDE-PROFILE")).toBe(true);
    });

    it("should return false for Application Inference Profile ARNs when model name does not contain 'claude'", () => {
      const arn =
        "arn:aws:bedrock:us-west-2:123456789012:application-inference-profile/llama-profile";
      expect(isAnthropicBedrockModel(arn, "Llama 2 Profile")).toBe(false);
      expect(isAnthropicBedrockModel(arn, "Titan Model")).toBe(false);
      expect(isAnthropicBedrockModel(arn, "General Model")).toBe(false);
    });

    it("should return false for Application Inference Profile ARNs when model name is not provided", () => {
      const arn = "arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/my-profile";
      expect(isAnthropicBedrockModel(arn)).toBe(false);
      expect(isAnthropicBedrockModel(arn, undefined)).toBe(false);
    });

    it("should handle Application Inference Profile ARNs with various formats", () => {
      expect(
        isAnthropicBedrockModel(
          "arn:aws:bedrock:eu-west-1:987654321098:application-inference-profile/prod-claude",
          "Production Claude Model",
        ),
      ).toBe(true);
      expect(
        isAnthropicBedrockModel(
          "arn:aws:bedrock:ap-southeast-1:111222333444:application-inference-profile/test",
          "Test Claude Instance",
        ),
      ).toBe(true);
    });
  });

  describe("short Application Inference Profile IDs", () => {
    it("should return true when short ID is provided with model name containing 'claude'", () => {
      expect(isAnthropicBedrockModel("my-profile-id", "Claude Profile")).toBe(true);
      expect(isAnthropicBedrockModel("prod-inference", "Production Claude")).toBe(true);
      expect(isAnthropicBedrockModel("test-profile", "claude-test")).toBe(true);
    });

    it("should return false when short ID is provided with model name not containing 'claude'", () => {
      expect(isAnthropicBedrockModel("my-profile-id", "Titan Profile")).toBe(false);
      expect(isAnthropicBedrockModel("prod-inference", "Production Llama")).toBe(false);
      expect(isAnthropicBedrockModel("test-profile", "test-model")).toBe(false);
    });

    it("should return false for short IDs without model name", () => {
      expect(isAnthropicBedrockModel("my-profile-id")).toBe(false);
      expect(isAnthropicBedrockModel("prod-inference")).toBe(false);
      expect(isAnthropicBedrockModel("test-profile")).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("should handle empty strings", () => {
      expect(isAnthropicBedrockModel("")).toBe(false);
      expect(isAnthropicBedrockModel("", "")).toBe(false);
      expect(isAnthropicBedrockModel("", "Claude Model")).toBe(false);
    });

    it("should handle model names with 'claude' in different positions", () => {
      expect(isAnthropicBedrockModel("some-id", "claude")).toBe(true);
      expect(isAnthropicBedrockModel("some-id", "claude-at-start")).toBe(true);
      expect(isAnthropicBedrockModel("some-id", "middle-claude-here")).toBe(true);
      expect(isAnthropicBedrockModel("some-id", "ends-with-claude")).toBe(true);
      expect(isAnthropicBedrockModel("some-id", "CLAUDE")).toBe(true);
      expect(isAnthropicBedrockModel("some-id", "ClAuDe")).toBe(true);
    });

    it("should match claude as a substring in any position within model names", () => {
      // These should still match because they contain 'claude' as a substring
      expect(isAnthropicBedrockModel("some-id", "unclaude")).toBe(true);
      expect(isAnthropicBedrockModel("some-id", "claudette")).toBe(true);
    });

    it("should handle special characters in model IDs and names", () => {
      expect(isAnthropicBedrockModel("anthropic.claude-3_opus@v1:0")).toBe(true);
      expect(isAnthropicBedrockModel("model-with-special-chars!@#", "Claude Model!")).toBe(true);
    });
  });

  describe("backward compatibility", () => {
    it("should maintain backward compatibility when modelName parameter is not provided", () => {
      // These should work exactly as before when no modelName is provided
      expect(isAnthropicBedrockModel("anthropic.claude-3-opus-20240229-v1:0")).toBe(true);
      expect(isAnthropicBedrockModel("amazon.titan-text-express-v1")).toBe(false);
      expect(isAnthropicBedrockModel("us.anthropic.claude-opus-4-6-v1:0")).toBe(true);
    });
  });
});
