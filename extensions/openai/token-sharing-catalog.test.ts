import {
  clearLiveCatalogCacheForTests,
  type LiveModelCatalogFetchGuard,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type {
  ProviderCatalogContext,
  ProviderCatalogOutcome,
} from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OPENAI_API_BASE_URL } from "./base-url.js";
import { buildOpenAIProvider } from "./openai-provider.js";

const mocks = vi.hoisted(() => ({
  resolveApiKeyForProvider: vi.fn(),
  resolveProviderAuthProfileMetadata: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => mocks);

type OpenAITestCatalogResult = {
  provider: ModelProviderConfig;
  outcomes: readonly ProviderCatalogOutcome[];
};

function sharingAuth(
  apiKey = "sharing-fixture",
  profileId = "openai:sharing",
): ReturnType<ProviderCatalogContext["resolveProviderAuth"]> {
  return { mode: "oauth", authFlow: "chatgpt-token-sharing", apiKey, profileId, source: "profile" };
}

async function runCatalogWithFetchGuard(params: {
  fetchGuard: LiveModelCatalogFetchGuard;
  auth?: ReturnType<ProviderCatalogContext["resolveProviderAuth"]>;
  baseUrl?: string;
}): Promise<OpenAITestCatalogResult> {
  const auth = params.auth ?? sharingAuth();
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
      resolveProviderAuth: () => auth,
      resolveProviderApiKey: () => ({
        apiKey: auth.apiKey,
        discoveryApiKey: auth.discoveryApiKey,
      }),
      config: params.baseUrl
        ? { models: { providers: { openai: { baseUrl: params.baseUrl, models: [] } } } }
        : { auth: { profiles: {} } },
      agentDir: "/tmp/openai-agent",
      workspaceDir: "/tmp/openai-workspace",
      env: {},
    });
    if (!result || "provider" in result || !result.providers.openai) {
      throw new Error("expected OpenAI live provider catalog");
    }
    return { provider: result.providers.openai, outcomes: result.outcomes ?? [] };
  } finally {
    fetchSpy.mockRestore();
  }
}

