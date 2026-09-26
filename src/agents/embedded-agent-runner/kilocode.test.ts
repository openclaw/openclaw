// Coverage for Kilocode-specific cache-TTL eligibility.
import { describe, expect, it, vi } from "vitest";

vi.mock("../../plugins/provider-runtime.js", () => ({
  // Keep this file on built-in Kilocode rules; provider plugin overrides are
  // covered by the generic cache-ttl tests.
  resolveProviderCacheTtlEligibility: () => undefined,
}));

import { isCacheTtlEligibleProvider } from "./cache-ttl.js";

describe("kilocode cache-ttl eligibility", () => {
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
