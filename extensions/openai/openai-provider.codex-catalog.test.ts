import {
  clearLiveCatalogCacheForTests,
  type LiveModelCatalogFetchGuard,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { forceFullGc } from "openclaw/plugin-sdk/test-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveOpenAICodexModelsEndpoint } from "./base-url.js";
import { buildOpenAIProvider } from "./openai-provider.js";
import discoveryProvider from "./provider-discovery.js";
import {
  mocks,
  buildOpenAICodexLiveProviderConfig,
} from "./test-support/live-catalog.test-support.js";

// mock-isolation: these tests spy on global fetch for the model list; the npm Codex
// version read is covered by openai-codex-discovery.test.ts.
vi.mock("./codex-client-version.js", () => ({
  resolveOpenAICodexClientVersion: async () => "0.1.0",
}));

const catalogContext = {
  config: { auth: { profiles: {} } },
  agentDir: "/tmp/openai-agent",
  workspaceDir: "/tmp/openai-workspace",
};

function reasoningLevels(...efforts: string[]) {
  return efforts.map((effort) => ({ effort, description: effort }));
}

function expectCatalogEntry(entries: unknown, id: string, expected: Record<string, unknown>): void {
  expect(Array.isArray(entries)).toBe(true);
  const entry = (entries as Array<Record<string, unknown>>).find(
    (candidate) => candidate.id === id,
  );
  if (!entry) {
    throw new Error(`expected catalog entry ${id}`);
  }
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(entry[key], key).toEqual(expectedValue);
  }
}

function expectNoCatalogEntry(entries: unknown, id: string): void {
  expect(Array.isArray(entries)).toBe(true);
  const entryIds = new Set((entries as Array<Record<string, unknown>>).map((entry) => entry.id));
  expect(entryIds.has(id)).toBe(false);
}

