import type { LiveModelCatalogFetchGuard } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type { ProviderCatalogOutcome } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { expect, it, vi, type Mock } from "vitest";
import { OPENAI_CODEX_RESPONSES_BASE_URL } from "../base-url.js";
import { buildOpenAIProvider } from "../openai-provider.js";

type CatalogResult = {
  provider: ModelProviderConfig;
  outcomes: readonly ProviderCatalogOutcome[];
};

/** Register in the provider suite so its auth mocks and cache-reset hooks remain authoritative. */
export function registerOpenAIModelCatalogTests(params: {
  modelsUrl: string;
  resolveRuntimeVersion: Mock;
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
  buildOpenAICodexLiveProviderConfig: (params: {
    discoveryApiKey: string;
    accountId?: string;
    fetchGuard: LiveModelCatalogFetchGuard;
  }) => Promise<ModelProviderConfig>;
}): void {
  const {
    modelsUrl: OPENAI_CODEX_MODELS_URL,
    resolveRuntimeVersion,
    runCatalogWithFetchGuard,
    buildOpenAICodexLiveProviderConfig,
  } = params;

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

  it("keeps static OpenAI OAuth rows when Codex catalog discovery fails", async () => {
    const release = vi.fn(async () => undefined);
    const fetchGuard: LiveModelCatalogFetchGuard = vi.fn(async () => ({
      response: new Response("temporarily unavailable", { status: 503 }),
      finalUrl: "https://chatgpt.com/backend-api/codex/models?client_version=1.0.0",
      release,
    }));

    const provider = await buildOpenAICodexLiveProviderConfig({
      discoveryApiKey: "oauth-token",
      accountId: "acct-openai-workspace",
      fetchGuard,
    });

    expect(provider.api).toBe("openai-chatgpt-responses");
    expect(provider.auth).toBe("oauth");
    expect(provider.baseUrl).toBe("https://chatgpt.com/backend-api/codex");
    expect(provider.models.length).toBeGreaterThan(0);
    expect(provider.models.map((model) => model.id)).not.toContain("gpt-5.6");
    expect(provider.models.find((model) => model.id === "gpt-5.6-sol")).toMatchObject({
      contextWindow: 372_000,
      contextTokens: 272_000,
      thinkingLevelMap: { off: null },
      compat: {
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      },
    });
    expect(provider.models.map((model) => model.id)).not.toContain("gpt-5.6-terra");
    expect(provider.models.map((model) => model.id)).not.toContain("gpt-5.6-luna");
    expect(provider.models.filter((model) => model.id.startsWith("gpt-6-"))).toEqual([]);
    expect(provider.models.map((model) => model.id)).toContain("gpt-5.5");
    expect(release).toHaveBeenCalledOnce();
  });
  it("uses the selected runtime version and separates discovery caches after runtime selection changes", async () => {
    const fetchGuard = vi.fn<LiveModelCatalogFetchGuard>(async ({ url }) => ({
      response: Response.json({
        models: [{ slug: url.includes("99.2.0") ? "synthetic-new" : "synthetic-old" }],
      }),
      finalUrl: url,
      release: async () => {},
    }));
    const auth = { mode: "token" as const, apiKey: "synthetic-discovery-token", source: "profile" };
    const before = await runCatalogWithFetchGuard({ fetchGuard, auth });
    const cached = await runCatalogWithFetchGuard({ fetchGuard, auth });
    expect(cached.provider.models).toEqual(before.provider.models);
    expect(fetchGuard).toHaveBeenCalledOnce();
    resolveRuntimeVersion.mockResolvedValue("99.2.0");
    const after = await runCatalogWithFetchGuard({ fetchGuard, auth });
    expect(after.provider.models.map(({ id }) => id)).toEqual(["synthetic-new"]);
    expect(fetchGuard.mock.calls.map(([request]) => request.url)).toEqual([
      OPENAI_CODEX_MODELS_URL,
      `${OPENAI_CODEX_RESPONSES_BASE_URL}/models?client_version=99.2.0`,
    ]);
    expect(resolveRuntimeVersion).toHaveBeenCalledWith("codex");
  });

  it("does not invent a discovery version when no selected native runtime is available", async () => {
    resolveRuntimeVersion.mockResolvedValue(undefined);
    const fetchGuard = vi.fn<LiveModelCatalogFetchGuard>();
    const result = await runCatalogWithFetchGuard({
      fetchGuard,
      auth: { mode: "token", apiKey: "synthetic-discovery-token", source: "profile" },
    });
    expect(fetchGuard).not.toHaveBeenCalled();
    expect(result.outcomes).toEqual([{ provider: "openai", status: "unavailable" }]);
  });
  it("keeps an explicit empty Codex reasoning catalog authoritative", async () => {
    const fetchGuard: LiveModelCatalogFetchGuard = vi.fn(async () => ({
      response: Response.json({
        models: [
          {
            slug: "gpt-5.6-sol",
            display_name: "GPT-5.6 Sol",
            visibility: "list",
            supported_reasoning_levels: [],
          },
        ],
      }),
      finalUrl: "https://chatgpt.com/backend-api/codex/models?client_version=1.0.0",
      release: async () => undefined,
    }));

    const provider = await buildOpenAICodexLiveProviderConfig({
      discoveryApiKey: "empty-reasoning-oauth-token",
      fetchGuard,
    });
    const sol = provider.models.find((model) => model.id === "gpt-5.6-sol");

    expect(sol?.compat?.supportedReasoningEfforts).toEqual([]);
    expect(sol?.thinkingLevelMap).toEqual({ off: null });
    expect(
      buildOpenAIProvider().resolveThinkingProfile?.({
        provider: "openai",
        modelId: "gpt-5.6-sol",
        agentRuntime: "codex",
        api: "openai-chatgpt-responses",
        compat: sol?.compat,
      } as never)?.levels,
    ).not.toContainEqual({ id: "ultra" });
  });
}
