import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildOpenAIProvider } from "./openai-provider.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { resolveModelRoutes } from "./provider-policy-api.js";

async function runCatalog(
  response: Response | undefined,
  {
    apiKey = "sk-openai",
    baseUrl,
    profileId,
  }: {
    apiKey?: string;
    baseUrl?: string;
    profileId?: string;
  } = {},
) {
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    if (!response) {
      throw new Error("unexpected OpenAI live discovery request");
    }
    return response;
  });
  try {
    const result = await buildOpenAIProvider().catalog?.run({
      resolveProviderAuth: () => ({ mode: "api_key", apiKey, profileId, source: "profile" }),
      resolveProviderApiKey: () => ({ apiKey }),
      config: baseUrl
        ? { models: { providers: { openai: { baseUrl, models: [] } } } }
        : { auth: { profiles: {} } },
      env: process.env,
      agentDir: "/tmp/openai-agent",
      workspaceDir: "/tmp/openai-workspace",
    });
    if (!result || "provider" in result || !result.providers.openai) {
      throw new Error("expected OpenAI live provider catalog");
    }
    return {
      provider: result.providers.openai,
      outcomes: result.outcomes ?? [],
      requests: [...fetch.mock.calls],
    };
  } finally {
    fetch.mockRestore();
  }
}

describe("OpenAI API-key catalog", () => {
  beforeEach(() => {
    clearLiveCatalogCacheForTests();
  });

  it("shows every listed chat model that runs on Responses with conservative metadata", async () => {
    const admittedIds = ["gpt-5.3-codex", "gpt-5.5-2026-04-23", "gpt-6.2"];
    const unadmittedIds = [
      // Pre-GPT-5 families fail on the default runtime.
      "gpt-4-0613",
      "gpt-4.1-mini",
      "o3",
      "ft:gpt-4.1-mini:acme::abc123",
      "gpt-5.3-codex-spark",
      "gpt-5.6-cyber",
      "gpt-7-alpha",
      "kepler-alpha",
      "gpt-5.5-codex-1p-exp-p-0618-b2fcc1-ev3-text-1-treatment",
      "gpt5-5-1p-exp-p-0628-2069ab-ev3-text-1-treatment",
      "gpt-4o-mini-search-preview",
      "gpt-5-search-api",
      "gpt-live-1",
      "gpt-4o-transcribe-diarize",
      "gpt-image-2",
      "gpt-realtime-2.1-mini",
      "gpt-audio-mini",
      "gpt-3.5-turbo-instruct",
      "babbage-002",
      "text-embedding-3-small",
      "omni-moderation-latest",
      "tts-1-hd",
      "whisper-1",
      "sora-2",
    ];
    const { provider } = await runCatalog(
      Response.json({
        data: [
          ...["gpt-5.5", ...admittedIds, ...unadmittedIds].map((id) => ({ id, object: "model" })),
          // OpenAI keeps retired models listed with a past shutdown date; requests to them 404.
          { id: "gpt-5.2-chat-latest", object: "model", shutdown_date: "2026-01-01" },
        ],
      }),
    );

    expect(provider.models.map((model) => model.id).toSorted()).toEqual(
      ["gpt-5.5", ...admittedIds].toSorted(),
    );
    for (const id of ["gpt-5.3-codex", "gpt-6.2"]) {
      expect(provider.models.find((model) => model.id === id)).toEqual({
        id,
        name: id,
        reasoning: true,
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 16_384,
      });
    }
    expect(provider.models.find((model) => model.id === "gpt-5.5")).toMatchObject({
      contextWindow: 1_050_000,
      cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
    });
  });

  it.each([
    ["only unsupported models", 200, "sk-openai", "ready"],
    ["a SecretRef marker", 401, "secretref-managed", "unavailable"],
    ["an unauthorized key", 401, "sk-openai", "auth-rejected"],
    ["a forbidden key", 403, "sk-openai", "auth-rejected"],
    ["a temporary failure", 503, "sk-openai", "unavailable"],
  ] as const)("scopes the selected profile for %s", async (_label, httpStatus, apiKey, status) => {
    const { provider, outcomes, requests } = await runCatalog(
      Response.json(
        { data: [{ id: "text-embedding-3-small", object: "model" }] },
        { status: httpStatus },
      ),
      { apiKey, profileId: "openai:api-key" },
    );
    expect(provider.models.map((model) => model.id)).toEqual(
      status === "unavailable"
        ? manifest.modelCatalog.providers.openai.models.map((model) => model.id)
        : [],
    );
    expect(outcomes).toEqual([
      {
        provider: "openai",
        profileId: "openai:api-key",
        ...(apiKey === "secretref-managed" ? { rejectionScope: "catalog" } : {}),
        status,
      },
    ]);
    if (apiKey === "secretref-managed") {
      expect(requests).toEqual([]);
    } else {
      expect(requests).toHaveLength(1);
      expect(requests[0]?.[0]).toBe("https://api.openai.com/v1/models");
      expect(new Headers(requests[0]?.[1]?.headers).get("Authorization")).toBe(`Bearer ${apiKey}`);
    }
  });

  it("skips OpenAI live discovery for custom OpenAI-compatible base URLs", async () => {
    const customBaseUrl = "https://example-proxy.invalid/v1";
    const { provider, requests } = await runCatalog(undefined, {
      apiKey: "sk-custom-openai-compatible",
      baseUrl: customBaseUrl,
    });
    expect(requests).toEqual([]);
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
