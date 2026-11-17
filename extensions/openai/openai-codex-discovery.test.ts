import { clampThinkingLevel } from "openclaw/plugin-sdk/llm";
import {
  clearLiveCatalogCacheForTests,
  type LiveModelCatalogFetchGuard,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { runCatalogWithFetchGuard } from "./test-support/live-catalog.test-support.js";
const codexClient = vi.hoisted(() => ({
  resolveCodexClientVersion: vi.fn(async (): Promise<string | undefined> => undefined),
}));
// mock-isolation: the real facade loads the Codex plugin, which probes the host PATH for codex.
vi.mock("openclaw/plugin-sdk/codex-client-version-runtime", () => codexClient);
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
  beforeEach(() => clearLiveCatalogCacheForTests());
  afterEach(() => vi.restoreAllMocks());
  it.each([undefined, "0.162.1"])(
    "uses the broad subscription catalog regardless of the selected Codex version (%s)",
    async (runtimeVersion) => {
      codexClient.resolveCodexClientVersion.mockResolvedValue(runtimeVersion);
      const { fetch } = await discoverCodexModels([{ slug: "gpt-5.5", visibility: "list" }]);

      expect(fetch.mock.calls.map(([{ url }]) => url)).toEqual([
        "https://chatgpt.com/backend-api/codex/models?client_version=99.0.0",
      ]);
      expect(codexClient.resolveCodexClientVersion).not.toHaveBeenCalled();
    },
  );
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
