import type {
  ProviderCatalogContext,
  ProviderPrepareDynamicModelContext,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  registerProviderPlugin,
  registerSingleProviderPlugin,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { NON_ENV_SECRETREF_MARKER } from "openclaw/plugin-sdk/provider-auth-runtime";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { expectPassthroughReplayPolicy } from "openclaw/plugin-sdk/provider-test-contracts";
import * as ssrfRuntime from "openclaw/plugin-sdk/ssrf-runtime";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import {
  buildOpencodeZenLiveProviderConfig,
  prepareOpencodeZenModel,
  resolveOpencodeZenStarterModel,
} from "./provider-catalog.js";

const requireRecord = createRequireRecord("record", "expected-label-record");
const noAuth = () => ({ apiKey: undefined, mode: "none" as const, source: "none" });
const blockFetch = () =>
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected fetch"));

async function registerFixture() {
  const provider = await registerSingleProviderPlugin(plugin);
  return {
    provider,
    dynamicModel: (modelId: string) => provider.resolveDynamicModel?.({ modelId } as never),
    prepareDynamicModel: (
      modelId: string,
      context: Partial<ProviderPrepareDynamicModelContext> = {},
    ) =>
      provider.prepareDynamicModel?.({
        config: {},
        provider: "opencode",
        modelId,
        modelRegistry: {} as never,
        ...context,
      }),
    catalog: (context: Partial<ProviderCatalogContext>) =>
      provider.catalog?.run({ config: {}, env: {}, ...context } as ProviderCatalogContext),
  };
}
const METADATA_URL = "https://models.opencode.ai/api.json";
const MODELS_URL = "https://opencode.ai/zen/v1/models";
function prepareModel(modelId: string, fetchGuard: typeof ssrfRuntime.fetchWithSsrFGuard) {
  vi.spyOn(ssrfRuntime, "fetchWithSsrFGuard").mockImplementation(fetchGuard);
  return prepareOpencodeZenModel({ modelId });
}
function buildLiveCatalog(
  fetchGuard: typeof ssrfRuntime.fetchWithSsrFGuard,
  apiKey: string,
  discoveryApiKey: string,
) {
  return buildOpencodeZenLiveProviderConfig({ apiKey, discoveryApiKey, fetchGuard });
}
const OFFLINE_MODEL_IDS = [
  "claude-opus-5",
  "gpt-5.6-sol",
  "gemini-3.6-flash",
  "minimax-m3",
  "kimi-k3",
  "big-pickle",
] as const;

type UpstreamFixtureModel = {
  id: string;
  name?: string;
  npm?: string;
  status?: string;
  reasoningEfforts?: string[];
};

function upstreamCatalog(models: readonly UpstreamFixtureModel[]) {
  return {
    opencode: {
      id: "opencode",
      api: "https://opencode.ai/zen/v1",
      npm: "@ai-sdk/openai-compatible",
      models: Object.fromEntries(
        models.map((model) => [
          model.id,
          {
            id: model.id,
            name: model.name ?? model.id,
            reasoning: true,
            tool_call: true,
            modalities: { input: ["text", "image"], output: ["text"] },
            limit: { context: 1_000_000, input: 900_000, output: 131_072 },
            cost: { input: 0, output: 0, cache_read: 0 },
            ...(model.npm ? { provider: { npm: model.npm } } : {}),
            ...(model.status ? { status: model.status } : {}),
            ...(model.reasoningEfforts
              ? { reasoning_options: [{ type: "effort", values: model.reasoningEfforts }] }
              : {}),
          },
        ]),
      ),
    },
  };
}

function guardedResponse(url: string, body: unknown) {
  return {
    response: Response.json(body),
    finalUrl: url,
    release: vi.fn(async () => undefined),
  };
}

function createCatalogFetchGuard(params: {
  metadata: readonly UpstreamFixtureModel[];
  advertised: readonly string[] | ((authorization: string | null) => readonly string[]);
}) {
  return vi.fn(async ({ url, init }: { url: string; init?: RequestInit }) => {
    if (url === METADATA_URL) {
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      return guardedResponse(url, upstreamCatalog(params.metadata));
    }
    if (url === MODELS_URL) {
      expect(new Headers(init?.headers).get("user-agent")).toMatch(/^openclaw\/\S+$/);
      const authorization = new Headers(init?.headers).get("authorization");
      const ids =
        typeof params.advertised === "function"
          ? params.advertised(authorization)
          : params.advertised;
      return guardedResponse(url, { data: ids.map((id) => ({ id, object: "model" })) });
    }
    throw new Error(`unexpected discovery URL: ${url}`);
  });
}

function expectSeedModels(models: ReadonlyArray<{ id: string }>) {
  expect(models.map((model) => model.id)).toEqual(OFFLINE_MODEL_IDS);
}

describe("opencode provider plugin", () => {
  beforeEach(() => {
    clearLiveCatalogCacheForTests();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("registers only the Zen auth choice from its own provider manifest", async () => {
    const provider = await registerSingleProviderPlugin(plugin);

    expect(provider.id).toBe("opencode");
    expect(provider.envVars).toEqual(["OPENCODE_API_KEY", "OPENCODE_ZEN_API_KEY"]);
    expect(provider.auth.map((method) => method.wizard?.choiceId)).toEqual(["opencode-zen"]);
    expect(provider.auth[0]?.wizard).toMatchObject({
      choiceLabel: "OpenCode Zen catalog",
      groupId: "opencode",
      groupHint: "Shared API key infrastructure for Zen + Go",
    });
  });

  it("classifies client-restricted free models without cooling down valid credentials", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    for (const error of [
      { status: 403, errorType: "FreeTierError", errorMessage: "Request refused" },
      { status: 403, code: "FreeTierError", errorMessage: "Request refused" },
      {
        status: 403,
        errorMessage:
          '403 {"type":"error","error":{"type":"FreeTierError","message":"Client restricted"}}',
      },
      {
        status: 403,
        errorMessage: "403 OpenCode's free tier can only be used from within OpenCode",
      },
    ]) {
      expect(provider.classifyFailoverReason?.(error)).toBe("model_not_found");
    }
    expect(
      provider.classifyFailoverReason?.({ status: 403, errorMessage: "Invalid API key" }),
    ).toBeUndefined();
    expect(
      provider.classifyFailoverReason?.({
        status: 402,
        errorMessage: "Insufficient account funds",
      }),
    ).toBeUndefined();
  });

  it("registers image media understanding through the OpenCode plugin", async () => {
    const { mediaProviders } = await registerProviderPlugin({
      plugin,
      id: "opencode",
      name: "OpenCode Zen Provider",
    });
    const mediaProvider = mediaProviders.find((provider) => provider.id === "opencode");

    expect(mediaProvider?.capabilities).toEqual(["image"]);
    expect(mediaProvider?.defaultModels).toEqual({ image: "minimax-m3" });
    expect(typeof mediaProvider?.describeImage).toBe("function");
    expect(typeof mediaProvider?.describeImages).toBe("function");
  });

  it("owns Gemini-only passthrough replay policy", async () => {
    await expectPassthroughReplayPolicy({
      plugin,
      providerId: "opencode",
      modelId: "gemini-2.5-pro",
      sanitizeThoughtSignatures: true,
    });
    await expectPassthroughReplayPolicy({
      plugin,
      providerId: "opencode",
      modelId: "claude-opus-4.6",
    });
  });

  it("keeps the offline manifest seed resolvable without downloading metadata", async () => {
    const fetchMock = blockFetch();
    const { provider, dynamicModel } = await registerFixture();
    const result = await provider.staticCatalog?.run({} as never);

    if (!result || !("provider" in result)) {
      throw new Error("expected registered OpenCode Zen static provider");
    }
    expectSeedModels(result.provider.models);
    // Official public-feed snapshot, 2026-08-30; connected pricing refreshes independently.
    expect(result.provider.models.find((model) => model.id === "gpt-5.6-sol")?.cost).toEqual({
      input: 2,
      output: 10,
      cacheRead: 0.2,
      cacheWrite: 2.5,
      tieredPricing: [
        { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5, range: [0, 272_000] },
        { input: 4, output: 15, cacheRead: 0.4, cacheWrite: 5, range: [272_000] },
      ],
    });
    for (const [id, api, baseUrl] of [
      ["claude-opus-5", "anthropic-messages", "https://opencode.ai/zen"],
      ["gpt-5.6-sol", "openai-responses", "https://opencode.ai/zen/v1"],
      ["gemini-3.6-flash", "google-generative-ai", "https://opencode.ai/zen/v1"],
    ]) {
      expect(dynamicModel(id)).toMatchObject({ api, baseUrl });
    }
    expectSeedModels(manifest.modelCatalog.providers.opencode.models);
    for (const modelId of OFFLINE_MODEL_IDS) {
      expect(dynamicModel(modelId)).toMatchObject({ id: modelId });
    }
    expect(dynamicModel("unknown-offline-fixture")).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("exposes the offline seed through provider discovery without network access", async () => {
    const fetchMock = blockFetch();
    const { default: discovery } = await import("./provider-discovery.js");
    const result = await discovery.staticCatalog?.run({} as never);

    if (!result || !("provider" in result)) {
      throw new Error("expected OpenCode Zen static provider");
    }
    expectSeedModels(result.provider.models);
    expect(manifest.modelCatalog.discovery.opencode).toBe("runtime");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never downloads metadata when OpenCode has no configured credentials", async () => {
    vi.stubEnv("OPENCODE_API_KEY", undefined);
    vi.stubEnv("OPENCODE_ZEN_API_KEY", undefined);
    const fetchMock = blockFetch();
    const { prepareDynamicModel, catalog } = await registerFixture();

    await expect(
      catalog({
        resolveProviderApiKey: () => ({ apiKey: undefined }),
        resolveProviderAuth: noAuth,
      }),
    ).resolves.toBeNull();
    await expect(prepareDynamicModel("unconfigured-preview-fixture")).resolves.toBeUndefined();
    await expect(
      prepareDynamicModel("unconfigured-preview-fixture", {
        authProfileMode: "api_key",
        authProfileId: "anthropic:default",
      }),
    ).resolves.toBeUndefined();
    expectSeedModels((await buildOpencodeZenLiveProviderConfig()).models);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not resolve OpenCode credentials or download metadata for another provider scope", async () => {
    const fetchMock = blockFetch();
    const resolveProviderApiKey = vi.fn(
      (): { apiKey: string; discoveryApiKey: string | undefined } => ({
        apiKey: "configured-opencode-key",
        discoveryApiKey: "configured-opencode-key",
      }),
    );
    const { catalog } = await registerFixture();

    await expect(
      catalog({
        providerIds: ["anthropic"],
        resolveProviderApiKey,
      }),
    ).resolves.toBeNull();
    expect(resolveProviderApiKey).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();

    resolveProviderApiKey.mockReturnValueOnce({
      apiKey: NON_ENV_SECRETREF_MARKER,
      discoveryApiKey: undefined,
    });
    const ownScope = await catalog({
      providerIds: ["opencode"],
      resolveProviderApiKey,
    });
    expect(ownScope).toMatchObject({ provider: { apiKey: NON_ENV_SECRETREF_MARKER } });
    expect(resolveProviderApiKey).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("downloads upstream metadata only after an explicitly selected provider is configured", async () => {
    vi.stubEnv("OPENCODE_API_KEY", undefined);
    vi.stubEnv("OPENCODE_ZEN_API_KEY", undefined);
    const modelId = "configured-selection-fixture";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        Response.json(upstreamCatalog([{ id: modelId, npm: "@ai-sdk/anthropic" }])),
      );
    const { prepareDynamicModel } = await registerFixture();

    await expect(
      prepareDynamicModel(modelId, {
        config: { models: { providers: { opencode: { baseUrl: "https://opencode.ai/zen/v1" } } } },
      }),
    ).resolves.toMatchObject({
      id: modelId,
      api: "anthropic-messages",
      baseUrl: "https://opencode.ai/zen",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const request = fetchMock.mock.calls[0];
    expect(request?.[0]).toBe(METADATA_URL);
    expect(new Headers(request?.[1]?.headers).has("authorization")).toBe(false);
  });

  it.each([
    { authProvider: "opencode", apiKey: NON_ENV_SECRETREF_MARKER },
    { authProvider: "opencode-go", apiKey: NON_ENV_SECRETREF_MARKER },
    { authProvider: "opencode", apiKey: undefined },
  ])("keeps $authProvider catalog credentials and profile together ($apiKey)", async (fixture) => {
    const { catalog } = await registerFixture();
    const fetchMock = blockFetch();
    const liveCatalog = vi
      .spyOn(await import("./provider-catalog.js"), "buildOpencodeZenLiveProviderConfig")
      .mockImplementation(async (params = {}) => ({
        baseUrl: "https://opencode.ai/zen/v1",
        apiKey: params.apiKey,
        models: [],
      }));
    const auth = {
      apiKey: fixture.apiKey,
      discoveryApiKey: "selected-discovery-key",
      profileId: `${fixture.authProvider}:selected`,
      mode: "api_key" as const,
    };
    const resolveProviderApiKey = vi.fn((providerId?: string) => {
      if (providerId === fixture.authProvider) {
        return auth;
      }
      if (providerId === "opencode") {
        return { apiKey: undefined, profileId: "opencode:unconfigured" };
      }
      throw new Error("Unused sibling credentials must not be resolved");
    });

    await expect(
      catalog({
        resolveProviderApiKey,
        resolveProviderAuth: noAuth,
      }),
    ).resolves.toEqual({
      provider: {
        baseUrl: "https://opencode.ai/zen/v1",
        apiKey: auth.apiKey ?? auth.discoveryApiKey,
        models: [],
      },
      outcomes: [{ provider: "opencode", profileId: auth.profileId, status: "ready" }],
    });
    expect(liveCatalog).toHaveBeenCalledExactlyOnceWith({
      apiKey: auth.apiKey ?? auth.discoveryApiKey,
      discoveryApiKey: auth.discoveryApiKey,
    });
    expect(resolveProviderApiKey.mock.calls).toEqual(
      fixture.authProvider === "opencode" ? [["opencode"]] : [["opencode"], ["opencode-go"]],
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["opencode", "opencode-go"])(
    "propagates %s credential lookup failures without selecting another account",
    async (failedProvider) => {
      const { catalog } = await registerFixture();
      const failure = new Error("Selected account credentials are unavailable");
      const resolveProviderApiKey = vi.fn((providerId?: string) => {
        if (providerId === failedProvider) {
          throw failure;
        }
        return { apiKey: undefined };
      });

      await expect(
        catalog({
          resolveProviderApiKey,
          resolveProviderAuth: noAuth,
        }),
      ).rejects.toBe(failure);
      expect(resolveProviderApiKey.mock.calls).toEqual(
        failedProvider === "opencode" ? [["opencode"]] : [["opencode"], ["opencode-go"]],
      );
    },
  );

  it("discovers listed chat models with metadata enrichment or the native default route", async () => {
    const fetchGuard = createCatalogFetchGuard({
      metadata: [
        { id: "x-preview-f-free", name: "Ox Alpha Free", reasoningEfforts: ["low", "high", "max"] },
        { id: "fresh-claude-fixture", npm: "@ai-sdk/anthropic" },
        { id: "fresh-gemini-fixture", npm: "@ai-sdk/google" },
        { id: "fresh-gpt-fixture", npm: "@ai-sdk/openai" },
        { id: "retired-zen-fixture", status: "deprecated" },
      ],
      advertised: [
        "x-preview-f-free",
        "fresh-claude-fixture",
        "fresh-gemini-fixture",
        "fresh-gpt-fixture",
        "retired-zen-fixture",
        "listed-only-fixture",
        "listed-only-fixture-free",
        "test",
        "text-embedding-3-small",
      ],
    });
    const { dynamicModel } = await registerFixture();
    expect(dynamicModel("x-preview-f-free")).toBeUndefined();

    const first = await buildLiveCatalog(fetchGuard, "runtime-key", "discovery-key");
    const second = await buildLiveCatalog(fetchGuard, "other-runtime-key", "discovery-key");

    expect(fetchGuard.mock.calls.map(([request]) => request.url)).toEqual([
      METADATA_URL,
      MODELS_URL,
    ]);
    expect(first.models.map((model) => model.id)).toEqual([
      "x-preview-f-free",
      "fresh-claude-fixture",
      "fresh-gemini-fixture",
      "fresh-gpt-fixture",
      "listed-only-fixture",
      "listed-only-fixture-free",
      "test",
    ]);
    expect(second.apiKey).toBe("other-runtime-key");
    expect(second.models.map((model) => model.id)).toEqual(first.models.map((model) => model.id));
    expect(first.models.find((model) => model.id === "x-preview-f-free")).toMatchObject({
      name: "Ox Alpha Free",
      api: "openai-completions",
      input: ["text", "image"],
      contextWindow: 1_000_000,
      contextTokens: 900_000,
      maxTokens: 131_072,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { supportedReasoningEfforts: ["low", "high", "max"] },
    });
    for (const [id, api, baseUrl] of [
      ["fresh-claude-fixture", "anthropic-messages", "https://opencode.ai/zen"],
      ["fresh-gemini-fixture", "google-generative-ai", "https://opencode.ai/zen/v1"],
      ["fresh-gpt-fixture", "openai-responses", "https://opencode.ai/zen/v1"],
    ]) {
      expect(first.models.find((model) => model.id === id)).toMatchObject({ api, baseUrl });
    }
    for (const id of ["listed-only-fixture", "listed-only-fixture-free", "test"]) {
      expect(first.models.find((model) => model.id === id)).toMatchObject({
        api: "openai-completions",
        baseUrl: "https://opencode.ai/zen/v1",
        provider: "opencode",
      });
    }
    expect(dynamicModel("retired-zen-fixture")).toMatchObject({
      id: "retired-zen-fixture",
    });
    expect(dynamicModel("listed-only-fixture")).toBeUndefined();
  });

  it("evicts dynamic models removed or rejected by a refreshed authoritative catalog", async () => {
    const { dynamicModel } = await registerFixture();
    const modelId = "refreshed-model-fixture";
    const fetchGuard = createCatalogFetchGuard({
      metadata: [{ id: modelId }],
      advertised: [],
    });
    for (const [label, metadata] of [
      ["removed", []],
      ["unsupported", [{ id: modelId, npm: "@untrusted/unknown" }]],
    ] as const) {
      clearLiveCatalogCacheForTests();
      await prepareModel(modelId, fetchGuard);
      expect(dynamicModel(modelId), label).toMatchObject({ id: modelId });

      clearLiveCatalogCacheForTests();
      await prepareModel(modelId, createCatalogFetchGuard({ metadata, advertised: [] }));
      expect(dynamicModel(modelId), label).toBeUndefined();
    }
    expect(dynamicModel("minimax-m3")).toMatchObject({ id: "minimax-m3" });
  });

  it("shares upstream metadata while keeping advertised models scoped to discovery keys", async () => {
    const fetchGuard = createCatalogFetchGuard({
      metadata: [{ id: "account-a-fixture" }, { id: "account-b-fixture" }],
      advertised: (authorization) =>
        authorization === "Bearer discovery-a" ? ["account-a-fixture"] : ["account-b-fixture"],
    });
    const first = await buildLiveCatalog(fetchGuard, "runtime-a", "discovery-a");
    const second = await buildLiveCatalog(fetchGuard, "runtime-b", "discovery-b");

    expect(first.models.map((model) => model.id)).toEqual(["account-a-fixture"]);
    expect(second.models.map((model) => model.id)).toEqual(["account-b-fixture"]);
    expect(fetchGuard.mock.calls.map(([request]) => request.url)).toEqual([
      METADATA_URL,
      MODELS_URL,
      MODELS_URL,
    ]);
  });

  it("reports failed discovery instead of returning the offline seed", async () => {
    const fetchGuard = vi.fn(async () => {
      throw new Error("network unavailable");
    });
    await expect(buildLiveCatalog(fetchGuard, "runtime-key", "discovery-key")).rejects.toThrow(
      "network unavailable",
    );
  });

  it.each(["failed", "filtered"] as const)(
    "keeps refreshed metadata separate from %s model advertising",
    async (advertising) => {
      const retiredId = "big-pickle";
      const { dynamicModel } = await registerFixture();
      const fetchGuard = createCatalogFetchGuard({
        metadata: [{ id: retiredId, status: "deprecated" }],
        advertised: () => {
          if (advertising === "failed") {
            throw new Error("model advertising unavailable");
          }
          return [retiredId];
        },
      });

      try {
        expectSeedModels((await buildOpencodeZenLiveProviderConfig()).models);
        const discovery = buildLiveCatalog(fetchGuard, "runtime-key", "discovery-key");

        if (advertising === "failed") {
          await expect(discovery).rejects.toThrow("model advertising unavailable");
        } else {
          await expect(discovery).resolves.toMatchObject({ models: [] });
        }
        expect(dynamicModel(retiredId)).toMatchObject({
          id: retiredId,
        });
      } finally {
        clearLiveCatalogCacheForTests();
        await prepareModel(retiredId, createCatalogFetchGuard({ metadata: [], advertised: [] }));
        clearLiveCatalogCacheForTests();
      }
    },
  );

  it.each([
    [["claude-opus-5"], "opencode/claude-opus-5"],
    [["gpt-5.6-sol"], undefined],
  ])("selects only the advertised preferred onboarding model %#", async (modelIds, expected) => {
    const fetchGuard = createCatalogFetchGuard({ metadata: [], advertised: modelIds });

    await expect(
      resolveOpencodeZenStarterModel({
        apiKey: "resolved-opencode-key",
        preferredModelRef: "opencode/claude-opus-5",
        fetchGuard,
      }),
    ).resolves.toBe(expected);
  });

  it("canonicalizes stale OpenCode Zen base URLs", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const normalizedConfig = requireRecord(
      provider.normalizeConfig?.({
        provider: "opencode",
        providerConfig: {
          api: "openai-completions",
          baseUrl: "https://opencode.ai/zen/",
          models: [],
        },
      } as never),
      "normalized config",
    );
    expect(normalizedConfig.baseUrl).toBe("https://opencode.ai/zen/v1");

    const normalizedModel = requireRecord(
      provider.normalizeResolvedModel?.({
        provider: "opencode",
        model: {
          provider: "opencode",
          id: "claude-opus-5",
          api: "anthropic-messages",
          baseUrl: MODELS_URL.replace("/models", ""),
        },
      } as never),
      "normalized model",
    );
    expect(normalizedModel.baseUrl).toBe("https://opencode.ai/zen");
    expect(
      provider.normalizeTransport?.({
        provider: "opencode",
        api: "openai-completions",
        baseUrl: "https://opencode.ai/zen",
      } as never),
    ).toEqual({ api: "openai-completions", baseUrl: "https://opencode.ai/zen/v1" });
  });
});
