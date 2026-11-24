import { describe, expect, it } from "vitest";
import { createGoogleGeminiCliProvider, createGoogleProvider } from "./provider-contract-api.js";

describe("google provider contract", () => {
  it("exposes Gemini API key setup", () => {
    const provider = createGoogleProvider();

    expect(provider.label).toBe("Gemini API key");
    expect(provider.auth).toEqual([
      expect.objectContaining({
        id: "api-key",
        label: "Gemini API key",
        hint: "Supported API-key access from aistudio.google.com/apikey",
        wizard: expect.objectContaining({
          choiceLabel: "Gemini API key",
          groupHint: "Supported API-key setup",
        }),
      }),
    ]);
  });

  it("keeps Gemini CLI as a runtime-only compatibility provider", () => {
    const provider = createGoogleGeminiCliProvider();

    expect(provider.label).toBe("Gemini CLI runtime");
    expect(provider.auth).toEqual([]);
    expect(provider.envVars).toEqual([]);
    expect(provider.wizard).toBeUndefined();
  });
});
