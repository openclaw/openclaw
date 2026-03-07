import { describe, expect, it } from "vitest";
import { isCacheTtlEligibleProvider } from "./cache-ttl.js";

describe("isCacheTtlEligibleProvider: fal-openrouter", () => {
  it("eligible for anthropic models via fal-openrouter", () => {
    expect(isCacheTtlEligibleProvider("fal-openrouter", "anthropic/claude-sonnet-4.6")).toBe(true);
  });

  it("not eligible for non-anthropic models via fal-openrouter", () => {
    expect(isCacheTtlEligibleProvider("fal-openrouter", "google/gemini-2.5-flash")).toBe(false);
  });

  it("eligible for anthropic models via regular openrouter", () => {
    expect(isCacheTtlEligibleProvider("openrouter", "anthropic/claude-sonnet-4.6")).toBe(true);
  });
});
