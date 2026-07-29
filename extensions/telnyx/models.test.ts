// Telnyx tests cover model catalog and live projection behavior.
import {
  buildOpenAICompatibleLiveModelProviderConfig,
  clearLiveCatalogCacheForTests,
  type LiveModelCatalogFetchGuard,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildStaticTelnyxModels,
  projectTelnyxLiveModels,
  resolveTelnyxDynamicModel,
  TELNYX_DEFAULT_MODEL_REF,
  TELNYX_MODEL_CATALOG,
} from "./models.js";

const TEST_VALUE = "fixture";

async function buildLiveTelnyxModels(params: {
  discoveryApiKey: string;
  fetchGuard: LiveModelCatalogFetchGuard;
}) {
  const provider = await buildOpenAICompatibleLiveModelProviderConfig({
    providerId: "telnyx",
    providerConfig: {
      baseUrl: "https://api.telnyx.com/v2/ai/openai",
      api: "openai-completions",
      models: buildStaticTelnyxModels(),
    },
    discoveryApiKey: params.discoveryApiKey,
    fetchGuard: params.fetchGuard,
    modelDiscovery: {
      timeoutMs: 10_000,
      ttlMs: 5 * 60 * 1000,
      projectRows: projectTelnyxLiveModels,
    },
  });
  return provider.models;
}

describe("Telnyx model catalog", () => {
  beforeEach(() => {
    clearLiveCatalogCacheForTests();
  });

  it("ships the curated Telnyx catalog with Kimi K3 as the default", () => {
    const models = buildStaticTelnyxModels();

    expect(TELNYX_DEFAULT_MODEL_REF).toBe("telnyx/moonshotai/Kimi-K3");
    expect(models).toHaveLength(14);
    expect(models.map((model) => model.id)).toEqual(TELNYX_MODEL_CATALOG.map((model) => model.id));
    expect(models.find((model) => model.id === "moonshotai/Kimi-K2.6")).toMatchObject({
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 262_144,
      maxTokens: 8_192,
      cost: { input: 0.665, output: 4, cacheRead: 0.08, cacheWrite: 0 },
      compat: {
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsUsageInStreaming: true,
        supportsTools: true,
        maxTokensField: "max_tokens",
      },
    });
    expect(models.find((model) => model.id === "zai-org/GLM-5.2")).toMatchObject({
      reasoning: true,
      input: ["text"],
      contextWindow: 1_000_000,
      maxTokens: 131_072,
      cost: { input: 1, output: 4, cacheRead: 0.2, cacheWrite: 0 },
    });
  });

  it("projects live rows with per-1M pricing, vision, and chat-task filtering", () => {
    const models = projectTelnyxLiveModels([
      {
        id: "moonshotai/Kimi-K2.6",
        object: "model",
        task: "text-generation",
        context_length: 262_144,
        max_completion_tokens: 32_768,
        is_vision_supported: true,
        pricing: {
          input: "0.700000",
          output: "4.100000",
          cached_prompt: "0.090000",
          currency: "USD",
          unit: "1M_tokens",
        },
      },
      {
        id: "openai/gpt-4o-mini",
        object: "model",
        task: "text generation",
        context_length: 400_000,
        pricing: { input: "1.250000", output: "10.000000", cached_prompt: "0.125000" },
      },
      { id: "openai/gpt-4o-mini", object: "model", task: "text-generation" },
      { id: "openai-embeddings/text-embedding-3", object: "model", task: "embeddings" },
      { id: "missing-task/model", object: "model" },
      { id: "ignored", object: "not-a-model", task: "text-generation" },
    ]);

    expect(models).toHaveLength(2);
    expect(models[0]).toMatchObject({
      id: "moonshotai/Kimi-K2.6",
      name: "Kimi K2.6",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 262_144,
      maxTokens: 32_768,
      cost: { input: 0.7, output: 4.1, cacheRead: 0.09, cacheWrite: 0 },
      compat: { supportsUsageInStreaming: true, maxTokensField: "max_tokens" },
    });
    expect(models[1]).toMatchObject({
      id: "openai/gpt-4o-mini",
      reasoning: false,
      input: ["text"],
      contextWindow: 400_000,
      maxTokens: 8_192,
      cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
    });
  });

  it("falls back to bundled costs when the pricing unit is not per 1M tokens", () => {
    const models = projectTelnyxLiveModels([
      {
        id: "moonshotai/Kimi-K2.6",
        object: "model",
        task: "text-generation",
        pricing: { input: "0.0000007", output: "0.0000041", unit: "1_token" },
      },
    ]);

    expect(models[0]).toMatchObject({
      cost: { input: 0.665, output: 4, cacheRead: 0.08, cacheWrite: 0 },
    });
  });

  it("authenticates live discovery and does not cache unusable rows", async () => {
    const release = vi.fn(async () => undefined);
    const fetchGuard: LiveModelCatalogFetchGuard = vi
      .fn()
      .mockImplementationOnce(async () => ({
        response: Response.json({ data: [{ object: "not-a-model" }] }),
        finalUrl: "https://api.telnyx.com/v2/ai/openai/models",
        release,
      }))
      .mockImplementationOnce(async () => ({
        response: Response.json({
          data: [
            {
              id: "moonshotai/Kimi-K2.6",
              object: "model",
              task: "text-generation",
              context_length: 262_144,
              max_completion_tokens: 32_768,
              is_vision_supported: true,
            },
          ],
        }),
        finalUrl: "https://api.telnyx.com/v2/ai/openai/models",
        release,
      }));

    await expect(
      buildLiveTelnyxModels({ discoveryApiKey: TEST_VALUE, fetchGuard }),
    ).resolves.toHaveLength(14);
    await expect(
      buildLiveTelnyxModels({ discoveryApiKey: TEST_VALUE, fetchGuard }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: "moonshotai/Kimi-K2.6",
        contextWindow: 262_144,
        maxTokens: 32_768,
      }),
    ]);

    expect(fetchGuard).toHaveBeenCalledTimes(2);
    const headers = vi.mocked(fetchGuard).mock.calls[0]?.[0].init?.headers;
    expect(headers).toBeInstanceOf(Headers);
    if (!(headers instanceof Headers)) {
      throw new Error("expected fetch headers");
    }
    expect(headers.get("Authorization")).toBe(`Bearer ${TEST_VALUE}`);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("resolves future model ids without shadowing bundled rows", () => {
    expect(resolveTelnyxDynamicModel("moonshotai/Kimi-K2.6")).toBeUndefined();
    expect(resolveTelnyxDynamicModel("future/model")).toMatchObject({
      id: "future/model",
      provider: "telnyx",
      api: "openai-completions",
      baseUrl: "https://api.telnyx.com/v2/ai/openai",
      compat: { supportsTools: true, maxTokensField: "max_tokens" },
    });
  });
});
