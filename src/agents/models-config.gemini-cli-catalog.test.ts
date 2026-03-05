import { describe, expect, it } from "vitest";
import { buildGoogleGeminiCliProvider } from "./models-config.providers.js";

describe("buildGoogleGeminiCliProvider", () => {
  it("includes Gemini 3.0 models for backward compatibility", () => {
    const provider = buildGoogleGeminiCliProvider();
    const ids = provider.models?.map((m) => m.id) ?? [];
    expect(ids).toContain("gemini-3-pro-preview");
    expect(ids).toContain("gemini-3-flash-preview");
  });

  it("includes Gemini 3.1 models", () => {
    const provider = buildGoogleGeminiCliProvider();
    const ids = provider.models?.map((m) => m.id) ?? [];
    expect(ids).toContain("gemini-3.1-pro-preview");
    expect(ids).toContain("gemini-3.1-flash-preview");
  });

  it("marks Gemini 3.1 Pro as reasoning-capable", () => {
    const provider = buildGoogleGeminiCliProvider();
    const model = provider.models?.find((m) => m.id === "gemini-3.1-pro-preview");
    expect(model?.reasoning).toBe(true);
  });

  it("marks Gemini 3 Flash as non-reasoning", () => {
    const provider = buildGoogleGeminiCliProvider();
    const model = provider.models?.find((m) => m.id === "gemini-3-flash-preview");
    expect(model?.reasoning).toBe(false);
  });

  it("uses google-generative-ai API", () => {
    const provider = buildGoogleGeminiCliProvider();
    expect(provider.api).toBe("google-generative-ai");
  });

  it("uses the Google Generative AI base URL", () => {
    const provider = buildGoogleGeminiCliProvider();
    expect(provider.baseUrl).toBe("https://generativelanguage.googleapis.com/v1beta");
  });

  it("all models support text and image input", () => {
    const provider = buildGoogleGeminiCliProvider();
    for (const model of provider.models ?? []) {
      expect(model.input).toContain("text");
      expect(model.input).toContain("image");
    }
  });

  it("all models have a 1M token context window", () => {
    const provider = buildGoogleGeminiCliProvider();
    for (const model of provider.models ?? []) {
      expect(model.contextWindow).toBe(1_048_576);
    }
  });
});
