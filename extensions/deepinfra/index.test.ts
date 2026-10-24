import type { Model } from "openclaw/plugin-sdk/llm";
import {
  createCapturedPluginRegistration,
  registerSingleProviderPlugin,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type { ProviderCatalogContext } from "openclaw/plugin-sdk/provider-catalog-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureProviderRequestPayload } from "../test-support/provider-request-payload.test-support.js";
import deepinfraPlugin from "./index.js";

const DEEPINFRA_MODELS_URL =
  "https://api.deepinfra.com/v1/openai/models?sort_by=openclaw&filter=with_meta";

function buildDeepInfraCatalogContext(): ProviderCatalogContext {
  return {
    config: {},
    env: {},
    agentDir: "/tmp/openclaw-agent",
    resolveProviderApiKey: () => ({ apiKey: "profile-key" }),
    resolveProviderAuth: () => ({
      apiKey: "profile-key",
      mode: "api_key",
      source: "profile",
    }),
  };
}

function mockDiscoveryFetch(id = "profile/live-model") {
  return vi.fn(async (url: string) => {
    if (url === DEEPINFRA_MODELS_URL) {
      return Response.json({ data: [{ id, metadata: { tags: ["chat"] } }] });
    }
    expect(url).toBe("https://api.deepinfra.com/models/list");
    return Response.json([
      {
        model_name: id,
        pricing: {
          type: "tokens",
          cents_per_input_token: 0.0004,
          cents_per_output_token: 0.0008,
        },
      },
    ]);
  });
}

afterEach(() => {
  clearLiveCatalogCacheForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("deepinfra capability registration", () => {
  it.each([
    { baseUrl: "https://api.deepinfra.com/v1/openai", expected: "synthetic-session" },
    { baseUrl: "https://api.deepinfra.com/v1/openai/", expected: "synthetic-session" },
    { baseUrl: "https://proxy.example/v1", expected: undefined },
    { baseUrl: "https://api.deepinfra.com/custom/v1", expected: undefined },
    { baseUrl: "https://api.deepinfra.com/v1/openai", optOut: true, expected: undefined },
    { baseUrl: "https://api.deepinfra.com/v1/openai", disabled: true, expected: undefined },
  ])(
    "sends cache affinity only for native enabled requests: $baseUrl, $optOut, $disabled",
    async (route) => {
      const provider = await registerSingleProviderPlugin(deepinfraPlugin);
      const model: Model = {
        id: "synthetic-model",
        name: "Synthetic model",
        provider: "deepinfra",
        api: "openai-completions",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 128,
        baseUrl: route.baseUrl,
        ...(route.optOut ? { compat: { supportsPromptCacheKey: false } } : {}),
      };
      const normalized =
        provider.normalizeResolvedModel?.({ provider: model.provider, modelId: model.id, model }) ??
        model;
      const { result, payload } = await captureProviderRequestPayload(normalized, {
        cacheRetention: route.disabled ? "none" : "long",
      });
      expect(result.errorMessage).toBe("captured before request");
      expect(payload).toMatchObject({ prompt_cache_key: route.expected });
      expect(payload).not.toHaveProperty("prompt_cache_retention");
      expect(payload).not.toHaveProperty("prompt_cache_options");
    },
  );

  it.each([
    ...["metadata", "pricing"].flatMap((scenario) =>
      [401, 503].map((status) => ({ scenario, status })),
    ),
    { scenario: "empty", status: 503 },
  ])(
    "reports public $scenario HTTP $status without rejecting inference credentials",
    async ({ scenario, status }) => {
      const healthyFetch = mockDiscoveryFetch();
      const mockFetch = vi.fn(async (url: string) => {
        const metadata = url === DEEPINFRA_MODELS_URL;
        if (scenario === "empty" && metadata) {
          return Response.json({ data: [] });
        }
        if (
          (scenario === "metadata" && metadata) ||
          (scenario === "pricing" && !metadata) ||
          (scenario === "empty" && !metadata && status !== 200)
        ) {
          return new Response("unavailable", { status });
        }
        return healthyFetch(url);
      });
      const provider = await registerSingleProviderPlugin(deepinfraPlugin);
      vi.stubGlobal("fetch", mockFetch);
      const result = await provider.catalog?.run(buildDeepInfraCatalogContext());
      const rejected = status === 401 || status === 403;
      expect(result).toEqual(
        scenario === "empty"
          ? {
              provider: {
                baseUrl: "https://api.deepinfra.com/v1/openai",
                api: "openai-completions",
                apiKey: "profile-key",
                models: [],
              },
              outcomes: [{ provider: "deepinfra", status: "ready" }],
            }
          : {
              providers: {},
              outcomes: [
                {
                  provider: "deepinfra",
                  status: rejected ? "auth-rejected" : "unavailable",
                  ...(rejected ? { rejectionScope: "catalog" } : {}),
                },
              ],
            },
      );
    },
  );

  it("registers all DeepInfra-backed OpenClaw provider surfaces", () => {
    const captured = createCapturedPluginRegistration();
    deepinfraPlugin.register(captured.api);

    for (const providers of [
      captured.providers,
      captured.imageGenerationProviders,
      captured.mediaUnderstandingProviders,
      captured.embeddingProviders,
      captured.speechProviders,
      captured.videoGenerationProviders,
    ]) {
      expect(providers.map((provider) => provider.id)).toEqual(["deepinfra"]);
    }
  });

  it("uses profile-resolved API keys for live text catalog discovery", async () => {
    clearLiveCatalogCacheForTests();
    const mockFetch = mockDiscoveryFetch();
    const provider = await registerSingleProviderPlugin(deepinfraPlugin);

    vi.stubGlobal("fetch", mockFetch);
    const result = await provider.catalog?.run(buildDeepInfraCatalogContext());
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls.map(([url]) => url)).toEqual(
      expect.arrayContaining([DEEPINFRA_MODELS_URL, "https://api.deepinfra.com/models/list"]),
    );
    expect(result).toMatchObject({
      provider: {
        apiKey: "profile-key",
        models: [
          {
            id: "profile/live-model",
            cost: { input: 4, output: 8, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
      outcomes: [{ provider: "deepinfra", status: "ready" }],
    });
    if (!result || !("provider" in result)) {
      throw new Error("expected single-provider catalog");
    }
    expect(result.provider.models).toHaveLength(1);
  });
});

describe("deepinfra isCacheTtlEligible", () => {
  it("returns true regardless of modelId case", async () => {
    const provider = await registerSingleProviderPlugin(deepinfraPlugin);
    for (const modelId of ["Anthropic/Claude-4-Sonnet", "ANTHROPIC/claude-4-sonnet"]) {
      expect(provider.isCacheTtlEligible?.({ provider: "deepinfra", modelId })).toBe(true);
    }
  });

  it("returns false for non-anthropic models", async () => {
    const provider = await registerSingleProviderPlugin(deepinfraPlugin);
    for (const modelId of ["meta-llama/Llama-4-Scout-17B-16E-Instruct", "zai-org/GLM-5.1"]) {
      expect(provider.isCacheTtlEligible?.({ provider: "deepinfra", modelId })).toBe(false);
    }
  });
});
