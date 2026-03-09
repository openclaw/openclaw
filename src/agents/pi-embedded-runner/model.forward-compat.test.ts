import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../pi-model-discovery.js", () => ({
  discoverAuthStorage: vi.fn(() => ({ mocked: true })),
  discoverModels: vi.fn(() => ({ find: vi.fn(() => null) })),
}));

import { buildInlineProviderModels, resolveModel } from "./model.js";
import {
  buildOpenAICodexForwardCompatExpectation,
  makeModel,
  mockDiscoveredModel,
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

  it("builds an openai forward-compat fallback for gpt-5.4-codex", () => {
    mockDiscoveredModel({
      provider: "openai",
      modelId: "gpt-5.2-codex",
      templateModel: {
        id: "gpt-5.2-codex",
        name: "GPT-5.2 Codex",
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 1, output: 4, cacheRead: 0.1, cacheWrite: 0.5 },
        contextWindow: 400000,
        maxTokens: 128000,
      },
    });

    const result = resolveModel("openai", "gpt-5.4-codex", "/tmp/agent");
    expect(result.error).toBeUndefined();
    expect(result.model).toMatchObject({
      provider: "openai",
      id: "gpt-5.4-codex",
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
});
