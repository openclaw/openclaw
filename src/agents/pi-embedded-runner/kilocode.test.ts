import { describe, expect, it } from "vitest";
import { isCacheTtlEligibleProvider } from "./cache-ttl.js";

describe("kilocode cache-ttl eligibility", () => {
  it("is eligible when model starts with anthropic/", () => {
    expect(isCacheTtlEligibleProvider("kilocode", "anthropic/claude-opus-4.6")).toBe(true);
  });

  it("is eligible with other anthropic models", () => {
    expect(isCacheTtlEligibleProvider("kilocode", "anthropic/claude-sonnet-4")).toBe(true);
  });

  it("is eligible for non-anthropic models on kilocode", () => {
    expect(isCacheTtlEligibleProvider("kilocode", "openai/gpt-5")).toBe(true);
  });

  it("is case-insensitive for provider name", () => {
    expect(isCacheTtlEligibleProvider("Kilocode", "anthropic/claude-opus-4.6")).toBe(true);
    expect(isCacheTtlEligibleProvider("KILOCODE", "Anthropic/claude-opus-4.6")).toBe(true);
  });
});
