// Google tests cover provider models plugin behavior.
import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it } from "vitest";
import { createProviderDynamicModelContext as createContext } from "../test-support/provider-model-test-helpers.js";
import {
  isGoogleNativeVideoModelId,
  isGoogleTextGenerationModelId,
  isModernGoogleModel,
  resolveGoogleGeminiForwardCompatModel,
} from "./provider-models.js";

function createTemplateModel(
  provider: string,
  id: string,
  overrides: Partial<ProviderRuntimeModel> = {},
): ProviderRuntimeModel {
  return {
    id,
    name: id,
    provider,
    api: provider === "google-gemini-cli" ? "google-gemini-cli" : "google-generative-ai",
    baseUrl:
      provider === "google-gemini-cli"
        ? "https://cloudcode-pa.googleapis.com"
        : "https://generativelanguage.googleapis.com/v1beta",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 64_000,
    ...overrides,
  } as ProviderRuntimeModel;
}

function resolveModel(providerId: string, modelId: string, models: ProviderRuntimeModel[]) {
  return resolveGoogleGeminiForwardCompatModel({
    providerId,
    ctx: createContext({ provider: providerId, modelId, models }),
  });
}

function expectModelFields(
  model: ProviderRuntimeModel | undefined,
  fields: Partial<ProviderRuntimeModel>,
) {
  if (!model) {
    throw new Error("expected provider model");
  }
  for (const [key, value] of Object.entries(fields)) {
    expect(model[key as keyof ProviderRuntimeModel]).toEqual(value);
  }
}

describe("resolveGoogleGeminiForwardCompatModel", () => {
  it("resolves stable gemini 2.5 flash-lite from Gemini CLI templates when direct google templates are unavailable", () => {
    const model = resolveModel("google-gemini-cli", "gemini-2.5-flash-lite", [
      createTemplateModel("google-gemini-cli", "gemini-3.1-flash-lite", {
        contextWindow: 1_048_576,
        api: "google-gemini-cli",
        baseUrl: "https://cloudcode-pa.googleapis.com",
      }),
    ]);

    expectModelFields(model, {
      provider: "google-gemini-cli",
      id: "gemini-2.5-flash-lite",
      api: "google-gemini-cli",
      contextWindow: 1_048_576,
      reasoning: false,
    });
  });

  it("canonicalizes provider-qualified retired Gemini 3 Pro preview requests", () => {
    const model = resolveModel("google", "google/gemini-3-pro-preview", [
      createTemplateModel("google", "gemini-3.1-pro-preview"),
    ]);

    expectModelFields(model, {
      provider: "google",
      id: "google/gemini-3.1-pro-preview",
      api: "google-generative-ai",
      reasoning: true,
    });
  });

  it("resolves Antigravity Gemini 3.1 pro customtools from the low template", () => {
    const model = resolveGoogleGeminiForwardCompatModel({
      providerId: "google-antigravity",
      ctx: createContext({
        provider: "google-antigravity",
        modelId: "gemini-3.1-pro-preview-customtools",
        models: [
          createTemplateModel("google-antigravity", "gemini-3-pro-low", {
            api: "openai-completions",
            baseUrl: "https://antigravity.example/v1",
            contextWindow: 1_048_576,
            reasoning: true,
          }),
        ],
      }),
    });

    expectModelFields(model, {
      provider: "google-antigravity",
      id: "gemini-3.1-pro-preview-customtools",
      api: "openai-completions",
      baseUrl: "https://antigravity.example/v1",
      contextWindow: 1_048_576,
      reasoning: true,
    });
  });

  it("treats gemma models as modern google models", () => {
    expect(isModernGoogleModel("gemma-4-26b-a4b-it")).toBe(true);
    expect(isModernGoogleModel("gemma-3-4b-it")).toBe(true);
  });

  it("canonicalizes Gemma 4 26B shorthand before cloning templates", () => {
    const model = resolveModel("google", "gemma-4-26b", [
      createTemplateModel("google", "gemini-3-flash-preview", { reasoning: false }),
    ]);

    expectModelFields(model, {
      provider: "google",
      id: "gemma-4-26b-a4b-it",
      api: "google-generative-ai",
      reasoning: true,
    });
  });

  it("preserves template reasoning for non-Gemma 4 gemma models", () => {
    const model = resolveModel("google", "gemma-3-4b-it", [
      createTemplateModel("google", "gemini-3-flash-preview", { reasoning: false }),
    ]);

    expectModelFields(model, {
      provider: "google",
      id: "gemma-3-4b-it",
      reasoning: false,
    });
  });

  it("keeps non-chat Gemini surfaces out of text discovery and forward compatibility", () => {
    for (const modelId of [
      "gemini-3.1-flash-image",
      "gemini-3.1-flash-tts-preview",
      "gemini-3.8-flash-tts",
      "gemini-3.8-flash-lite-tts",
      "gemini-3.1-flash-live-preview",
      "gemini-2.5-flash-preview-native-audio-dialog",
    ]) {
      expect(isGoogleTextGenerationModelId(modelId)).toBe(false);
      expect(
        resolveGoogleGeminiForwardCompatModel({
          providerId: "google",
          ctx: createContext({
            provider: "google",
            modelId,
            models: [createTemplateModel("google", "gemini-3-flash-preview")],
          }),
        }),
      ).toBeUndefined();
    }
  });

  it("classifies only ordinary Gemini generation ids for native video", () => {
    for (const modelId of [
      "gemini-2.5-flash",
      "google/gemini-3.1-pro-preview",
      "models/gemini-flash-latest",
    ]) {
      expect(isGoogleNativeVideoModelId(modelId), modelId).toBe(true);
    }
    for (const modelId of [
      "gemma-4-26b-a4b-it",
      "tunedModels/gemini-2.5-flash",
      "gemini-3.1-flash-image",
      "gemini-2.5-computer-use-preview",
      "gemini-2.5-flash-tts-preview",
      "gemini-2.5-flash-live-preview",
    ]) {
      expect(isGoogleNativeVideoModelId(modelId), modelId).toBe(false);
    }
  });
});
