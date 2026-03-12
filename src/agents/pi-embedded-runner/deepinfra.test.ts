import { describe, expect, it } from "vitest";
import { isCacheTtlEligibleProvider } from "./cache-ttl.ts";

describe("deepinfra cache-ttl eligibility", () => {
  it("is eligible when model starts with zai", () => {
    expect(isCacheTtlEligibleProvider("deepinfra", "zai-org/glm-5")).toBe(true);
  });

  it("is eligible when model starts with moonshot", () => {
    expect(isCacheTtlEligibleProvider("deepinfra", "moonshotai/kimi-k2.5")).toBe(true);
  });

  it("is not eligible for other models on deepinfra", () => {
    expect(isCacheTtlEligibleProvider("deepinfra", "openai/gpt-oss-120b")).toBe(false);
  });

  it("is case-insensitive for provider name", () => {
    expect(isCacheTtlEligibleProvider("DeepInfra", "moonshotai/kimi-k2.5")).toBe(true);
    expect(isCacheTtlEligibleProvider("DEEPINFRA", "Moonshotai/kimi-k2.5")).toBe(true);
  });
});
