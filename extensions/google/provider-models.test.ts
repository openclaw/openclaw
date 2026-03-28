import type { ModelRegistry } from "@mariozechner/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type {
  ProviderResolveDynamicModelContext,
  ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import { resolveGoogle31ForwardCompatModel } from "./provider-models.js";

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

function createContext(params: {
  provider: string;
  modelId: string;
  models: ProviderRuntimeModel[];
}): ProviderResolveDynamicModelContext {
  return {
    provider: params.provider,
    modelId: params.modelId,
    modelRegistry: {
      find(providerId: string, modelId: string) {
        return (
          params.models.find(
            (model) =>
              model.provider === providerId && model.id.toLowerCase() === modelId.toLowerCase(),
          ) ?? null
        );
      },
    } as ModelRegistry,
  };
}

describe("resolveGoogle31ForwardCompatModel", () => {
  it("resolves gemini 3.1 pro for google aliases via an alternate template provider", () => {
    const model = resolveGoogle31ForwardCompatModel({
      providerId: "google-vertex",
      templateProviderId: "google-gemini-cli",
      ctx: createContext({
        provider: "google-vertex",
        modelId: "gemini-3.1-pro-preview",
        models: [createTemplateModel("google-gemini-cli", "gemini-3-pro-preview")],
      }),
    });

    expect(model).toMatchObject({
      provider: "google-vertex",
      id: "gemini-3.1-pro-preview",
      api: "google-gemini-cli",
      reasoning: true,
    });
  });

  it("resolves gemini 3.1 flash from direct google templates", () => {
    const model = resolveGoogle31ForwardCompatModel({
      providerId: "google",
      templateProviderId: "google-gemini-cli",
      ctx: createContext({
        provider: "google",
        modelId: "gemini-3.1-flash-preview",
        models: [createTemplateModel("google", "gemini-3-flash-preview")],
      }),
    });

    expect(model).toMatchObject({
      provider: "google",
      id: "gemini-3.1-flash-preview",
      api: "google-generative-ai",
      reasoning: true,
    });
  });

  it("prefers the flash-lite template before the broader flash prefix", () => {
    const model = resolveGoogle31ForwardCompatModel({
      providerId: "google-vertex",
      templateProviderId: "google-gemini-cli",
      ctx: createContext({
        provider: "google-vertex",
        modelId: "gemini-3.1-flash-lite-preview",
        models: [
          createTemplateModel("google-gemini-cli", "gemini-3-flash-preview", {
            contextWindow: 128_000,
          }),
          createTemplateModel("google-gemini-cli", "gemini-3.1-flash-lite-preview", {
            contextWindow: 1_048_576,
          }),
        ],
      }),
    });

    expect(model).toMatchObject({
      provider: "google-vertex",
      id: "gemini-3.1-flash-lite-preview",
      contextWindow: 1_048_576,
      reasoning: true,
    });
  });
});
