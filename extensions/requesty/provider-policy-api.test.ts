// Requesty tests cover the cold provider policy artifact.
import { describe, expect, it } from "vitest";
import { isResponseModelEquivalent } from "./provider-policy-api.js";

describe("Requesty provider policy artifact", () => {
  it.each([
    ["requesty", "claude-sonnet-4-6", "claude-sonnet-4-6", true],
    ["requesty", "anthropic/claude-sonnet-4-6", "claude-sonnet-4-6", true],
    ["requesty", "deepinfra/moonshotai/Kimi-K2.5", "moonshotai/Kimi-K2.5", true],
    ["requesty", "anthropic/claude-sonnet-4-6", "anthropic/claude-sonnet-4-6", true],
    ["requesty", "gpt-5.5", "gpt-5.5-2026-04-23", true],
    ["requesty", "claude-sonnet-4-6", "claude-sonnet-4-6-20260301", true],
    ["requesty", "gpt-5", "gpt-5-mini", false],
    ["requesty", "gpt-5.5", "gpt-5.5-sol", false],
    ["requesty", "claude-sonnet-4-6", "claude-opus-4-6", false],
    ["requesty", "claude-sonnet-4-6", "sonnet-4-6", false],
  ])(
    "declares response-model equivalence for %s/%s -> %s as %s",
    (provider, requestedModelId, responseModelId, expected) => {
      expect(isResponseModelEquivalent({ provider, requestedModelId, responseModelId })).toBe(
        expected,
      );
    },
  );

  it("leaves other providers and empty response ids to their owners", () => {
    expect(
      isResponseModelEquivalent({
        provider: "openrouter",
        requestedModelId: "anthropic/claude-sonnet-4-6",
        responseModelId: "claude-sonnet-4-6",
      }),
    ).toBeUndefined();
    expect(
      isResponseModelEquivalent({
        provider: "requesty",
        requestedModelId: "anthropic/claude-sonnet-4-6",
        responseModelId: " ",
      }),
    ).toBeUndefined();
  });
});
