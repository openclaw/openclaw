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

function thinking(modelId: string) {
  return resolveThinkingProfile({ provider: "google", modelId, reasoning: false });
}

describe("google provider policy public artifact", () => {
  it("normalizes Google provider config without loading the full provider plugin", () => {
    const providerConfig = {
      baseUrl: "https://generativelanguage.googleapis.com",
      api: "google-generative-ai" as const,
      apiKey: "GEMINI_API_KEY",
      models: [createModel("gemini-3-pro")],
    };
    const expected = {
      ...providerConfig,
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      models: [createModel("gemini-3.1-pro-preview")],
    };
    expect(normalizeConfig({ provider: "google", providerConfig })).toEqual(expected);
  });

  it("preserves explicit OpenAI-compatible Google endpoints during normalization", () => {
    expect(
      normalizeConfig({
        provider: "google",
        providerConfig: {
          baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
          api: "openai-completions",
          models: [],
        },
      }),
    ).toEqual({
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      api: "openai-completions",
      models: [],
    });
  });

  it("normalizes retired Google model ids even for explicit OpenAI-compatible endpoints", () => {
    expect(
      normalizeConfig({
        provider: "google",
        providerConfig: {
          baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
          api: "openai-completions",
          models: [createModel("google/gemini-3-pro-preview")],
        },
      }),
    ).toEqual({
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      api: "openai-completions",
      models: [createModel("google/gemini-3.1-pro-preview")],
    });
  });

  it("normalizes retired Gemini CLI config model ids before emission", () => {
    const baseUrl = "openclaw://google-gemini-cli";
    expect(
      normalizeConfig({
        provider: "google-gemini-cli",
        providerConfig: {
          baseUrl,
          models: [createModel("google/gemini-3-pro-preview", "Gemini CLI 3 Pro")],
        },
      }),
    ).toEqual({
      baseUrl,
      models: [createModel("google/gemini-3.1-pro-preview", "Gemini CLI 3 Pro")],
    });
  });

  it("preserves Gemini 3 thinking levels when catalog reasoning metadata is stale", () => {
    expect(
      resolveThinkingProfile({
        provider: "google",
        modelId: "gemini-3-flash-preview",
        reasoning: false,
      }),
    ).toEqual({
      levels: [
        { id: "off" },
        { id: "minimal" },
        { id: "low" },
        { id: "medium" },
        { id: "adaptive" },
        { id: "high" },
      ],
      preserveWhenCatalogReasoningFalse: true,
    });
  });

  it("preserves provider-prefixed Gemini 3 thinking levels when catalog reasoning metadata is stale", () => {
    expect(
      resolveThinkingProfile({
        provider: "google",
        modelId: "google/gemini-3-flash-preview",
        reasoning: false,
      }),
    ).toMatchObject({
      levels: expect.arrayContaining([{ id: "low" }, { id: "medium" }, { id: "adaptive" }]),
      preserveWhenCatalogReasoningFalse: true,
    });
  });

  it("preserves normalized Gemini 3 aliases when catalog reasoning metadata is stale", () => {
    expect(thinking("google/gemini-3-pro")).toEqual({
      levels: [{ id: "off" }, { id: "low" }, { id: "adaptive" }, { id: "high" }],
      preserveWhenCatalogReasoningFalse: true,
    });
  });

  it.each(["gemini-4-argon", "google/gemini-4-argon"])(
    "keeps the Gemini 4 thinking profile for %s despite stale catalog reasoning",
    (modelId) => {
      expect(thinking(modelId)?.preserveWhenCatalogReasoningFalse).toBe(true);
    },
  );

  it("honors catalog reasoning=false for non-thinking-level Google models", () => {
    expect(thinking("gemma-4-26b-a4b-it")).toBeUndefined();
  });
});
