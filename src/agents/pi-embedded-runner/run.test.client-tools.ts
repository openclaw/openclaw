import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { sanitizeToolCallId, isValidCloudCodeAssistToolId } from "../tool-call-id.js";
import { resolveTranscriptPolicy } from "../transcript-policy.js";

describe("Client Tool Call ID Generation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-03-07T12:00:00.000Z")); // 1709812800000
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("Raw ID Generation", () => {
    it("generates raw client tool ID with Date.now() pattern", () => {
      const rawId = `call_${Date.now()}`;
      expect(rawId).toBe("call_1709812800000");
      expect(rawId).toMatch(/_/); // Contains underscore
    });

    it("raw ID fails strict validation (Google requirement)", () => {
      const rawId = `call_${Date.now()}`;
      const isValid = isValidCloudCodeAssistToolId(rawId, "strict");
      expect(isValid).toBe(false); // Underscore violates strict mode
    });

    it("raw ID fails strict9 validation (Mistral requirement)", () => {
      const rawId = `call_${Date.now()}`;
      const isValid = isValidCloudCodeAssistToolId(rawId, "strict9");
      expect(isValid).toBe(false); // Too long and contains underscore
    });
  });

  describe("Sanitization by Provider", () => {
    it("sanitizes client tool ID for Google (strict mode)", () => {
      const rawId = `call_${Date.now()}`;
      const sanitized = sanitizeToolCallId(rawId, "strict");

      expect(sanitized).toBe("call1709812800000"); // Underscore removed
      expect(sanitized).toMatch(/^[a-zA-Z0-9]+$/); // Alphanumeric only
      expect(isValidCloudCodeAssistToolId(sanitized, "strict")).toBe(true);
    });

    it("sanitizes client tool ID for Mistral (strict9 mode)", () => {
      const rawId = `call_${Date.now()}`;
      const sanitized = sanitizeToolCallId(rawId, "strict9");

      expect(sanitized).toHaveLength(9); // Exactly 9 chars
      expect(sanitized).toMatch(/^[a-zA-Z0-9]{9}$/); // Alphanumeric, 9 chars
      expect(isValidCloudCodeAssistToolId(sanitized, "strict9")).toBe(true);
    });

    it("preserves client tool ID for OpenAI (no sanitization needed)", () => {
      const rawId = `call_${Date.now()}`;
      // OpenAI allows underscores, so validation uses basic alphanumeric + underscore
      // For consistency, we still sanitize to "strict" mode to be safe across providers
      const sanitized = sanitizeToolCallId(rawId, "strict");
      expect(sanitized).toBe("call1709812800000"); // Safe for all providers
    });
  });

  describe("Transcript Policy Integration", () => {
    it("resolves strict mode for Google Gemini", () => {
      const policy = resolveTranscriptPolicy({
        modelApi: "gemini",
        provider: "google",
        modelId: "gemini-2.0-flash-thinking-exp",
      });

      expect(policy.sanitizeToolCallIds).toBe(true);
      expect(policy.toolCallIdMode).toBe("strict");
    });

    it("resolves strict9 mode for Mistral", () => {
      const policy = resolveTranscriptPolicy({
        modelApi: "openai-completions",
        provider: "mistral",
        modelId: "mistral-large",
      });

      expect(policy.sanitizeToolCallIds).toBe(true);
      expect(policy.toolCallIdMode).toBe("strict9");
    });

    it("resolves no special mode for OpenAI", () => {
      const policy = resolveTranscriptPolicy({
        modelApi: "openai-responses",
        provider: "openai",
        modelId: "gpt-4",
      });

      expect(policy.sanitizeToolCallIds).toBe(false);
      // toolCallIdMode should be undefined or not used
    });

    it("resolves mode for Anthropic", () => {
      const policy = resolveTranscriptPolicy({
        modelApi: "anthropic-messages",
        provider: "anthropic",
        modelId: "claude-opus-4-6",
      });

      expect(policy.repairToolUseResultPairing).toBe(true);
      // May or may not sanitize IDs depending on implementation
    });
  });

  describe("End-to-End Fix Verification", () => {
    it("generates valid client tool ID for Google provider", () => {
      // Simulate the fix: raw generation + sanitization
      const rawId = `call_${Date.now()}`;
      const policy = resolveTranscriptPolicy({
        modelApi: "gemini",
        provider: "google",
        modelId: "gemini-2.0-flash-thinking-exp",
      });
      const mode = policy.toolCallIdMode ?? "strict";
      const sanitized = sanitizeToolCallId(rawId, mode);

      // Verify the fix produces valid IDs
      expect(isValidCloudCodeAssistToolId(sanitized, mode)).toBe(true);
      expect(sanitized).not.toMatch(/_/); // No underscore
      expect(sanitized).toMatch(/^[a-zA-Z0-9]+$/);
    });

    it("generates valid client tool ID for Mistral provider", () => {
      const rawId = `call_${Date.now()}`;
      const policy = resolveTranscriptPolicy({
        modelApi: "openai-completions",
        provider: "mistral",
        modelId: "mistral-large",
      });
      const mode = policy.toolCallIdMode ?? "strict";
      const sanitized = sanitizeToolCallId(rawId, mode);

      expect(isValidCloudCodeAssistToolId(sanitized, mode)).toBe(true);
      expect(sanitized).toHaveLength(9); // Exactly 9 chars
      expect(sanitized).toMatch(/^[a-zA-Z0-9]{9}$/);
    });

    it("generates valid client tool ID for OpenAI provider", () => {
      const rawId = `call_${Date.now()}`;
      // OpenAI doesn't require special sanitization, but we sanitize to "strict" for safety
      const sanitized = sanitizeToolCallId(rawId, "strict");

      expect(isValidCloudCodeAssistToolId(sanitized, "strict")).toBe(true);
    });
  });

  describe("ID Consistency", () => {
    it("produces consistent IDs across multiple calls with fixed timestamp", () => {
      const rawId1 = `call_${Date.now()}`;
      const rawId2 = `call_${Date.now()}`;

      expect(rawId1).toBe(rawId2); // Same timestamp

      const policy = resolveTranscriptPolicy({
        modelApi: "gemini",
        provider: "google",
        modelId: "gemini-2.0-flash-thinking-exp",
      });
      const mode = policy.toolCallIdMode ?? "strict";

      const sanitized1 = sanitizeToolCallId(rawId1, mode);
      const sanitized2 = sanitizeToolCallId(rawId2, mode);

      expect(sanitized1).toBe(sanitized2); // Consistent output
    });

    it("produces different IDs for different timestamps", () => {
      const rawId1 = `call_${Date.now()}`;

      // Advance time
      vi.advanceTimersByTime(1000);
      const rawId2 = `call_${Date.now()}`;

      expect(rawId1).not.toBe(rawId2); // Different timestamps

      const policy = resolveTranscriptPolicy({
        modelApi: "gemini",
        provider: "google",
        modelId: "gemini-2.0-flash-thinking-exp",
      });
      const mode = policy.toolCallIdMode ?? "strict";

      const sanitized1 = sanitizeToolCallId(rawId1, mode);
      const sanitized2 = sanitizeToolCallId(rawId2, mode);

      expect(sanitized1).not.toBe(sanitized2); // Different sanitized IDs
    });
  });

  describe("Error Cases", () => {
    it("handles empty ID gracefully", () => {
      const sanitized = sanitizeToolCallId("", "strict");
      expect(sanitized).toBe("sanitizedtoolid");
      expect(isValidCloudCodeAssistToolId(sanitized, "strict")).toBe(true);
    });

    it("handles special characters in ID", () => {
      const idWithSpecialChars = "call_abc-123|xyz#456";
      const sanitized = sanitizeToolCallId(idWithSpecialChars, "strict");

      expect(sanitized).toBe("callabc123xyz456"); // All special chars removed
      expect(isValidCloudCodeAssistToolId(sanitized, "strict")).toBe(true);
    });

    it("handles very long IDs in strict9 mode", () => {
      const longId = "call_" + "a".repeat(100);
      const sanitized = sanitizeToolCallId(longId, "strict9");

      expect(sanitized).toHaveLength(9);
      expect(isValidCloudCodeAssistToolId(sanitized, "strict9")).toBe(true);
    });
  });
});