describe("SIWC model discovery", () => {
  beforeEach(() => {
    clearLiveCatalogCacheForTests();
    vi.clearAllMocks();
  });
  afterEach(() => vi.restoreAllMocks());
  it("discovers SIWC models with the selected profile and preserves visible server order", async () => {
    const fetchGuard = vi
      .fn<LiveModelCatalogFetchGuard>()
      .mockImplementation(async ({ init, url }) => {
        const selected =
          new Headers(init?.headers).get("Authorization") === "Bearer sharing-selected";
        return {
          finalUrl: url,
          response: Response.json({
            models: selected
              ? [
                  { slug: "fixture-z", display_name: "First choice", visibility: "list" },
                  { slug: "fixture-hidden", display_name: "Hidden", visibility: "hide" },
                  { slug: "fixture-unlisted", display_name: "Unlisted" },
                  { slug: "gpt-5.4", display_name: "Account model name", visibility: "list" },
                  { slug: "fixture-a", display_name: "Last choice", visibility: "list" },
                ]
              : [{ slug: "fixture-other", display_name: "Other account", visibility: "list" }],
          }),
          release: async () => {},
        };
      });
    const selected = await runCatalogWithFetchGuard({
      fetchGuard,
      auth: {
        ...sharingAuth("oauth:openai", "openai:sharing-selected"),
        discoveryApiKey: "sharing-selected",
      },
      baseUrl: "https://proxy.example/v1",
    });
    expect(fetchGuard).toHaveBeenCalledTimes(1);
    expect(fetchGuard.mock.calls[0]?.[0].url).toBe("https://api.openai.com/v1/models");
    expect(new Headers(fetchGuard.mock.calls[0]?.[0].init?.headers).get("Authorization")).toBe(
      "Bearer sharing-selected",
    );
    expect(mocks.resolveApiKeyForProvider).not.toHaveBeenCalled();
    expect(selected.provider.apiKey).toBeUndefined();
    expect(selected.provider.baseUrl).toBe(OPENAI_API_BASE_URL);
    expect(selected.provider.models.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: "fixture-z", name: "First choice" },
      { id: "gpt-5.4", name: "Account model name" },
      { id: "fixture-a", name: "Last choice" },
    ]);
    expect(selected.provider.models.every((model) => model.api === "openai-responses")).toBe(true);
    expect(selected.provider.models.find(({ id }) => id === "gpt-5.4")).toMatchObject({
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 1_050_000,
    });
    expect(selected.outcomes).toEqual([
      {
        provider: "openai",
        profileId: "openai:sharing-selected",
        status: "ready",
        modelOrder: ["fixture-z", "gpt-5.4", "fixture-a"],
      },
    ]);

    const other = await runCatalogWithFetchGuard({
      fetchGuard,
      auth: {
        ...sharingAuth("oauth:openai", "openai:sharing-other"),
        discoveryApiKey: "sharing-other",
      },
    });
    expect(fetchGuard).toHaveBeenCalledTimes(2);
    expect(other.provider.models.map(({ id }) => id)).toEqual(["fixture-other"]);
    expect(other.outcomes).toEqual([
      {
        provider: "openai",
        profileId: "openai:sharing-other",
        status: "ready",
        modelOrder: ["fixture-other"],
      },
    ]);
  });

  it.each([
    [
      "hidden",
      { models: [{ slug: "fixture-hidden", visibility: "hide" }] },
      200,
      "ready",
      false,
      undefined,
    ],
    ["unauthorized", {}, 401, "auth-rejected", false, undefined],
    ["forbidden", {}, 403, "auth-rejected", false, "catalog"],
    ["unavailable", {}, 503, "unavailable", true, undefined],
    ["wrong shape", { data: [{ id: "fixture-platform" }] }, 200, "unavailable", true, undefined],
  ] as const)(
    "handles a %s SIWC catalog without inventing account access",
    async (_label, body, status, outcome, fallback, rejectionScope) => {
      const fetchGuard = vi.fn<LiveModelCatalogFetchGuard>().mockResolvedValue({
        finalUrl: `${OPENAI_API_BASE_URL}/models`,
        response: Response.json(body, { status }),
        release: async () => {},
      });
      const result = await runCatalogWithFetchGuard({ fetchGuard });
      expect(fetchGuard).toHaveBeenCalledTimes(1);
      expect(result.provider.models.length > 0).toBe(fallback);
      expect(result.outcomes).toEqual([
        {
          provider: "openai",
          profileId: "openai:sharing",
          status: outcome,
          ...(rejectionScope ? { rejectionScope } : {}),
          ...(outcome === "ready" ? { modelOrder: [] } : {}),
        },
      ]);
    },
  );

  it.each([
    ["chatgpt-identity", "sharing-fixture", false, "auth-rejected"],
    ["chatgpt-token-sharing", "oauth:openai", false, "unavailable"],
    ["chatgpt-token-sharing", "sharing-fixture", true, "unavailable"],
  ] as const)(
    "does not discover models without usable %s authorization",
    async (authFlow, apiKey, preparationFailed, status) => {
      const fetchGuard = vi.fn<LiveModelCatalogFetchGuard>();
      const { provider, outcomes } = await runCatalogWithFetchGuard({
        fetchGuard,
        auth: { ...sharingAuth(apiKey), authFlow, preparationFailed },
      });
      expect(fetchGuard).not.toHaveBeenCalled();
      expect(mocks.resolveApiKeyForProvider).not.toHaveBeenCalled();
      expect(provider.baseUrl).toBe(OPENAI_API_BASE_URL);
      if (authFlow === "chatgpt-identity") {
        expect(provider.models).toEqual([]);
      }
      expect(outcomes).toEqual([{ provider: "openai", profileId: "openai:sharing", status }]);
    },
  );
});
