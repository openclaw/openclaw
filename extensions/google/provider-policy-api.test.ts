// Google tests cover provider policy api plugin behavior.
import { describe, expect, it, vi } from "vitest";
import { normalizeConfig, resolveThinkingProfile } from "./provider-policy-api.js";

// Config and model policy must remain usable without initializing streaming transports.
vi.mock("openclaw/plugin-sdk/provider-stream-shared", () => {
  throw new Error("Google provider policy must not load the streaming SDK");
});

function createModel(
  id: string,
  name = "Gemini 3 Pro",
): Parameters<typeof normalizeConfig>[0]["providerConfig"]["models"][number] {
  return {
    id,
    name,
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_048_576,
    maxTokens: 65_536,
  };
}

describe("google provider policy public artifact", () => {
  it("normalizes Google provider config without loading the full provider plugin", () => {
    expect(
      normalizeConfig({
        provider: "google",
        providerConfig: {
          baseUrl: "https://generativelanguage.googleapis.com",
          api: "google-generative-ai",
          apiKey: "GEMINI_API_KEY",
          models: [createModel("gemini-3-pro")],
        },
      }),
    ).toEqual({
      api: "google-generative-ai",
      apiKey: "GEMINI_API_KEY",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      models: [createModel("gemini-3.1-pro-preview")],
    });
  });

  it("normalizes retired Gemini CLI config model ids before emission", () => {
    expect(
      normalizeConfig({
        provider: "google-gemini-cli",
        providerConfig: {
          baseUrl: "openclaw://google-gemini-cli",
          models: [createModel("google/gemini-3-pro-preview", "Gemini CLI 3 Pro")],
        },
      }),
    ).toEqual({
      baseUrl: "openclaw://google-gemini-cli",
      models: [createModel("google/gemini-3.1-pro-preview", "Gemini CLI 3 Pro")],
    });
  });

  it("preserves normalized Gemini 3 aliases when catalog reasoning metadata is stale", () => {
    expect(
      resolveThinkingProfile({
        provider: "google",
        modelId: "google/gemini-3-pro",
        reasoning: false,
      }),
    ).toEqual({
      levels: [{ id: "off" }, { id: "low" }, { id: "adaptive" }, { id: "high" }],
      preserveWhenCatalogReasoningFalse: true,
    });
  });

  it("honors catalog reasoning=false for non-Gemini 3 Google models", () => {
    expect(
      resolveThinkingProfile({
        provider: "google",
        modelId: "gemma-4-26b-a4b-it",
        reasoning: false,
      }),
    ).toBeUndefined();
  });
});
