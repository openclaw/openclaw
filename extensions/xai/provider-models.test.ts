import { describe, expect, it } from "vitest";
import { resolveXaiCatalogEntry } from "./model-definitions.js";
import { isModernXaiModel, resolveXaiForwardCompatModel } from "./provider-models.js";

describe("xai provider models", () => {
  it("publishes the newer Grok fast and code models in the bundled catalog", () => {
    expect(resolveXaiCatalogEntry("grok-4-1-fast")).toMatchObject({
      id: "grok-4-1-fast",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 2_000_000,
      maxTokens: 30_000,
    });
    expect(resolveXaiCatalogEntry("grok-code-fast-1")).toMatchObject({
      id: "grok-code-fast-1",
      reasoning: true,
      contextWindow: 256_000,
      maxTokens: 10_000,
    });
  });

  it("publishes Grok 4.20 reasoning and non-reasoning models", () => {
    expect(resolveXaiCatalogEntry("grok-4.20-beta-latest-reasoning")).toMatchObject({
      id: "grok-4.20-beta-latest-reasoning",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 2_000_000,
    });
    expect(resolveXaiCatalogEntry("grok-4.20-beta-latest-non-reasoning")).toMatchObject({
      id: "grok-4.20-beta-latest-non-reasoning",
      reasoning: false,
      contextWindow: 2_000_000,
    });
  });

  it("keeps older Grok aliases resolving with current limits", () => {
    expect(resolveXaiCatalogEntry("grok-4-1-fast-reasoning")).toMatchObject({
      id: "grok-4-1-fast-reasoning",
      reasoning: true,
      contextWindow: 2_000_000,
      maxTokens: 30_000,
    });
    expect(resolveXaiCatalogEntry("grok-4.20-reasoning")).toMatchObject({
      id: "grok-4.20-reasoning",
      reasoning: true,
      contextWindow: 2_000_000,
      maxTokens: 30_000,
    });
  });

  it("publishes the remaining Grok 3 family that Pi still carries", () => {
    expect(resolveXaiCatalogEntry("grok-3-mini-fast")).toMatchObject({
      id: "grok-3-mini-fast",
      reasoning: true,
      contextWindow: 131_072,
      maxTokens: 8_192,
    });
    expect(resolveXaiCatalogEntry("grok-3-fast")).toMatchObject({
      id: "grok-3-fast",
      reasoning: false,
      contextWindow: 131_072,
      maxTokens: 8_192,
    });
  });

  it("marks current Grok families as modern while excluding multi-agent ids", () => {
    expect(isModernXaiModel("grok-4.20-beta-latest-reasoning")).toBe(true);
    expect(isModernXaiModel("grok-code-fast-1")).toBe(true);
    expect(isModernXaiModel("grok-3-mini-fast")).toBe(true);
    expect(isModernXaiModel("grok-4.20-multi-agent-experimental-beta-0304")).toBe(false);
  });

  it("builds forward-compatible runtime models for newer Grok ids", () => {
    const grok41 = resolveXaiForwardCompatModel({
      providerId: "xai",
      ctx: {
        provider: "xai",
        modelId: "grok-4-1-fast",
        modelRegistry: { find: () => null } as never,
        providerConfig: {
          api: "openai-completions",
          baseUrl: "https://api.x.ai/v1",
        },
      },
    });
    const grok420 = resolveXaiForwardCompatModel({
      providerId: "xai",
      ctx: {
        provider: "xai",
        modelId: "grok-4.20-beta-latest-reasoning",
        modelRegistry: { find: () => null } as never,
        providerConfig: {
          api: "openai-completions",
          baseUrl: "https://api.x.ai/v1",
        },
      },
    });
    const grok3Mini = resolveXaiForwardCompatModel({
      providerId: "xai",
      ctx: {
        provider: "xai",
        modelId: "grok-3-mini-fast",
        modelRegistry: { find: () => null } as never,
        providerConfig: {
          api: "openai-completions",
          baseUrl: "https://api.x.ai/v1",
        },
      },
    });

    expect(grok41).toMatchObject({
      provider: "xai",
      id: "grok-4-1-fast",
      api: "openai-completions",
      baseUrl: "https://api.x.ai/v1",
      reasoning: true,
      contextWindow: 2_000_000,
      maxTokens: 30_000,
    });
    expect(grok420).toMatchObject({
      provider: "xai",
      id: "grok-4.20-beta-latest-reasoning",
      api: "openai-completions",
      baseUrl: "https://api.x.ai/v1",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 2_000_000,
      maxTokens: 30_000,
    });
    expect(grok3Mini).toMatchObject({
      provider: "xai",
      id: "grok-3-mini-fast",
      api: "openai-completions",
      baseUrl: "https://api.x.ai/v1",
      reasoning: true,
      contextWindow: 131_072,
      maxTokens: 8_192,
    });
  });

  it("refuses the unsupported multi-agent endpoint ids", () => {
    const model = resolveXaiForwardCompatModel({
      providerId: "xai",
      ctx: {
        provider: "xai",
        modelId: "grok-4.20-multi-agent-experimental-beta-0304",
        modelRegistry: { find: () => null } as never,
        providerConfig: {
          api: "openai-completions",
          baseUrl: "https://api.x.ai/v1",
        },
      },
    });

    expect(model).toBeUndefined();
  });
});
