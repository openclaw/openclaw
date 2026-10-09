import { clampThinkingLevel } from "openclaw/plugin-sdk/llm";
import {
  clearLiveCatalogCacheForTests,
  type LiveModelCatalogFetchGuard,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOpenAIProvider } from "./openai-provider.js";

const mocks = vi.hoisted(() => ({
  resolveApiKeyForProvider: vi.fn(),
  resolveProviderAuthProfileMetadata: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => mocks);
// mock-isolation: keep npm Codex version lookups off the network and out of shared cache state.
vi.mock("./codex-client-version.runtime.js", () => ({
  resolveOpenAICodexModelsEndpoint: async () =>
    "https://chatgpt.com/backend-api/codex/models?client_version=0.170.0",
}));
const modelsUrl = "https://chatgpt.com/backend-api/codex/models?client_version=0.170.0";

async function discoverCodexModels(params: {
  discoveryApiKey: string;
  accountId?: string;
  fetchGuard: LiveModelCatalogFetchGuard;
}) {
  mocks.resolveApiKeyForProvider.mockResolvedValue({
    mode: "oauth",
    apiKey: params.discoveryApiKey,
    source: "profile",
    profileId: "openai:chatgpt",
  });
  mocks.resolveProviderAuthProfileMetadata.mockReturnValue({
    profileId: "openai:chatgpt",
    accountId: params.accountId,
  });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const guarded = await params.fetchGuard({
      url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      init,
    });
    await guarded.release();
    return guarded.response;
  });
  const result = await buildOpenAIProvider().catalog?.run({
    resolveProviderAuth: () => ({
      mode: "oauth",
      apiKey: params.discoveryApiKey,
      profileId: "openai:chatgpt",
      source: "profile",
    }),
    resolveProviderApiKey: () => ({
      apiKey: params.discoveryApiKey,
      discoveryApiKey: params.discoveryApiKey,
    }),
    config: { auth: { profiles: {} } },
    agentDir: "/tmp/openai-agent",
    workspaceDir: "/tmp/openai-workspace",
  } as never);
  if (!result || "provider" in result || !result.providers.openai) {
    throw new Error("expected OpenAI catalog");
  }
  return result.providers.openai;
}

describe("OpenAI discovered subscription models", () => {
  beforeEach(() => clearLiveCatalogCacheForTests());
  afterEach(() => vi.restoreAllMocks());
  it.each(["gpt-5.4", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-6.1-sol"])(
    "maps discovered %s into a ChatGPT response model",
    async (modelId) => {
      const release = vi.fn(async () => undefined);
      const fetchGuard: LiveModelCatalogFetchGuard = vi.fn(async () => ({
        response: Response.json({
          models: [
            {
              slug: modelId,
              display_name: modelId,
              visibility: "list",
              supported_reasoning_levels: [
                { effort: "medium", description: "medium" },
                { effort: "high", description: "high" },
              ],
              context_window: 272_000,
              max_context_window: 1_050_000,
              max_output_tokens: 128_000,
            },
            {
              slug: "hidden-review-model",
              display_name: "Hidden Review Model",
              visibility: "hide",
            },
            {
              slug: "internal-fallback-model",
              display_name: "Internal Fallback Model",
              visibility: "none",
            },
          ],
        }),
        finalUrl: "https://chatgpt.com/backend-api/codex/models?client_version=1.0.0",
        release,
      }));

      const provider = await discoverCodexModels({
        discoveryApiKey: "oauth-token",
        accountId: "acct-openai-workspace",
        fetchGuard,
      });

      expect(provider?.api).toBe("openai-chatgpt-responses");
      expect(provider?.auth).toBe("oauth");
      expect(provider?.models.map((model) => model.id)).toEqual([modelId]);
      expect(provider?.models[0]).toMatchObject({
        baseUrl: "https://chatgpt.com/backend-api/codex",
        input: ["text", "image"],
        reasoning: true,
        contextWindow: 1_050_000,
        contextTokens: 272_000,
        maxTokens: 128_000,
      });
      if (modelId === "gpt-6.1-sol") {
        const discovered = provider.models[0];
        if (!discovered) {
          throw new Error("expected discovered GPT-6.1 Sol");
        }
        expect(discovered.thinkingLevelMap?.off).toBeNull();
        expect(
          clampThinkingLevel(
            {
              ...discovered,
              provider: "openai",
              api: "openai-chatgpt-responses",
              baseUrl: provider.baseUrl,
              input: discovered.input.filter(
                (modality) => modality === "text" || modality === "image",
              ),
              contextWindow: discovered.contextWindow ?? 1_050_000,
            },
            "off",
          ),
        ).not.toBe("off");
        expect(discovered.compat?.supportedReasoningEfforts).toEqual(["medium", "high"]);
      }
      const fetchParams = vi.mocked(fetchGuard).mock.calls[0]?.[0];
      expect(fetchParams?.url).toBe(modelsUrl);
      const init = fetchParams?.init;
      const headers = init?.headers;
      expect(headers).toBeInstanceOf(Headers);
      if (!(headers instanceof Headers)) {
        throw new Error("expected fetch headers");
      }
      expect(headers.get("Authorization")).toBe("Bearer oauth-token");
      expect(headers.get("ChatGPT-Account-ID")).toBe("acct-openai-workspace");
      expect(release).toHaveBeenCalledOnce();
    },
  );
});
