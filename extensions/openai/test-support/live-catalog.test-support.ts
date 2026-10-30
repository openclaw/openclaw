import type { LiveModelCatalogFetchGuard } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { vi } from "vitest";
import { buildOpenAIProvider } from "../openai-provider.js";

const mocks = vi.hoisted(() => ({
  resolveApiKeyForProvider: vi.fn(),
  resolveProviderAuthProfileMetadata: vi.fn(),
}));

export { mocks };

type OpenAITestCatalogResult = {
  provider: ModelProviderConfig;
  outcomes: readonly {
    provider: string;
    profileId?: string;
    rejectionScope?: "catalog";
    status: "ready" | "auth-rejected" | "unavailable";
  }[];
};

export async function runCatalogWithFetchGuard(params: {
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
}): Promise<OpenAITestCatalogResult> {
  if (params.auth.mode === "oauth") {
    mocks.resolveApiKeyForProvider.mockResolvedValue({
      ...params.auth,
      source: params.auth.source,
    });
    mocks.resolveProviderAuthProfileMetadata.mockReturnValue({
      profileId: params.auth.profileId,
      accountId: params.accountId,
    });
  }
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const guarded = await params.fetchGuard({
      url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      init,
    });
    await guarded.release();
    return guarded.response;
  });
  try {
    const result = await buildOpenAIProvider().catalog?.run({
      resolveProviderAuth: () => params.auth,
      resolveProviderApiKey: () => ({
        apiKey: params.auth.apiKey,
        discoveryApiKey: params.auth.discoveryApiKey,
      }),
      config: params.baseUrl
        ? { models: { providers: { openai: { baseUrl: params.baseUrl, models: [] } } } }
        : { auth: { profiles: {} } },
      agentDir: "/tmp/openai-agent",
      workspaceDir: "/tmp/openai-workspace",
    } as never);
    if (!result || "provider" in result || !result.providers.openai) {
      throw new Error("expected OpenAI live provider catalog");
    }
    return { provider: result.providers.openai, outcomes: result.outcomes ?? [] };
  } finally {
    fetchSpy.mockRestore();
  }
}

export async function buildOpenAICodexLiveProviderConfig(params: {
  discoveryApiKey: string;
  accountId?: string;
  fetchGuard: LiveModelCatalogFetchGuard;
}): Promise<ModelProviderConfig> {
  return (
    await runCatalogWithFetchGuard({
      fetchGuard: params.fetchGuard,
      auth: {
        mode: "oauth",
        apiKey: params.discoveryApiKey,
        profileId: "openai:chatgpt",
        source: "profile",
      },
      accountId: params.accountId,
    })
  ).provider;
}

// mock-isolation: Catalog tests supply synthetic credentials and account metadata.
vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: mocks.resolveApiKeyForProvider,
  resolveProviderAuthProfileMetadataAsync: mocks.resolveProviderAuthProfileMetadata,
}));
