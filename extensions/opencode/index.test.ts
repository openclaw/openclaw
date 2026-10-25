import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { NON_ENV_SECRETREF_MARKER } from "openclaw/plugin-sdk/provider-auth-runtime";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { expectPassthroughReplayPolicy } from "openclaw/plugin-sdk/provider-test-contracts";
import * as ssrfRuntime from "openclaw/plugin-sdk/ssrf-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import {
  buildOpencodeZenLiveProviderConfig,
  prepareOpencodeZenModel,
  resolveOpencodeZenStarterModel,
} from "./provider-catalog.js";

const METADATA_URL = "https://models.opencode.ai/api.json";
const MODELS_URL = "https://opencode.ai/zen/v1/models";
const OPENAI_URL = "https://opencode.ai/zen/v1";
const ANTHROPIC_URL = "https://opencode.ai/zen";
type Provider = Awaited<ReturnType<typeof registerSingleProviderPlugin>>;
type CatalogContext = Parameters<NonNullable<Provider["catalog"]>["run"]>[0];
const denyFetch = () =>
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected fetch"));
const discover = (
  fetchGuard: NonNullable<Parameters<typeof buildOpencodeZenLiveProviderConfig>[0]>["fetchGuard"],
  apiKey = "runtime-key",
  discoveryApiKey = "discovery-key",
) => buildOpencodeZenLiveProviderConfig({ apiKey, discoveryApiKey, fetchGuard });
const catalogContext = (
  resolveProviderApiKey: CatalogContext["resolveProviderApiKey"],
): CatalogContext => ({
  config: {},
  env: {},
  resolveProviderApiKey,
  resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
});
const prepareDynamic = (provider: Provider, overrides: Record<string, unknown> = {}) =>
  provider.prepareDynamicModel?.({
    config: {},
    provider: "opencode",
    modelId: "unconfigured-preview-fixture",
    modelRegistry: {},
    ...overrides,
  } as never);
function prepareModel(modelId: string, fetchGuard: typeof ssrfRuntime.fetchWithSsrFGuard) {
  vi.spyOn(ssrfRuntime, "fetchWithSsrFGuard").mockImplementation(fetchGuard);
  return prepareOpencodeZenModel({ modelId });
}
type UpstreamFixtureModel = {
  id: string;
  npm?: string;
  status?: string;
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
            limit: { context: 128_000, output: 8192 },
            ...(model.npm ? { provider: { npm: model.npm } } : {}),
            ...(model.status ? { status: model.status } : {}),
          },
        ]),
      ),
    },
  };
}

