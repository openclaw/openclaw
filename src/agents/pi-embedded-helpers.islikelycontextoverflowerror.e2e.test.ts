import { describe, expect, it } from "vitest";
import { isLikelyContextOverflowError } from "./pi-embedded-helpers.js";

describe("isLikelyContextOverflowError", () => {
  it("matches context overflow hints", () => {
    const samples = [
      "Model context window is 128k tokens, you requested 256k tokens",
      "Context window exceeded: requested 12000 tokens",
      "Prompt too large for this model",
    ];
    for (const sample of samples) {
      expect(isLikelyContextOverflowError(sample)).toBe(true);
    }
  });

  it("excludes context window too small errors", () => {
    const samples = [
      "Model context window too small (minimum is 128k tokens)",
      "Context window too small: minimum is 1000 tokens",
    ];
    for (const sample of samples) {
      expect(isLikelyContextOverflowError(sample)).toBe(false);
    }
  });

  it("excludes rate limit errors that match the broad hint regex", () => {
    const samples = [
      "request reached organization TPD rate limit, current: 1506556, limit: 1500000",
      "rate limit exceeded",
      "too many requests",
      "429 Too Many Requests",
      "exceeded your current quota",
      "This request would exceed your account's rate limit",
      "429 Too Many Requests: request exceeds rate limit",
    ];
    for (const sample of samples) {
      expect(isLikelyContextOverflowError(sample)).toBe(false);
    }
  });
});
