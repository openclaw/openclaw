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

  it("builds an openai-codex forward-compat fallback for gpt-5.4", () => {
    mockOpenAICodexTemplateModel();

    const result = resolveModel("openai-codex", "gpt-5.4", "/tmp/agent");
    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject(buildOpenAICodexForwardCompatExpectation("gpt-5.4"));
  });

  it("applies native 1.05M context window for openai-codex/gpt-5.4 via template", () => {
    mockOpenAICodexTemplateModel();

    const result = resolveModel("openai-codex", "gpt-5.4", "/tmp/agent");
    expect(result.error).toBeUndefined();
    expect(result.model?.contextWindow).toBe(1_050_000);
    expect(result.model?.maxTokens).toBe(128_000);
  });

  it("applies native 1.05M context window for openai-codex/gpt-5.4 without template", () => {
    // No template mocked — exercises the hard-coded fallback path
    const result = resolveModel("openai-codex", "gpt-5.4", "/tmp/agent");
    expect(result.error).toBeUndefined();
    expect(result.model?.contextWindow).toBe(1_050_000);
    expect(result.model?.maxTokens).toBe(128_000);
  });

  it("preserves template context window for openai-codex/gpt-5.3-codex", () => {
    mockOpenAICodexTemplateModel();

    const result = resolveModel("openai-codex", "gpt-5.3-codex", "/tmp/agent");
    expect(result.error).toBeUndefined();
    expect(result.model?.contextWindow).toBe(272_000);
    expect(result.model?.maxTokens).toBe(128_000);
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

  it("builds a google-gemini-cli forward-compat fallback for gemini-3.1-flash-lite-preview", () => {
    mockGoogleGeminiCliFlashTemplateModel();

    const result = resolveModel("google-gemini-cli", "gemini-3.1-flash-lite-preview", "/tmp/agent");
    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      ...GOOGLE_GEMINI_CLI_FLASH_TEMPLATE_MODEL,
      id: "gemini-3.1-flash-lite-preview",
      name: "gemini-3.1-flash-lite-preview",
      reasoning: true,
    });
  });

  it("builds a google forward-compat fallback for gemini-3.1-pro-preview", () => {
    mockDiscoveredModel({
      provider: "google",
      modelId: "gemini-3-pro-preview",
      templateModel: {
        ...GOOGLE_GEMINI_CLI_PRO_TEMPLATE_MODEL,
        provider: "google",
        api: "google-generative-ai",
        baseUrl: "https://generativelanguage.googleapis.com",
      },
    });

    const result = resolveModel("google", "gemini-3.1-pro-preview", "/tmp/agent");
    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "google",
      api: "google-generative-ai",
      baseUrl: "https://generativelanguage.googleapis.com",
      id: "gemini-3.1-pro-preview",
      name: "gemini-3.1-pro-preview",
      reasoning: true,
    });
  });

  it("builds a google forward-compat fallback for gemini-3.1-flash-lite-preview", () => {
    mockDiscoveredModel({
      provider: "google",
      modelId: "gemini-3-flash-preview",
      templateModel: {
        ...GOOGLE_GEMINI_CLI_FLASH_TEMPLATE_MODEL,
        provider: "google",
        api: "google-generative-ai",
        baseUrl: "https://generativelanguage.googleapis.com",
      },
    });

    const result = resolveModel("google", "gemini-3.1-flash-lite-preview", "/tmp/agent");
    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "google",
      api: "google-generative-ai",
      baseUrl: "https://generativelanguage.googleapis.com",
      id: "gemini-3.1-flash-lite-preview",
      name: "gemini-3.1-flash-lite-preview",
      reasoning: true,
    });
  });

  it("keeps unknown-model errors for unrecognized google-gemini-cli model IDs", () => {
    const result = resolveModel("google-gemini-cli", "gemini-4-unknown", "/tmp/agent");
    expect(result.model).toBeUndefined();
    expect(result.error).toBe("Unknown model: google-gemini-cli/gemini-4-unknown");
  });
});
