import { describe, expect, it } from "vitest";
import { isCacheTtlEligibleProvider } from "./cache-ttl.js";

describe("kilocode cache-ttl eligibility", () => {
  it("allows anthropic models", () => {
    for (const modelId of ["anthropic/claude-opus-4.6", "anthropic/claude-sonnet-4"] as const) {
      expect(isCacheTtlEligibleProvider("kilocode", modelId)).toBe(true);
    }
  });

  it("is not eligible for non-anthropic models on kilocode", () => {
    expect(isCacheTtlEligibleProvider("kilocode", "openai/gpt-5")).toBe(false);
  });

  it("is case-insensitive for provider name", () => {
    for (const [provider, modelId] of [
      ["Kilocode", "anthropic/claude-opus-4.6"],
      ["KILOCODE", "Anthropic/claude-opus-4.6"],
    ] as const) {
      expect(isCacheTtlEligibleProvider(provider, modelId)).toBe(true);
    }
  });
});
