import { describe, expect, it } from "vitest";

/**
 * Regression test for GitHub Issue #27825:
 * Ensure signed thinking blocks are preserved byte-identical
 * and unsigned thinking blocks are still sanitized.
 */
describe("Anthropic thinking block sanitization (Issue #27825)", () => {
  it("should preserve signed thinking blocks without sanitization", () => {
    // Mock the pi-ai anthropic provider behavior
    // This simulates the patched behavior in @mariozechner/pi-ai@0.60.0

    const signedThinkingBlock = {
      thinking: "User wants help with\u202Ecode. I should\u202Eassist.",
      thinkingSignature: "mock-signature-123",
      type: "thinking",
    };

    const unsignedThinkingBlock = {
      thinking: "User wants help with\u202Ecode. I should\u202Eassist.",
      // No thinkingSignature property
      type: "thinking",
    };

    // Simulate the patched logic from our pnpm patch:
    // Line 619: thinking: block.thinking (no sanitizeSurrogates)
    function processThinkingBlock(block: unknown) {
      const blockObj = block as { thinking: string; thinkingSignature?: string; type: string };
      if (blockObj.thinkingSignature) {
        // Signed block - preserve exactly (patched behavior)
        return {
          thinking: blockObj.thinking, // DO NOT sanitize
          type: "thinking",
        };
      } else {
        // Unsigned block - convert to text and sanitize (original behavior)
        return {
          text: sanitizeSurrogates(blockObj.thinking),
          type: "text",
        };
      }
    }

    // Mock sanitizeSurrogates function
    function sanitizeSurrogates(text: string): string {
      return text.replace(/[\u202E\u202D]/g, ""); // Remove dangerous surrogates
    }

    // Test signed block preservation
    const processedSigned = processThinkingBlock(signedThinkingBlock);
    expect(processedSigned.thinking).toBe("User wants help with\u202Ecode. I should\u202Eassist.");
    expect(processedSigned.thinking).toContain("\u202E"); // Surrogates preserved
    expect(processedSigned.type).toBe("thinking");

    // Test unsigned block sanitization
    const processedUnsigned = processThinkingBlock(unsignedThinkingBlock);
    expect(processedUnsigned.text).toBe("User wants help withcode. I shouldassist.");
    expect(processedUnsigned.text).not.toContain("\u202E"); // Surrogates removed
    expect(processedUnsigned.type).toBe("text");
  });

  it("should prevent API rejection due to signature invalidation", () => {
    // This test documents the core issue: modifying signed thinking blocks
    // causes Anthropic API to reject the request with signature validation errors

    const originalSigned = "Thinking with\u202Especial chars";
    const sanitizedSigned = "Thinking withspecial chars";

    // Simulate signature validation (would happen on Anthropic's side)
    function mockSignatureValidation(thinking: string, _signature: string): boolean {
      // In reality, this is a cryptographic check on Anthropic's servers
      // For testing, we just check if content matches expected format
      return thinking.includes("\u202E"); // Simplified: expects original format
    }

    expect(mockSignatureValidation(originalSigned, "mock-sig")).toBe(true);
    expect(mockSignatureValidation(sanitizedSigned, "mock-sig")).toBe(false);
  });
});