function guardedResponse(url: string, body: unknown) {
  return {
    response: new Response(JSON.stringify(body)),
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

function expectDefaultModel(models: ReadonlyArray<{ id: string }>) {
  expect(models).toContainEqual(expect.objectContaining({ id: "claude-opus-5" }));
}

describe("opencode provider plugin", () => {
  let provider: Provider;
  const resolve = (modelId: string) => provider.resolveDynamicModel?.({ modelId } as never);
  const runCatalog = (
    resolveKey: CatalogContext["resolveProviderApiKey"],
    providerIds?: string[],
  ) => provider.catalog?.run({ ...catalogContext(resolveKey), providerIds });
  beforeEach(async () => {
    clearLiveCatalogCacheForTests();
    provider = await registerSingleProviderPlugin(plugin);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("classifies client-restricted free models without cooling down valid credentials", async () => {
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
    const fetchMock = denyFetch();
    const result = await provider.staticCatalog?.run({} as never);
    if (!result || !("provider" in result)) {
      throw new Error("expected registered OpenCode Zen static provider");
    }
    expectDefaultModel(result.provider.models);
    for (const [id, api, baseUrl] of [
      ["claude-opus-5", "anthropic-messages", ANTHROPIC_URL],
      ["gpt-5.6-sol", "openai-responses", OPENAI_URL],
      ["gemini-3.6-flash", "google-generative-ai", OPENAI_URL],
    ]) {
      expect(resolve(id)).toMatchObject({ api, baseUrl });
    }
    expect(
      provider.normalizeResolvedModel?.({
        model: { ...resolve("claude-opus-5"), baseUrl: OPENAI_URL },
      } as never),
    ).toMatchObject({ baseUrl: ANTHROPIC_URL });
    expect(resolve("unknown-offline-fixture")).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("exposes the offline seed through provider discovery without network access", async () => {
    const fetchMock = denyFetch();
    const { default: discovery } = await import("./provider-discovery.js");
    const result = await discovery.staticCatalog?.run({} as never);
    if (!result || !("provider" in result)) {
      throw new Error("expected OpenCode Zen static provider");
    }
    expectDefaultModel(result.provider.models);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never downloads metadata when OpenCode has no configured credentials", async () => {
    vi.stubEnv("OPENCODE_API_KEY", undefined);
    vi.stubEnv("OPENCODE_ZEN_API_KEY", undefined);
    const fetchMock = denyFetch();

    await expect(runCatalog(() => ({ apiKey: undefined }))).resolves.toBeNull();
    await expect(prepareDynamic(provider)).resolves.toBeUndefined();
    await expect(
      prepareDynamic(provider, {
        authProfileMode: "api_key",
        authProfileId: "anthropic:default",
      }),
    ).resolves.toBeUndefined();
    expectDefaultModel((await buildOpencodeZenLiveProviderConfig()).models);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not resolve OpenCode credentials or download metadata for another provider scope", async () => {
    const fetchMock = denyFetch();
    const resolveProviderApiKey = vi.fn(
      (): { apiKey: string; discoveryApiKey: string | undefined } => ({
        apiKey: "configured-opencode-key",
        discoveryApiKey: "configured-opencode-key",
      }),
    );

    await expect(runCatalog(resolveProviderApiKey, ["anthropic"])).resolves.toBeNull();
    expect(resolveProviderApiKey).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();

    resolveProviderApiKey.mockReturnValueOnce({
      apiKey: NON_ENV_SECRETREF_MARKER,
      discoveryApiKey: undefined,
    });
    const ownScope = await runCatalog(resolveProviderApiKey, ["opencode"]);
    expect(ownScope).toMatchObject({ provider: { apiKey: NON_ENV_SECRETREF_MARKER } });
    expect(resolveProviderApiKey).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("downloads upstream metadata only after an explicitly selected provider is configured", async () => {
    vi.stubEnv("OPENCODE_API_KEY", undefined);
    vi.stubEnv("OPENCODE_ZEN_API_KEY", undefined);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        Response.json(
          upstreamCatalog([{ id: "configured-selection-fixture", npm: "@ai-sdk/anthropic" }]),
        ),
      );

    await expect(
      prepareDynamic(provider, {
        config: { models: { providers: { opencode: { baseUrl: "https://opencode.ai/zen/v1" } } } },
        modelId: "configured-selection-fixture",
      }),
    ).resolves.toMatchObject({
      id: "configured-selection-fixture",
      api: "anthropic-messages",
      baseUrl: "https://opencode.ai/zen",
    });
    const request = fetchMock.mock.calls[0];
    expect(request?.[0]).toBe(METADATA_URL);
    expect(new Headers(request?.[1]?.headers).has("authorization")).toBe(false);
  });

  it.each([
    ["opencode", NON_ENV_SECRETREF_MARKER, false],
    ["opencode-go", NON_ENV_SECRETREF_MARKER, false],
    ["opencode", undefined, false],
    ["opencode", undefined, true],
    ["opencode-go", undefined, true],
  ] as const)(
    "preserves %s account selection (%s, lookup failure: %s)",
    async (authProvider, apiKey, fails) => {
      const auth = {
        apiKey,
        discoveryApiKey: "selected-discovery-key",
        profileId: `${authProvider}:selected`,
      };
      const failure = new Error("Selected account credentials are unavailable");
      const resolveProviderApiKey = vi.fn((providerId?: string) => {
        if (providerId === authProvider) {
          if (fails) {
            throw failure;
          }
          return auth;
        }
        if (providerId === "opencode") {
          return { apiKey: undefined };
        }
        throw new Error("Unused sibling credentials must not be resolved");
      });
      if (fails) {
        await expect(runCatalog(resolveProviderApiKey)).rejects.toBe(failure);
        return;
      }
      const fetchMock = denyFetch();
      const liveCatalog = vi
        .spyOn(await import("./provider-catalog.js"), "buildOpencodeZenLiveProviderConfig")
        .mockImplementation(async (params = {}) => ({
          baseUrl: OPENAI_URL,
          apiKey: params.apiKey,
          models: [],
        }));
      await expect(runCatalog(resolveProviderApiKey)).resolves.toMatchObject({
        provider: { apiKey: auth.apiKey ?? auth.discoveryApiKey },
        outcomes: [{ provider: "opencode", profileId: auth.profileId, status: "ready" }],
      });
      expect(liveCatalog).toHaveBeenCalledExactlyOnceWith({
        apiKey: auth.apiKey ?? auth.discoveryApiKey,
        discoveryApiKey: auth.discoveryApiKey,
      });
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("discovers listed chat models with metadata enrichment or the native default route", async () => {
    const fetchGuard = createCatalogFetchGuard({
      metadata: [
        { id: "x-preview-f-free" },
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
        "text-embedding-3-small",
      ],
    });
    expect(resolve("x-preview-f-free")).toBeUndefined();

    const first = await discover(fetchGuard);
    expect(first.models).toHaveLength(5);
    for (const [id, api, baseUrl] of [
      ["x-preview-f-free", "openai-completions", OPENAI_URL],
      ["fresh-claude-fixture", "anthropic-messages", ANTHROPIC_URL],
      ["fresh-gemini-fixture", "google-generative-ai", OPENAI_URL],
      ["fresh-gpt-fixture", "openai-responses", OPENAI_URL],
    ]) {
      expect(first.models.find((model) => model.id === id)).toMatchObject({ api, baseUrl });
    }
    expect(first.models.find((model) => model.id === "listed-only-fixture")).toMatchObject({
      api: "openai-completions",
      baseUrl: "https://opencode.ai/zen/v1",
      provider: "opencode",
    });
    expect(resolve("retired-zen-fixture")).toMatchObject({
      id: "retired-zen-fixture",
    });
    expect(resolve("listed-only-fixture")).toBeUndefined();
  });

  it.each([undefined, "@untrusted/unknown"])(
    "evicts models absent or unsupported after refresh (%s)",
    async (npm) => {
      const id = "refreshed";
      await prepareModel(id, createCatalogFetchGuard({ metadata: [{ id }], advertised: [] }));
      expect(resolve(id)).toMatchObject({ id });
      clearLiveCatalogCacheForTests();
      await prepareModel(
        id,
        createCatalogFetchGuard({
          metadata: npm ? [{ id, npm }] : [],
          advertised: [],
        }),
      );
      expect(resolve(id)).toBeUndefined();
      expect(resolve("minimax-m3")).toMatchObject({ id: "minimax-m3" });
    },
  );

  it("shares upstream metadata while keeping advertised models scoped to discovery keys", async () => {
    const fetchGuard = createCatalogFetchGuard({
      metadata: [{ id: "account-a-fixture" }, { id: "account-b-fixture" }],
      advertised: (authorization) =>
        authorization === "Bearer discovery-a" ? ["account-a-fixture"] : ["account-b-fixture"],
    });
    const first = await discover(fetchGuard, "runtime-a", "discovery-a");
    const second = await discover(fetchGuard, "runtime-b", "discovery-b");

    expect(first.models.map((model) => model.id)).toEqual(["account-a-fixture"]);
    expect(second.models.map((model) => model.id)).toEqual(["account-b-fixture"]);
  });

  it.each(["metadata-failed", "failed", "filtered"] as const)(
    "keeps refreshed metadata separate from %s model advertising",
    async (advertising) => {
      const retiredId = "big-pickle";
      const fetchGuard = createCatalogFetchGuard({
        metadata: [{ id: retiredId, status: "deprecated" }],
        advertised: () => {
          if (advertising !== "filtered") {
            throw new Error("model advertising unavailable");
          }
          return [retiredId];
        },
      });
      if (advertising === "metadata-failed") {
        fetchGuard.mockRejectedValueOnce(new Error("model advertising unavailable"));
      }

      try {
        expectDefaultModel((await buildOpencodeZenLiveProviderConfig()).models);
        const discovery = discover(fetchGuard);

        if (advertising !== "filtered") {
          await expect(discovery).rejects.toThrow("model advertising unavailable");
        } else {
          await expect(discovery).resolves.toMatchObject({ models: [] });
        }
        expect(resolve(retiredId)).toMatchObject({ id: retiredId });
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
    const fetchGuard = vi.fn(async () =>
      guardedResponse(MODELS_URL, {
        data: modelIds.map((id) => ({ id, object: "model" })),
      }),
    );

    await expect(
      resolveOpencodeZenStarterModel({
        apiKey: "resolved-opencode-key",
        preferredModelRef: "opencode/claude-opus-5",
        fetchGuard,
      }),
    ).resolves.toBe(expected);
  });
});
