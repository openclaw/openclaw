// OpenAI API-key catalog tests cover account-scoped /v1/models discovery.
import {
  clearLiveCatalogCacheForTests,
  type LiveModelCatalogFetchGuard,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildOpenAIProvider } from "./openai-provider.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { resolveModelRoutes } from "./provider-policy-api.js";

async function runCatalogWithFetchGuard(params: {
  fetchGuard: LiveModelCatalogFetchGuard;
  auth: { mode: "api_key"; apiKey: string; profileId?: string; source: string };
  baseUrl?: string;
}) {
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
      resolveProviderApiKey: () => ({ apiKey: params.auth.apiKey }),
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

async function buildOpenAILiveProviderConfig(params: {
  apiKey: string;
  baseUrl?: string;
  fetchGuard: LiveModelCatalogFetchGuard;
}): Promise<ModelProviderConfig> {
  return (
    await runCatalogWithFetchGuard({
      fetchGuard: params.fetchGuard,
      auth: { mode: "api_key", apiKey: params.apiKey, source: "profile" },
      baseUrl: params.baseUrl,
    })
  ).provider;
}

describe("OpenAI API-key catalog", () => {
  beforeEach(() => {
    clearLiveCatalogCacheForTests();
  });

  it("filters the OpenAI API-key catalog against live model ids", async () => {
    const release = vi.fn(async () => undefined);
    const fetchGuard: LiveModelCatalogFetchGuard = vi.fn(async () => ({
      response: Response.json({
        data: [
          { id: "gpt-6-astra", object: "model" },
          { id: "gpt-daybreak-blue-latest", object: "model" },
          { id: "gpt-daybreak-red-latest", object: "model" },
          { id: "gpt-5.6", object: "model" },
          { id: "gpt-5.5", object: "model" },
          { id: "chat-latest", object: "model" },
          { id: "gpt-5.4", object: "model" },
          { id: "gpt-5.4-pro", object: "model" },
          { id: "gpt-5.4-mini", object: "model" },
          { id: "gpt-5.4-nano", object: "model" },
          { id: "gpt-5.3-codex-spark", object: "model" },
          { id: "not-in-manifest", object: "model" },
        ],
      }),
      finalUrl: "https://api.openai.com/v1/models",
      release,
    }));

    const provider = await buildOpenAILiveProviderConfig({
      apiKey: "sk-openai",
      fetchGuard,
    });

    expect(provider.apiKey).toBe("sk-openai");
    expect(provider.models.map((model) => model.id)).not.toContain("gpt-5.6");
    expect(provider.models.map((model) => model.id)).toContain("gpt-5.5");
    expect(provider.models.map((model) => model.id)).toEqual(
      expect.arrayContaining([
        "gpt-6-astra",
        "chat-latest",
        "gpt-5.4",
        "gpt-5.4-pro",
        "gpt-5.4-mini",
        "gpt-5.4-nano",
      ]),
    );
    for (const id of ["gpt-daybreak-blue-latest", "gpt-daybreak-red-latest"]) {
      expect(provider.models.find((model) => model.id === id)).toMatchObject({
        api: "openai-responses",
        compat: { supportedReasoningEfforts: expect.arrayContaining(["xhigh", "max"]) },
      });
    }
    expect(provider.models.find((model) => model.id === "chat-latest")).toMatchObject({
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      contextWindow: 400_000,
      maxTokens: 128_000,
      reasoning: false,
      cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
    });
    expect(provider.models.find((model) => model.id === "gpt-5.4-pro")).toMatchObject({
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      contextWindow: 1_050_000,
      maxTokens: 128_000,
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 30, output: 180, cacheRead: 0, cacheWrite: 0 },
    });
    expect(provider.models.find((model) => model.id === "gpt-5.4-mini")).toMatchObject({
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      contextWindow: 400_000,
      maxTokens: 128_000,
      cost: { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0 },
    });
    expect(provider.models.find((model) => model.id === "gpt-5.4-nano")).toMatchObject({
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      contextWindow: 400_000,
      maxTokens: 128_000,
      cost: { input: 0.2, output: 1.25, cacheRead: 0.02, cacheWrite: 0 },
    });
    expect(provider.models.map((model) => model.id)).not.toContain("gpt-5.3-codex-spark");
    expect(provider.models.map((model) => model.id)).not.toContain("not-in-manifest");
    const fetchParams = vi.mocked(fetchGuard).mock.calls[0]?.[0];
    expect(fetchParams?.url).toBe("https://api.openai.com/v1/models");
    const init = fetchParams?.init;
    const headers = init?.headers;
    expect(headers).toBeInstanceOf(Headers);
    if (!(headers instanceof Headers)) {
      throw new Error("expected fetch headers");
    }
    expect(headers.get("Authorization")).toBe("Bearer sk-openai");
    expect(release).toHaveBeenCalledOnce();
  });

  it("does not surface platform models omitted by the account's live catalog", async () => {
    const fetchGuard: LiveModelCatalogFetchGuard = vi.fn(async () => ({
      response: Response.json({ data: [{ id: "gpt-5.5", object: "model" }] }),
      finalUrl: "https://api.openai.com/v1/models",
      release: async () => undefined,
    }));

    const provider = await buildOpenAILiveProviderConfig({
      apiKey: "sk-openai",
      fetchGuard,
    });

    expect(provider.models.map((model) => model.id)).toEqual(["gpt-5.5"]);
  });

  it("admits account chat models missing from the manifest with conservative metadata", async () => {
    const unadmittedIds = [
      "gpt-5.5-2026-04-23",
      "gpt-5.2-chat-latest",
      "gpt-5.1-codex-max",
      "gpt-5.6-cyber",
      "gpt-6-preview",
      "gpt-7-alpha",
      "o5-beta",
      "gpt-5.5-codex-1p-exp-p-0618-b2fcc1-ev3-text-1-treatment",
      "gpt5-5-1p-exp-p-0628-2069ab-ev3-text-1-treatment",
      "gpt-4o-mini-search-preview",
      "gpt-4o-transcribe-diarize",
      "gpt-image-2",
      "gpt-realtime-2.1-mini",
      "gpt-audio-mini",
      "gpt-live-1",
      "o3-deep-research",
      "gpt-3.5-turbo-instruct",
      "gpt-4-0613",
      "text-embedding-3-small",
      "omni-moderation-latest",
      "tts-1-hd",
      "whisper-1",
      "sora-2",
      "ft:gpt-4.1-mini:acme::abc123",
      "kepler-alpha",
    ];
    const fetchGuard: LiveModelCatalogFetchGuard = vi.fn(async () => ({
      response: Response.json({
        data: ["gpt-5.5", "gpt-6.2", "gpt-4.1-mini", "o3", ...unadmittedIds].map((id) => ({
          id,
          object: "model",
        })),
      }),
      finalUrl: "https://api.openai.com/v1/models",
      release: async () => undefined,
    }));

    const provider = await buildOpenAILiveProviderConfig({ apiKey: "sk-openai", fetchGuard });

    expect(provider.models.map((model) => model.id)).toEqual([
      "gpt-5.5",
      "gpt-4.1-mini",
      "gpt-6.2",
      "o3",
    ]);
    const unknownModel = {
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 16_384,
    };
    for (const [id, reasoning] of [
      ["gpt-4.1-mini", false],
      ["gpt-6.2", true],
      ["o3", true],
    ] as const) {
      expect(provider.models.find((model) => model.id === id)).toEqual({
        id,
        name: id,
        reasoning,
        ...unknownModel,
      });
    }
    expect(provider.models.find((model) => model.id === "gpt-5.5")).toMatchObject({
      contextWindow: 1_050_000,
      cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
    });
  });

  it.each([
    [
      "returns an empty model list",
      () => Response.json({ data: [] }),
      "sk-openai-unavailable",
      false,
      "ready",
      "empty",
    ],
    [
      "returns only unsupported models",
      () => Response.json({ data: [{ id: "not-in-manifest", object: "model" }] }),
      "sk-openai-unavailable",
      false,
      "ready",
      "empty",
    ],
    [
      "rejects a SecretRef marker",
      () => new Response("unauthorized", { status: 401 }),
      "secretref-managed",
      true,
      "unavailable",
      "fallback",
    ],
    [
      "rejects a concrete API key",
      () => new Response("unauthorized", { status: 401 }),
      "sk-openai-unavailable",
      false,
      "auth-rejected",
      "empty",
    ],
    [
      "denies account access",
      () => new Response("forbidden", { status: 403 }),
      "sk-openai-unavailable",
      false,
      "auth-rejected",
      "empty",
    ],
    [
      "is temporarily unavailable",
      () => new Response("temporarily unavailable", { status: 503 }),
      "sk-openai-unavailable",
      false,
      "unavailable",
      "fallback",
    ],
  ] as const)(
    "scopes the selected API-key profile when discovery %s",
    async (_label, response, apiKey, catalogScoped, status, modelResult) => {
      const release = vi.fn(async () => undefined);
      const fetchGuard: LiveModelCatalogFetchGuard = vi.fn(async () => ({
        response: response(),
        finalUrl: "https://api.openai.com/v1/models",
        release,
      }));

      const result = await runCatalogWithFetchGuard({
        fetchGuard,
        auth: {
          mode: "api_key",
          apiKey,
          profileId: "openai:api-key",
          source: "profile",
        },
      });

      if (modelResult === "empty") {
        expect(result.provider.models).toEqual([]);
      } else {
        expect(result.provider.models.map((model) => model.id)).toEqual(
          manifest.modelCatalog.providers.openai.models.map((model) => model.id),
        );
      }
      expect(result.outcomes).toEqual([
        {
          provider: "openai",
          profileId: "openai:api-key",
          ...(catalogScoped ? { rejectionScope: "catalog" as const } : {}),
          status,
        },
      ]);
      if (apiKey === "secretref-managed") {
        expect(release).not.toHaveBeenCalled();
      } else {
        expect(release).toHaveBeenCalledOnce();
      }
    },
  );

  it("skips OpenAI live discovery for custom OpenAI-compatible base URLs", async () => {
    const customBaseUrl = "https://example-proxy.invalid/v1";
    const fetchGuard: LiveModelCatalogFetchGuard = vi.fn(async () => {
      throw new Error("unexpected OpenAI live discovery request");
    });

    const provider = await buildOpenAILiveProviderConfig({
      apiKey: "sk-custom-openai-compatible",
      baseUrl: customBaseUrl,
      fetchGuard,
    });

    expect(fetchGuard).not.toHaveBeenCalled();
    expect(provider.baseUrl).toBe(customBaseUrl);
    expect(provider.api).toBe("openai-responses");
    expect(provider.apiKey).toBe("sk-custom-openai-compatible");
    const apiModel = provider.models.find((model) => model.api !== "openai-chatgpt-responses");
    expect(apiModel?.baseUrl).toBe(customBaseUrl);
    expect(
      resolveModelRoutes({
        provider: "openai",
        modelId: apiModel?.id,
        configuredProvider: { api: provider.api, baseUrl: customBaseUrl },
        observedRoutes: apiModel ? [{ api: apiModel.api, baseUrl: apiModel.baseUrl }] : [],
      }),
    ).toMatchObject({
      kind: "routes",
      routes: [{ api: provider.api, baseUrl: customBaseUrl }],
    });
  });
});
