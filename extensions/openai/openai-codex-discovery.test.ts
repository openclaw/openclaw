import fs from "node:fs";
import { clampThinkingLevel } from "openclaw/plugin-sdk/llm";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOpenAIProvider } from "./openai-provider.js";

const mocks = vi.hoisted(() => ({
  resolveApiKeyForProvider: vi.fn(),
  resolveProviderAuthProfileMetadata: vi.fn(),
}));
const codexClient = vi.hoisted(() => ({
  resolveCodexClientVersion: vi.fn(async (): Promise<string | undefined> => undefined),
}));
// mock-isolation: Discovery fixtures supply synthetic credentials and account metadata.
vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: mocks.resolveApiKeyForProvider,
  resolveProviderAuthProfileMetadataAsync: mocks.resolveProviderAuthProfileMetadata,
}));
// mock-isolation: the real facade loads the Codex plugin, which probes the host PATH for codex.
vi.mock("openclaw/plugin-sdk/codex-client-version-runtime", () => codexClient);
const codexPackage = JSON.parse(
  fs.readFileSync(new URL("../codex/package.json", import.meta.url), "utf8"),
);
const modelsUrl = `https://chatgpt.com/backend-api/codex/models?client_version=${codexPackage.dependencies["@openai/codex"]}`;

async function discoverCodexModels(models: Record<string, unknown>[], accountId?: string) {
  const auth = {
    mode: "oauth",
    apiKey: "oauth-token",
    source: "profile",
    profileId: "openai:chatgpt",
  };
  mocks.resolveApiKeyForProvider.mockResolvedValue(auth);
  mocks.resolveProviderAuthProfileMetadata.mockReturnValue({
    profileId: "openai:chatgpt",
    accountId,
  });
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => Response.json({ models }));
  const result = await buildOpenAIProvider().catalog?.run({
    resolveProviderAuth: () => auth,
    resolveProviderApiKey: () => ({ apiKey: auth.apiKey, discoveryApiKey: auth.apiKey }),
    config: { auth: { profiles: {} } },
    agentDir: "/tmp/openai-agent",
    workspaceDir: "/tmp/openai-workspace",
  } as never);
  if (!result || "provider" in result || !result.providers.openai) {
    throw new Error("expected OpenAI catalog");
  }
  return { provider: result.providers.openai, fetch };
}

describe("OpenAI discovered subscription models", () => {
  beforeEach(() => clearLiveCatalogCacheForTests());
  afterEach(() => vi.restoreAllMocks());
  it("reports the Codex binary version that runs turns as client_version", async () => {
    codexClient.resolveCodexClientVersion.mockResolvedValueOnce("0.162.1");
    const { fetch } = await discoverCodexModels([{ slug: "gpt-5.5", visibility: "list" }]);

    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "https://chatgpt.com/backend-api/codex/models?client_version=0.162.1",
    ]);
    expect(codexClient.resolveCodexClientVersion).toHaveBeenCalledWith({
      config: { auth: { profiles: {} } },
      env: undefined,
      agentDir: "/tmp/openai-agent",
    });
  });
  it.each([
    { modelId: "gpt-5.4", contextWindow: 272_000, contextTokens: 272_000 },
    { modelId: "gpt-6-astra", contextWindow: 272_000, contextTokens: 272_000 },
    { modelId: "gpt-6-sol", contextWindow: 272_000, contextTokens: 272_000 },
    { modelId: "gpt-6-luna", contextWindow: 272_000, contextTokens: 272_000 },
    { modelId: "gpt-6.1-sol", contextWindow: 500_000, contextTokens: 500_000 },
    { modelId: "gpt-6.1-sol", contextWindow: 128_000, contextTokens: 128_000 },
    { modelId: "gpt-6.1-sol", contextWindow: 700_000, contextTokens: 700_000 },
    { modelId: "gpt-6.1-sol", contextWindow: undefined, contextTokens: 500_000 },
  ])(
    "maps discovered $modelId with active window $contextWindow into a ChatGPT response model",
    async ({ modelId, contextWindow, contextTokens }) => {
      const { provider, fetch } = await discoverCodexModels(
        [
          {
            slug: modelId,
            display_name: modelId,
            visibility: "list",
            supported_reasoning_levels: ["medium", "high"].map((effort) => ({ effort })),
            context_window: contextWindow,
            max_context_window: 1_050_000,
            max_output_tokens: 128_000,
          },
          ...["hide", "none"].map((visibility) => ({ slug: `hidden-${visibility}`, visibility })),
        ],
        "acct-openai-workspace",
      );

      expect(provider).toMatchObject({ api: "openai-chatgpt-responses", auth: "oauth" });
      expect(provider?.models.map((model) => model.id)).toEqual([modelId]);
      expect(provider?.models[0]).toMatchObject({
        baseUrl: "https://chatgpt.com/backend-api/codex",
        input: ["text", "image"],
        reasoning: true,
        contextWindow: 1_050_000,
        contextTokens,
        maxTokens: 128_000,
      });
      if (modelId === "gpt-6.1-sol") {
        const discovered = provider.models[0];
        assert(discovered, "expected discovered GPT-6.1 Sol");
        expect(discovered).toMatchObject({
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
              input: discovered.input.filter(
                (modality) => modality === "text" || modality === "image",
              ),
              contextWindow: discovered.contextWindow ?? 1_050_000,
            },
            "off",
          ),
        ).not.toBe("off");
      }
      const [url, init] = fetch.mock.calls[0] ?? [];
      expect(url).toBe(modelsUrl);
      const headers = init?.headers;
      assert(headers instanceof Headers, "expected fetch headers");
      expect(headers.get("Authorization")).toBe("Bearer oauth-token");
      expect(headers.get("ChatGPT-Account-ID")).toBe("acct-openai-workspace");
    },
  );
});
