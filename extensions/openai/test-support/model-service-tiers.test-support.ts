import type { LiveModelCatalogFetchGuard } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type { ProviderCatalogOutcome } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { expect, it, vi } from "vitest";
import { OPENAI_CODEX_RESPONSES_BASE_URL } from "../base-url.js";

type CatalogResult = {
  provider: ModelProviderConfig;
  outcomes: readonly ProviderCatalogOutcome[];
};

/** Register in the provider suite so its auth mocks and cache-reset hooks remain authoritative. */
export function registerOpenAIServiceTierCatalogTests(params: {
  modelsUrl: string;
  runCatalogWithFetchGuard: (params: {
    fetchGuard: LiveModelCatalogFetchGuard;
    auth: {
      mode: "api_key" | "oauth" | "token";
      apiKey: string;
      discoveryApiKey?: string;
      profileId?: string;
      authFlow?: string;
      source: string;
    };
    accountId?: string;
    baseUrl?: string;
  }) => Promise<CatalogResult>;
}): void {
  const { modelsUrl: OPENAI_CODEX_MODELS_URL, runCatalogWithFetchGuard } = params;

  it("keeps service tiers with the authenticated model/account, never fallback metadata", async () => {
    const fetchGuard: LiveModelCatalogFetchGuard = vi.fn(async () => ({
      response: Response.json({
        models: [
          {
            slug: "synthetic-tier-model",
            service_tiers: [{ id: " ultrafast " }, { id: "priority" }],
          },
          { slug: "synthetic-empty", service_tiers: [] },
          { slug: "synthetic-unknown" },
          { slug: "synthetic-invalid", service_tiers: [{ id: 12 }] },
        ],
      }),
      finalUrl: OPENAI_CODEX_MODELS_URL,
      release: async () => {},
    }));
    const result = await runCatalogWithFetchGuard({
      auth: {
        mode: "oauth",
        apiKey: "synthetic-tier-token",
        profileId: "openai:tiers",
        source: "profile",
      },
      accountId: "synthetic-tier-account",
      fetchGuard,
    });
    expect(result.outcomes).toEqual([
      {
        provider: "openai",
        profileId: "openai:tiers",
        status: "ready",
        modelServiceTiers: [
          {
            modelId: "synthetic-tier-model",
            runtimeId: "codex",
            api: "openai-chatgpt-responses",
            baseUrl: OPENAI_CODEX_RESPONSES_BASE_URL,
            serviceTiers: ["ultrafast", "priority"],
          },
          {
            modelId: "synthetic-empty",
            runtimeId: "codex",
            api: "openai-chatgpt-responses",
            baseUrl: OPENAI_CODEX_RESPONSES_BASE_URL,
            serviceTiers: [],
          },
        ],
      },
    ]);
    expect(result.provider.models.every((model) => !("serviceTiers" in model))).toBe(true);
    const other = await runCatalogWithFetchGuard({
      auth: {
        mode: "oauth",
        apiKey: "synthetic-other-token",
        profileId: "openai:other",
        source: "profile",
      },
      accountId: "synthetic-other-account",
      fetchGuard: async () => ({
        response: new Response("unavailable", { status: 503 }),
        finalUrl: OPENAI_CODEX_MODELS_URL,
        release: async () => {},
      }),
    });
    expect(other.outcomes).toEqual([
      { provider: "openai", profileId: "openai:other", status: "unavailable" },
    ]);
  });
}
