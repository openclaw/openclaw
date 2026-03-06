import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../pi-model-discovery.js", () => ({
  discoverAuthStorage: vi.fn(() => ({ mocked: true })),
  discoverModels: vi.fn(() => ({ find: vi.fn(() => null) })),
}));

import { buildInlineProviderModels, resolveModel } from "./model.js";
import {
  buildOpenAICodexForwardCompatExpectation,
  GOOGLE_GEMINI_CLI_FLASH_TEMPLATE_MODEL,
  GOOGLE_GEMINI_CLI_PRO_TEMPLATE_MODEL,
  makeModel,
  mockDiscoveredModel,
  mockGoogleGeminiCliFlashTemplateModel,
  mockGoogleGeminiCliProTemplateModel,
  mockOpenAICodexTemplateModel,
  resetMockDiscoverModels,
} from "./model.test-harness.js";

beforeEach(() => {
  resetMockDiscoverModels();
});

describe("pi embedded model e2e smoke", () => {
  it("attaches provider ids and provider-level baseUrl for inline models", () => {
    const providers = {
      custom: {
        baseUrl: "http://localhost:8000",
        models: [makeModel("custom-model")],
      },
    };

    const result = buildInlineProviderModels(providers);
    expect(result).toEqual([
      {
        ...makeModel("custom-model"),
        provider: "custom",
        baseUrl: "http://localhost:8000",
        api: undefined,
      },
    ]);
  });

  it("builds an openai-codex forward-compat fallback for gpt-5.3-codex", () => {
    mockOpenAICodexTemplateModel();

    const result = resolveModel("openai-codex", "gpt-5.3-codex", "/tmp/agent");
    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject(buildOpenAICodexForwardCompatExpectation("gpt-5.3-codex"));
  });

  it("builds an openai forward-compat fallback for gpt-5.4", () => {
    mockDiscoveredModel({
      provider: "openai",
      modelId: "gpt-5.2",
      templateModel: {
        id: "gpt-5.2",
        name: "GPT-5.2",
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text", "image"] as const,
        cost: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
        contextWindow: 400000,
        maxTokens: 128000,
      },
    });

    const result = resolveModel("openai", "gpt-5.4", "/tmp/agent");
    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "openai",
      id: "gpt-5.4",
      name: "gpt-5.4",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      contextWindow: 400000,
      maxTokens: 128000,
    });
  });

  it("keeps unknown-model errors for non-forward-compat IDs", () => {
    const result = resolveModel("openai-codex", "gpt-4.1-mini", "/tmp/agent");
    expect(result.model).toBeUndefined();
    expect(result.error).toBe("Unknown model: openai-codex/gpt-4.1-mini");
  });

  it("builds a google-gemini-cli forward-compat fallback for gemini-3.1-pro-preview", () => {
    mockGoogleGeminiCliProTemplateModel();

    const result = resolveModel("google-gemini-cli", "gemini-3.1-pro-preview", "/tmp/agent");
    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      ...GOOGLE_GEMINI_CLI_PRO_TEMPLATE_MODEL,
      id: "gemini-3.1-pro-preview",
      name: "gemini-3.1-pro-preview",
      reasoning: true,
    });
  });

  it("builds a google-gemini-cli forward-compat fallback for gemini-3.1-flash-preview", () => {
    mockGoogleGeminiCliFlashTemplateModel();

    const result = resolveModel("google-gemini-cli", "gemini-3.1-flash-preview", "/tmp/agent");
    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      ...GOOGLE_GEMINI_CLI_FLASH_TEMPLATE_MODEL,
      id: "gemini-3.1-flash-preview",
      name: "gemini-3.1-flash-preview",
      reasoning: true,
    });
  });

  it("keeps unknown-model errors for unrecognized google-gemini-cli model IDs", () => {
    const result = resolveModel("google-gemini-cli", "gemini-4-unknown", "/tmp/agent");
    expect(result.model).toBeUndefined();
    expect(result.error).toBe("Unknown model: google-gemini-cli/gemini-4-unknown");
  });
});