describe("OpenAI ChatGPT OAuth catalog", () => {
  beforeEach(() => {
    clearLiveCatalogCacheForTests();
    mocks.resolveApiKeyForProvider.mockReset();
    mocks.resolveProviderAuthProfileMetadata.mockReset();
  });

  it("uses the Codex backend catalog for OpenAI OAuth discovery", async () => {
    mocks.resolveApiKeyForProvider.mockResolvedValue({
      mode: "oauth",
      apiKey: "fresh-oauth-token",
      source: "profile:openai:chatgpt",
      profileId: "openai:chatgpt",
    });
    mocks.resolveProviderAuthProfileMetadata.mockReturnValue({
      profileId: "openai:chatgpt",
      accountId: "acct-openai-workspace",
    });
    const provider = buildOpenAIProvider();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        models: [
          {
            slug: "gpt-5.6-sol",
            display_name: "GPT-5.6 Sol",
            visibility: "list",
            supported_reasoning_levels: reasoningLevels("low", "medium", "high", "xhigh", "max"),
            input_modalities: ["text", "image"],
            context_window: 372_000,
            max_context_window: 372_000,
          },
          {
            slug: "gpt-5.5",
            display_name: "GPT-5.5",
            visibility: "list",
            supported_reasoning_levels: reasoningLevels("low", "medium", "high"),
            input_modalities: ["text", "image"],
            context_window: 272_000,
            max_context_window: 1_000_000,
            max_output_tokens: 128_000,
          },
          {
            slug: "gpt-5.6-terra",
            display_name: "GPT-5.6 Terra",
            visibility: "list",
            supported_reasoning_levels: reasoningLevels("medium"),
          },
          {
            slug: "gpt-5.3-codex-spark",
            display_name: "GPT-5.3 Codex Spark",
            visibility: "list",
            supported_reasoning_levels: reasoningLevels("high"),
            context_window: 200_000,
            max_output_tokens: 64_000,
          },
          {
            slug: "codex-auto-review",
            display_name: "Codex Auto Review",
            visibility: "hide",
          },
          {
            slug: "codex-internal-fallback",
            display_name: "Codex Internal Fallback",
            visibility: "none",
          },
        ],
      }),
    );

    try {
      const result = await discoveryProvider.catalog?.run({
        resolveProviderAuth: () => ({
          mode: "oauth",
          apiKey: "stale-oauth-token",
          profileId: "openai:chatgpt",
          source: "profile",
        }),
        ...catalogContext,
      } as never);

      if (!result || "provider" in result) {
        throw new Error("expected OpenAI Codex live provider catalog");
      }
      expect(mocks.resolveApiKeyForProvider).toHaveBeenCalledWith({
        provider: "openai",
        cfg: { auth: { profiles: {} } },
        agentDir: "/tmp/openai-agent",
        workspaceDir: "/tmp/openai-workspace",
        profileId: "openai:chatgpt",
        lockedProfile: true,
      });
      expect(mocks.resolveProviderAuthProfileMetadata).toHaveBeenCalledWith({
        provider: "openai",
        cfg: { auth: { profiles: {} } },
        agentDir: "/tmp/openai-agent",
        profileId: "openai:chatgpt",
      });
      const openai = result.providers.openai;
      expect(openai?.api).toBe("openai-chatgpt-responses");
      expect(openai?.auth).toBe("oauth");
      expect(openai?.baseUrl).toBe("https://chatgpt.com/backend-api/codex");
      const shown = openai?.models.map((model) => model.id) ?? [];
      expect(shown).toEqual(["gpt-5.6-sol", "gpt-5.5", "gpt-5.6-terra", "gpt-5.3-codex-spark"]);
      // Entitlement keeps hidden rows that the picker omits.
      const hidden = ["codex-auto-review", "codex-internal-fallback"];
      expect(result.outcomes?.[0]?.listedModelIds).toEqual([...shown, ...hidden]);
      expect(openai?.models.find((model) => model.id === "gpt-5.6-sol")).toMatchObject({
        contextWindow: 372_000,
        compat: {
          supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
        },
        thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" },
      });
      const liveSol = openai?.models.find((model) => model.id === "gpt-5.6-sol");
      expect(
        provider.resolveThinkingProfile?.({
          provider: "openai",
          modelId: "gpt-5.6-sol",
          agentRuntime: "codex",
          api: "openai-chatgpt-responses",
          compat: liveSol?.compat,
        } as never)?.levels,
      ).toContainEqual({ id: "ultra" });
      expect(openai?.models.find((model) => model.id === "gpt-5.6-terra")).toMatchObject({
        contextWindow: 372_000,
        contextTokens: 272_000,
      });
      expect(openai?.models.find((model) => model.id === "gpt-5.3-codex-spark")).toMatchObject({
        name: "GPT-5.3 Codex Spark",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 200_000,
        maxTokens: 64_000,
      });
      expect(fetchSpy).toHaveBeenCalledOnce();
      expect(fetchSpy.mock.calls[0]?.[0]).toBe(await resolveOpenAICodexModelsEndpoint());
      const headers = fetchSpy.mock.calls[0]?.[1]?.headers;
      expect(headers).toBeInstanceOf(Headers);
      if (!(headers instanceof Headers)) {
        throw new Error("expected fetch headers");
      }
      expect(headers.get("Authorization")).toBe("Bearer fresh-oauth-token");
      expect(headers.get("ChatGPT-Account-ID")).toBe("acct-openai-workspace");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("uses runtime OAuth profiles when catalog auth resolution is empty", async () => {
    mocks.resolveApiKeyForProvider.mockResolvedValue({
      mode: "oauth",
      apiKey: "fresh-oauth-token",
      source: "profile:openai:chatgpt",
      profileId: "openai:chatgpt",
    });
    mocks.resolveProviderAuthProfileMetadata.mockReturnValue({
      profileId: "openai:chatgpt",
      accountId: "acct-openai-workspace",
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        models: [
          {
            slug: "gpt-5.5",
            display_name: "GPT-5.5",
            visibility: "list",
          },
        ],
      }),
    );

    try {
      const result = await discoveryProvider.catalog?.run({
        resolveProviderAuth: () => ({
          mode: "none",
          apiKey: undefined,
          discoveryApiKey: undefined,
          source: "none",
        }),
        ...catalogContext,
      } as never);

      if (!result || "provider" in result) {
        throw new Error("expected OpenAI Codex live provider catalog");
      }
      expect(mocks.resolveApiKeyForProvider).toHaveBeenCalledWith({
        provider: "openai",
        cfg: { auth: { profiles: {} } },
        agentDir: "/tmp/openai-agent",
        workspaceDir: "/tmp/openai-workspace",
      });
      expect(result.providers.openai?.api).toBe("openai-chatgpt-responses");
      expect(result.providers.openai?.auth).toBe("oauth");
      expect(result.providers.openai?.models.map((model) => model.id)).toEqual(["gpt-5.5"]);
      expect(fetchSpy).toHaveBeenCalledOnce();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("rejects Platform-only aliases while preserving GPT-5.6 ChatGPT capabilities", async () => {
    const fetchGuard: LiveModelCatalogFetchGuard = vi.fn(async () => ({
      response: Response.json({
        models: [
          {
            slug: "gpt-5.6",
            visibility: "list",
          },
          {
            slug: "chat-latest",
            visibility: "list",
          },
          {
            slug: "gpt-5.6-preview-2026-07-22",
            visibility: "list",
            context_window: 400_000,
            max_context_window: 1_050_000,
          },
          ...["sol", "terra", "luna"].map((tier) => ({
            slug: `gpt-5.6-${tier}`,
            visibility: "list",
            supported_reasoning_levels: [
              { effort: "low", description: "low" },
              { effort: "high", description: "high" },
              ...(tier === "luna" ? [{ effort: "ultra", description: "ultra" }] : []),
            ],
          })),
        ],
      }),
      finalUrl: "https://chatgpt.com/backend-api/codex/models?client_version=1.0.0",
      release: async () => undefined,
    }));

    const provider = await buildOpenAICodexLiveProviderConfig({
      discoveryApiKey: "oauth-token",
      fetchGuard,
    });

    expectNoCatalogEntry(provider.models, "gpt-5.6");
    expectNoCatalogEntry(provider.models, "chat-latest");
    expectCatalogEntry(provider.models, "gpt-5.6-preview-2026-07-22", {
      contextWindow: 1_050_000,
      contextTokens: 272_000,
    });
    for (const tier of ["sol", "terra"] as const) {
      expect(provider.models.find((model) => model.id === `gpt-5.6-${tier}`)).toMatchObject({
        reasoning: true,
        compat: {
          supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
        },
      });
    }
    expect(provider.models.find((model) => model.id === "gpt-5.6-luna")).toMatchObject({
      reasoning: true,
      compat: {
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
      },
    });
  });

  it("releases raw Codex instructions while reusing account catalog facts", async () => {
    const body = JSON.stringify({
      models: [
        {
          slug: "catalog-retention-fixture",
          display_name: "Catalog retention fixture",
          visibility: "list",
          base_instructions: "Synthetic instructions".repeat(1024),
          model_messages: { instructions_template: "Synthetic template".repeat(1024) },
        },
      ],
    });
    const rows: WeakRef<object>[] = [];
    const parse = JSON.parse;
    const parseSpy = vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
      const parsed: unknown = parse(text, reviver);
      if (
        text === body &&
        parsed &&
        typeof parsed === "object" &&
        "models" in parsed &&
        Array.isArray(parsed.models)
      ) {
        rows.push(new WeakRef(parsed.models[0]));
      }
      return parsed;
    });
    const fetchGuard = vi.fn<LiveModelCatalogFetchGuard>(async () => ({
      response: new Response(body),
      finalUrl: "https://chatgpt.com/backend-api/codex/models?client_version=1.0.0",
      release: async () => undefined,
    }));
    try {
      for (const accountId of ["account-one", "account-one", "account-two"]) {
        const provider = await buildOpenAICodexLiveProviderConfig({
          discoveryApiKey: "synthetic-retention-token",
          accountId,
          fetchGuard,
        });
        expect(provider.models).toEqual([
          expect.objectContaining({
            id: "catalog-retention-fixture",
            name: "Catalog retention fixture",
            api: "openai-chatgpt-responses",
          }),
        ]);
      }
      expect(fetchGuard).toHaveBeenCalledTimes(2);
      expect(rows).toHaveLength(2);
    } finally {
      parseSpy.mockRestore();
    }
    // Cross the job boundary before collection; the cached projection stays available.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    forceFullGc();
    expect(rows.map((row) => row.deref() !== undefined)).toEqual([false, false]);
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
});
