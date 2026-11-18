import { clampThinkingLevel } from "openclaw/plugin-sdk/llm";
import {
  clearLiveCatalogCacheForTests,
  type LiveModelCatalogFetchGuard,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { runCatalogWithFetchGuard } from "./test-support/live-catalog.test-support.js";

const BUNDLED_CODEX_CLIENT_VERSION = "0.169.0";

// The npm registry read for the newest published Codex; the model list keeps the real guard.
const registry = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: (params: Parameters<typeof actual.fetchWithSsrFGuard>[0]) =>
      params.url.startsWith("https://registry.npmjs.org/")
        ? registry.fetch(params)
        : actual.fetchWithSsrFGuard(params),
  };
});
function publishCodex(response: Response) {
  registry.fetch.mockResolvedValue({ response, release: async () => undefined });
}
async function discoverCodexModels(models: Record<string, unknown>[]) {
  const fetch = vi.fn<LiveModelCatalogFetchGuard>(async ({ url }) => ({
    response: Response.json({ models }),
    finalUrl: url,
    release: async () => undefined,
  }));
  const { provider } = await runCatalogWithFetchGuard({
    fetchGuard: fetch,
    auth: {
      mode: "oauth",
      apiKey: "oauth-token",
      discoveryApiKey: "oauth-token",
      source: "profile",
      profileId: "openai:chatgpt",
    },
  });
  return { provider, fetch };
}

describe("OpenAI discovered subscription models", () => {
  beforeEach(() => {
    clearLiveCatalogCacheForTests();
    registry.fetch.mockReset();
  });
  afterEach(() => vi.restoreAllMocks());
  it("lists as the newest published Codex, so a model gated above the bundle appears", async () => {
    publishCodex(Response.json({ version: "0.999.0" }));
    const { fetch, provider } = await discoverCodexModels([
      { slug: "gpt-launch-day", visibility: "list", minimal_client_version: "0.999.0" },
    ]);

    expect(fetch.mock.calls.map(([{ url }]) => url)).toEqual([
      "https://chatgpt.com/backend-api/codex/models?client_version=0.999.0",
    ]);
    expect(provider.models.map((model) => model.id)).toContain("gpt-launch-day");
  });
  it.each([
    ["the registry is unreachable", () => registry.fetch.mockRejectedValue(new Error("offline"))],
    ["the registry fails", () => publishCodex(new Response("", { status: 503 }))],
    [
      "npm's latest is older than the bundle",
      () => publishCodex(Response.json({ version: "0.1.0" })),
    ],
    [
      "npm's latest is a prerelease",
      () => publishCodex(Response.json({ version: "9.0.0-alpha.1" })),
    ],
  ])("lists as the bundled Codex when %s", async (_case, arrange) => {
    arrange();
    const { fetch } = await discoverCodexModels([{ slug: "gpt-5.5", visibility: "list" }]);

    expect(fetch.mock.calls.map(([{ url }]) => url)).toEqual([
      `https://chatgpt.com/backend-api/codex/models?client_version=${BUNDLED_CODEX_CLIENT_VERSION}`,
    ]);
  });
  it.each([128_000, undefined])(
    "preserves the active window %s and enabled reasoning for discovered GPT-6.1 Sol",
    async (contextWindow) => {
      const { provider } = await discoverCodexModels([
        {
          slug: "gpt-6.1-sol",
          visibility: "list",
          supported_reasoning_levels: ["medium", "high"].map((effort) => ({ effort })),
          context_window: contextWindow,
          max_context_window: 1_050_000,
        },
      ]);
      const discovered = provider.models[0];
      assert(discovered, "expected discovered GPT-6.1 Sol");
      expect(discovered).toMatchObject({
        contextWindow: 1_050_000,
        contextTokens: contextWindow ?? 500_000,
        thinkingLevelMap: { off: null },
        compat: { supportedReasoningEfforts: ["medium", "high"] },
      });
      expect(
        clampThinkingLevel(
          {
            ...discovered,
            provider: "openai",
            api: "openai-chatgpt-responses",
            baseUrl: provider.baseUrl,
            input: ["text", "image"],
            contextWindow: discovered.contextWindow ?? 1_050_000,
          },
          "off",
        ),
      ).not.toBe("off");
    },
  );
});
