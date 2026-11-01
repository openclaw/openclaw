import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type {
  ProviderCatalogContext,
  ProviderCatalogOutcome,
} from "openclaw/plugin-sdk/provider-catalog-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OPENAI_API_BASE_URL } from "./base-url.js";
import { buildOpenAIProvider } from "./openai-provider.js";

const mocks = vi.hoisted(() => ({
  resolveApiKeyForProvider: vi.fn(),
  resolveProviderAuthProfileMetadataAsync: vi.fn(),
}));
// mock-isolation: Token-sharing catalog fixtures do not read host credentials.
vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => mocks);

type CatalogAuth = ReturnType<ProviderCatalogContext["resolveProviderAuth"]>;
const fetchMock = vi.fn<typeof fetch>();
const discoveryAuth = (account: string) => ({
  apiKey: "oauth:openai",
  profileId: `openai:sharing-${account}`,
  discoveryApiKey: `sharing-${account}`,
});

async function runCatalog(overrides: Partial<CatalogAuth> = {}, baseUrl?: string) {
  const auth: CatalogAuth = {
    mode: "oauth",
    authFlow: "chatgpt-token-sharing",
    apiKey: "sharing-fixture",
    profileId: "openai:sharing",
    source: "profile",
    ...overrides,
  };
  const result = await buildOpenAIProvider().catalog?.run({
    resolveProviderAuth: () => auth,
    resolveProviderApiKey: () => ({
      apiKey: auth.apiKey,
      discoveryApiKey: auth.discoveryApiKey,
    }),
    config: baseUrl
      ? { models: { providers: { openai: { baseUrl, models: [] } } } }
      : { auth: { profiles: {} } },
    agentDir: "/tmp/openai-agent",
    workspaceDir: "/tmp/openai-workspace",
    env: {},
  });
  if (!result || "provider" in result || !result.providers.openai) {
    throw new Error("expected OpenAI live provider catalog");
  }
  return { provider: result.providers.openai, outcomes: result.outcomes ?? [] };
}

function expectOutcome(
  outcomes: readonly ProviderCatalogOutcome[],
  outcome: Partial<ProviderCatalogOutcome>,
) {
  expect(outcomes).toEqual([{ provider: "openai", profileId: "openai:sharing", ...outcome }]);
}

describe("SIWC model discovery", () => {
  beforeEach(() => {
    clearLiveCatalogCacheForTests();
    vi.clearAllMocks();
    fetchMock.mockReset();
    vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
  });
  afterEach(() => vi.restoreAllMocks());
  it("discovers SIWC models with the selected profile and preserves visible server order", async () => {
    fetchMock.mockImplementation(async (_url, init) => {
      const selected =
        new Headers(init?.headers).get("Authorization") === "Bearer sharing-selected";
      return Response.json({
        models: selected
          ? [
              { slug: "fixture-z", display_name: "First choice", visibility: "list" },
              { slug: "fixture-hidden", visibility: "hide" },
              { slug: "fixture-unlisted" },
              { slug: "gpt-5.4", display_name: "Account model name", visibility: "list" },
              { slug: "fixture-a", display_name: "Last choice", visibility: "list" },
            ]
          : [{ slug: "fixture-other", display_name: "Other account", visibility: "list" }],
      });
    });
    const selected = await runCatalog(discoveryAuth("selected"), "https://proxy.example/v1");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.openai.com/v1/models");
    expect(mocks.resolveApiKeyForProvider).not.toHaveBeenCalled();
    expect(selected.provider.apiKey).toBeUndefined();
    expect(selected.provider.baseUrl).toBe(OPENAI_API_BASE_URL);
    expect(selected.provider.models).toMatchObject([
      { id: "fixture-z", name: "First choice", api: "openai-responses" },
      {
        id: "gpt-5.4",
        name: "Account model name",
        api: "openai-responses",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 1_050_000,
      },
      { id: "fixture-a", name: "Last choice", api: "openai-responses" },
    ]);
    expectOutcome(selected.outcomes, {
      profileId: "openai:sharing-selected",
      status: "ready",
      modelOrder: ["fixture-z", "gpt-5.4", "fixture-a"],
    });

    const other = await runCatalog(discoveryAuth("other"));
    expect(other.provider.models.map(({ id }) => id)).toEqual(["fixture-other"]);
    expectOutcome(other.outcomes, {
      profileId: "openai:sharing-other",
      status: "ready",
      modelOrder: ["fixture-other"],
    });
  });

  const hidden = { models: [{ slug: "hidden", visibility: "hide" }] };
  it.each([
    ["hidden", hidden, 200, { status: "ready", modelOrder: [] }, false],
    ["unauthorized", {}, 401, { status: "auth-rejected" }, false],
    ["forbidden", {}, 403, { status: "auth-rejected", rejectionScope: "catalog" }, false],
    ["unavailable", {}, 503, { status: "unavailable" }, true],
    ["wrong shape", { data: [] }, 200, { status: "unavailable" }, true],
  ] as const)(
    "handles a %s SIWC catalog without inventing account access",
    async (_label, body, status, outcome, fallback) => {
      fetchMock.mockResolvedValue(Response.json(body, { status }));
      const result = await runCatalog();
      expect(result.provider.models.length > 0).toBe(fallback);
      expectOutcome(result.outcomes, outcome);
    },
  );

  it.each([
    ["chatgpt-identity", "sharing-fixture", false, "auth-rejected"],
    ["chatgpt-token-sharing", "oauth:openai", false, "unavailable"],
    ["chatgpt-token-sharing", "sharing-fixture", true, "unavailable"],
  ] as const)(
    "does not discover models without usable %s authorization",
    async (authFlow, apiKey, preparationFailed, status) => {
      const { provider, outcomes } = await runCatalog({ authFlow, apiKey, preparationFailed });
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mocks.resolveApiKeyForProvider).not.toHaveBeenCalled();
      expect(provider.baseUrl).toBe(OPENAI_API_BASE_URL);
      if (authFlow === "chatgpt-identity") {
        expect(provider.models).toEqual([]);
      }
      expectOutcome(outcomes, { status });
    },
  );
});
