// Pioneer provider-catalog tests cover live model discovery expansion.
import type { ProviderCatalogContext } from "openclaw/plugin-sdk/provider-catalog-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCachedLiveProviderModelRows: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/provider-catalog-live-runtime", () => ({
  getCachedLiveProviderModelRows: mocks.getCachedLiveProviderModelRows,
}));

import {
  buildLivePioneerProvider,
  buildPioneerCatalogResult,
  buildPioneerProvider,
} from "./provider-catalog.js";

function buildCatalogContext(params: {
  apiKey?: string;
  discoveryApiKey?: string;
  envApiKey?: string;
  envDiscoveryApiKey?: string;
  baseUrl?: string;
}): ProviderCatalogContext {
  return {
    config: params.baseUrl
      ? {
          models: {
            providers: {
              pioneer: {
                baseUrl: params.baseUrl,
              },
            },
          },
        }
      : {},
    env: {},
    resolveProviderApiKey: () => ({
      apiKey: params.envApiKey ?? params.apiKey,
      discoveryApiKey: params.envDiscoveryApiKey ?? params.discoveryApiKey,
    }),
    resolveProviderAuth: () => ({
      apiKey: params.apiKey,
      discoveryApiKey: params.discoveryApiKey,
      mode: params.apiKey ? "api_key" : "none",
      source: params.apiKey ? "profile" : "none",
    }),
  };
}

describe("Pioneer provider catalog", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("builds the static bootstrap provider", () => {
    const provider = buildPioneerProvider();

    expect(provider.baseUrl).toBe("https://api.pioneer.ai/v1");
    expect(provider.api).toBe("openai-completions");
    // Static catalog includes claude-sonnet-4-6 and pioneer/auto
    expect(provider.models.map((model) => model.id)).toEqual(["claude-sonnet-4-6", "pioneer/auto"]);
  });

  it("includes live-only model ids from Pioneer /models", async () => {
    mocks.getCachedLiveProviderModelRows.mockResolvedValueOnce([
      { id: "claude-sonnet-4-6", object: "model" },
      { id: "sakana/fugu-ultra", object: "model" },
      // anthropic/pioneer/ prefix is stripped → deduplicates with claude-sonnet-4-6
      { id: "anthropic/pioneer/claude-sonnet-4-6", object: "model" },
    ]);

    const provider = await buildLivePioneerProvider({ apiKey: "sk-pioneer" });

    expect(mocks.getCachedLiveProviderModelRows).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "pioneer",
        endpoint: "https://api.pioneer.ai/v1/models",
        apiKey: "sk-pioneer",
        auditContext: "pioneer-model-discovery",
      }),
    );
    // anthropic/pioneer/claude-sonnet-4-6 strips to claude-sonnet-4-6, deduped
    expect(provider.models.map((model) => model.id)).toEqual([
      "claude-sonnet-4-6",
      "sakana/fugu-ultra",
    ]);
    const fugu = provider.models.find((model) => model.id === "sakana/fugu-ultra");
    expect(fugu?.input).toEqual(["text"]);
    expect(fugu?.contextWindow).toBe(128_000);
    expect(fugu?.maxTokens).toBe(16_384);
    const sonnet = provider.models.find((model) => model.id === "claude-sonnet-4-6");
    expect(sonnet?.contextWindow).toBe(1_000_000);
  });

  it("uses live row metadata when Pioneer returns it", async () => {
    mocks.getCachedLiveProviderModelRows.mockResolvedValueOnce([
      {
        id: "new/vision-model",
        name: "New Vision Model",
        object: "model",
        context_length: 262144,
        max_output_tokens: 32768,
        input_modalities: ["text", "image"],
        supports_reasoning: true,
      },
    ]);

    const provider = await buildLivePioneerProvider({ apiKey: "sk-pioneer" });
    const model = provider.models[0];

    expect(model).toMatchObject({
      id: "new/vision-model",
      name: "New Vision Model",
      input: ["text", "image"],
      reasoning: true,
      contextWindow: 262_144,
      maxTokens: 32_768,
    });
  });

  it("returns live-only rows through the provider catalog hook", async () => {
    mocks.getCachedLiveProviderModelRows.mockResolvedValueOnce([
      { id: "sakana/fugu-ultra", object: "model" },
    ]);

    const result = await buildPioneerCatalogResult(buildCatalogContext({ apiKey: "sk-pioneer" }));

    expect(result).toMatchObject({
      provider: {
        models: [
          {
            id: "sakana/fugu-ultra",
          },
        ],
      },
    });
  });

  it("falls back to the static provider when live discovery fails", async () => {
    mocks.getCachedLiveProviderModelRows.mockRejectedValueOnce(new Error("offline"));

    const provider = await buildLivePioneerProvider({ apiKey: "sk-pioneer" });

    expect(provider.models.map((model) => model.id)).toEqual(["claude-sonnet-4-6", "pioneer/auto"]);
  });

  it("reads context window from max_input_tokens field", async () => {
    mocks.getCachedLiveProviderModelRows.mockResolvedValueOnce([
      {
        id: "some/model",
        object: "model",
        max_input_tokens: 200_000,
        max_tokens: 4096,
      },
    ]);

    const provider = await buildLivePioneerProvider({ apiKey: "sk-pioneer" });
    const model = provider.models[0];

    expect(model?.contextWindow).toBe(200_000);
    expect(model?.maxTokens).toBe(4096);
  });

  it("retries live discovery with fallback key when primary key fails", async () => {
    mocks.getCachedLiveProviderModelRows
      .mockRejectedValueOnce(new Error("auth error"))
      .mockResolvedValueOnce([{ id: "sakana/fugu-ultra", object: "model" }]);

    const provider = await buildLivePioneerProvider({
      apiKey: "sk-profile",
      discoveryApiKey: "expired-key",
      fallbackDiscoveryApiKey: "valid-env-key",
    });

    expect(mocks.getCachedLiveProviderModelRows).toHaveBeenCalledTimes(2);
    expect(mocks.getCachedLiveProviderModelRows).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ discoveryApiKey: "expired-key" }),
    );
    expect(mocks.getCachedLiveProviderModelRows).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ discoveryApiKey: "valid-env-key" }),
    );
    expect(provider.models.map((m) => m.id)).toEqual(["sakana/fugu-ultra"]);
  });

  it("passes env fallback key from catalog context when profile key differs", async () => {
    mocks.getCachedLiveProviderModelRows
      .mockRejectedValueOnce(new Error("auth error"))
      .mockResolvedValueOnce([{ id: "sakana/fugu-ultra", object: "model" }]);

    const result = await buildPioneerCatalogResult(
      buildCatalogContext({
        apiKey: "profile-key",
        discoveryApiKey: "expired-discovery-key",
        envDiscoveryApiKey: "valid-env-key",
      }),
    );

    expect(mocks.getCachedLiveProviderModelRows).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      provider: { models: [{ id: "sakana/fugu-ultra" }] },
    });
  });

  it("skips live discovery for configured custom base URLs", async () => {
    const result = await buildPioneerCatalogResult(
      buildCatalogContext({
        apiKey: "sk-pioneer",
        baseUrl: "https://proxy.example.test/v1",
      }),
    );

    expect(mocks.getCachedLiveProviderModelRows).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      provider: {
        apiKey: "sk-pioneer",
        baseUrl: "https://proxy.example.test/v1",
      },
    });
  });
});
