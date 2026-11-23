import { clampThinkingLevel } from "openclaw/plugin-sdk/llm";
import {
  clearLiveCatalogCacheForTests,
  type LiveModelCatalogFetchGuard,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { runCatalogWithFetchGuard } from "./test-support/live-catalog.test-support.js";

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
  beforeEach(clearLiveCatalogCacheForTests);
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  it.each([
    ["2026.11.5", "2026.11.5"],
    ["2027.1.1", "2027.1.1"],
    ["2026.11.5-beta.1", "2026.11.5"],
    ["2026.11.5-1+build.abc", "2026.11.5"],
    ["0.0.0", "99.0.0"],
    ["unknown", "99.0.0"],
    ["dev", "99.0.0"],
    ["beta", "99.0.0"],
    ["0.170.0", "99.0.0"],
    ["2025.12.31", "99.0.0"],
    ["10000.1.1", "99.0.0"],
    ["2026.11", "99.0.0"],
    ["2026.11.5garbage", "2026.11.5"],
  ])("lists with OpenClaw version %s or its safe fallback", async (version, expected) => {
    vi.stubEnv("OPENCLAW_VERSION", version);
    const { fetch, provider } = await discoverCodexModels([
      { slug: "gpt-launch-day", visibility: "list" },
    ]);

    expect(fetch.mock.calls.map(([{ url }]) => url)).toEqual([
      `https://chatgpt.com/backend-api/codex/models?client_version=${encodeURIComponent(expected)}`,
    ]);
    expect(provider.models.map((model) => model.id)).toContain("gpt-launch-day");
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
