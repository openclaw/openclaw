import { clampThinkingLevel } from "openclaw/plugin-sdk/llm";
import {
  clearLiveCatalogCacheForTests,
  type LiveModelCatalogFetchGuard,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { runCatalogWithFetchGuard } from "./test-support/live-catalog.test-support.js";

async function discoverCodexModels(
  models: Record<string, unknown>[],
  registry = async () => Response.json({ version: "0.999.0" }),
) {
  const fetch = vi.fn<LiveModelCatalogFetchGuard>(async ({ url }) => ({
    response:
      url === "https://registry.npmjs.org/@openai/codex/latest"
        ? await registry()
        : Response.json({ models }),
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
  it("lists with the newest published Codex independently of the OpenClaw version", async () => {
    vi.stubEnv("OPENCLAW_VERSION", "2026.11.5");
    const { fetch, provider } = await discoverCodexModels([
      { slug: "gpt-launch-day", visibility: "list" },
    ]);

    expect(fetch.mock.calls.map(([{ url }]) => url)).toEqual([
      "https://registry.npmjs.org/@openai/codex/latest",
      "https://chatgpt.com/backend-api/codex/models?client_version=0.999.0",
    ]);
    expect(provider.models.map((model) => model.id)).toContain("gpt-launch-day");
  });
  it.each([
    ["older version", async () => Response.json({ version: "0.1.0" })],
    ["prerelease", async () => Response.json({ version: "9.0.0-alpha.1" })],
    ["missing version", async () => Response.json({})],
    ["invalid JSON", async () => new Response("invalid JSON")],
    ["HTTP failure", async () => new Response("", { status: 503 })],
    [
      "network failure",
      async () => {
        throw new Error("offline");
      },
    ],
  ])("lists with the bundled Codex after a registry %s", async (_case, registry) => {
    const { fetch } = await discoverCodexModels([], registry);
    expect(fetch.mock.calls.at(-1)?.[0].url).toBe(
      "https://chatgpt.com/backend-api/codex/models?client_version=0.169.0",
    );
  });
  it("caches successful versions for six hours and retries a failed refresh on the next listing", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const registry = vi
      .fn(async () => Response.json({ version: "0.999.0" }))
      .mockResolvedValueOnce(Response.json({ version: "0.999.0" }))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(Response.json({ version: "0.1000.0" }));

    await discoverCodexModels([], registry);
    now += 6 * 60 * 60_000 - 1;
    await discoverCodexModels([], registry);
    expect(registry).toHaveBeenCalledTimes(1);

    now += 2;
    const failed = await discoverCodexModels([], registry);
    expect(failed.fetch.mock.calls.at(-1)?.[0].url).toBe(
      "https://chatgpt.com/backend-api/codex/models?client_version=0.169.0",
    );
    const retried = await discoverCodexModels([], registry);
    expect(registry).toHaveBeenCalledTimes(3);
    expect(retried.fetch.mock.calls.at(-1)?.[0].url).toBe(
      "https://chatgpt.com/backend-api/codex/models?client_version=0.1000.0",
    );
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
