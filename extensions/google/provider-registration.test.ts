import type { Model } from "openclaw/plugin-sdk/llm";
import { assert, describe, expect, it, vi } from "vitest";
import { buildGoogleStaticCatalogProvider } from "./provider-catalog.js";
import { buildGoogleProvider } from "./provider-registration.js";

const streamFns = vi.hoisted(() => ({ moduleLoads: 0, generativeAi: vi.fn(), vertex: vi.fn() }));

// mock-isolation: count lazy imports without SDK/state-worker initialization; real lifecycle is tested separately.
vi.mock("./transport-stream.js", () => {
  streamFns.moduleLoads++;
  return {
    createGoogleGenerativeAiTransportStreamFn: () => streamFns.generativeAi,
    createGoogleVertexTransportStreamFn: () => streamFns.vertex,
  };
});

function model(overrides: Partial<Model> = {}): Model {
  return {
    id: "gemini-2.5-flash",
    name: "Gemini 2.5 Flash",
    provider: "google-vertex",
    api: "google-generative-ai",
    baseUrl: "https://aiplatform.googleapis.com",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_048_576,
    maxTokens: 65_536,
    ...overrides,
  } as Model;
}

const provider = buildGoogleProvider();
function createStream(overrides: Partial<Model> = {}) {
  return provider.createStreamFn?.({
    provider: "google-vertex",
    modelId: "gemini-2.5-flash",
    model: model(overrides),
  } as never);
}
function normalizeVideo(overrides: Partial<Model>) {
  const entry = model({
    provider: "google",
    input: ["text", "image", "video"] as never,
    ...overrides,
  });
  return provider.normalizeResolvedModel?.({
    provider: entry.provider,
    modelId: entry.id,
    model: entry,
  } as never);
}

describe("buildGoogleProvider createStreamFn", () => {
  it("keeps transport unloaded through registration and selection until the first stream", async () => {
    const vertex = createStream();
    const generativeAi = createStream({
      provider: "google",
      baseUrl: "https://generativelanguage.googleapis.com",
    });
    expect(
      createStream({
        api: "openai-completions",
        baseUrl:
          "https://aiplatform.googleapis.com/v1/projects/test/locations/us-central1/endpoints/openapi",
      }),
    ).toBeUndefined();
    expect.soft(streamFns.moduleLoads).toBe(0);
    assert(vertex && generativeAi, "Google registration must select both transports");
    const requestModel = model();
    const context = { messages: [] };
    await vertex(requestModel, context);
    expect(streamFns.generativeAi).not.toHaveBeenCalled();
    await generativeAi(requestModel, context);
    expect(streamFns.moduleLoads).toBe(1);
    expect(streamFns.vertex).toHaveBeenCalledExactlyOnceWith(requestModel, context);
    expect(streamFns.generativeAi).toHaveBeenCalledExactlyOnceWith(requestModel, context);
  });

  it.each(
    (
      [
        ["gemini-2.5-flash", "https://generativelanguage.googleapis.com", true],
        ["google/gemini-3.1-pro-preview", "https://generativelanguage.googleapis.com/v1beta", true],
        ["models/gemini-2.5-pro", "https://generativelanguage.googleapis.com/v1beta/", true],
        ["gemma-4-26b-a4b-it", "https://generativelanguage.googleapis.com/v1beta", false],
        ["gemini-2.5-flash-image", "https://generativelanguage.googleapis.com/v1beta", false],
        ["gemini-2.5-flash", "https://proxy.example.test/v1beta", false],
        ["gemini-2.5-flash", "https://user@generativelanguage.googleapis.com/v1beta", false],
        ["gemini-2.5-flash", "https://generativelanguage.googleapis.com/v1beta?key=x", false],
        ["gemini-2.5-flash", "https://generativelanguage.googleapis.com:8443/v1beta", false],
        ["gemini-2.5-flash", "https://generativelanguage.googleapis.com/v1beta/openai", false],
      ] satisfies Array<[string, string, boolean]>
    ).flatMap(([modelId, baseUrl, expected]) =>
      ["google-generative-ai", "google-interactions"].map((api) => ({
        modelId,
        baseUrl,
        expected,
        api,
      })),
    ),
  )(
    "normalizes native-video input for exact AI Studio route $modelId ($api)",
    ({ modelId, baseUrl, expected, api }) => {
      const normalized = normalizeVideo({ id: modelId, baseUrl, api });

      expect(((normalized?.input ?? []) as string[]).includes("video")).toBe(expected);
    },
  );

  it.each([
    ["google-vertex", "google-vertex"],
    ["custom-google", "google-generative-ai"],
  ] as const)("strips inherited video for %s routes", (providerId, api) => {
    const normalized = normalizeVideo({ provider: providerId, api });
    expect(normalized?.input).toEqual(["text", "image"]);
  });

  it("does not resolve AI Studio credentials for Vertex-only catalog scope", async () => {
    const resolveProviderApiKey = vi.fn();

    await expect(
      provider.catalog?.run({
        providerIds: ["google-vertex"],
        config: {},
        env: {},
        resolveProviderApiKey,
        resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
      }),
    ).resolves.toBeNull();
    expect(resolveProviderApiKey).not.toHaveBeenCalled();
  });
});

describe("Google catalog transport defaults", () => {
  const catalog = buildGoogleStaticCatalogProvider();
  const flash = catalog.models.find((entry) => entry.id === "gemini-3.8-flash");
  assert(flash, "Google catalog must publish Flash");
  const catalogModel = model({ ...flash, provider: "google", input: ["text", "image"] });
  const apis = ["google-generative-ai", "google-interactions"] as const;
  const endpoints = [
    "https://generativelanguage.googleapis.com/v1beta",
    "https://proxy.example.test/v1beta",
  ] as const;

  it.each(
    endpoints.flatMap((baseUrl) => [
      { baseUrl, scope: "default", api: undefined },
      { baseUrl, scope: "model-endpoint", api: undefined },
      ...apis.flatMap((api) =>
        ["provider", "model"]
          // Catalog routes admit a provider-wide API that matches the catalog row;
          // AI Studio selects Interactions per model (or by the Gemini default).
          .filter(
            (scope) =>
              !(scope === "provider" && api === "google-interactions" && baseUrl === endpoints[0]),
          )
          .map((scope) => ({ baseUrl, scope, api })),
      ),
    ]),
  )("resolves $scope API $api on $baseUrl from the catalog", ({ baseUrl, scope, api }) => {
    const providerConfig = {
      baseUrl:
        scope === "model-endpoint"
          ? baseUrl === endpoints[0]
            ? endpoints[1]
            : endpoints[0]
          : baseUrl,
      ...(scope === "provider"
        ? { api }
        : scope === "model"
          ? { api: apis.find((candidate) => candidate !== api) }
          : {}),
      models:
        scope === "model" || scope === "model-endpoint"
          ? [{ ...flash, api, baseUrl, id: "gemini-3.8-flash" }]
          : [],
    };
    // Core overrides already applied the effective endpoint; the catalog row
    // carries no API, so the provider hook alone decides the transport.
    const resolved = provider.normalizeResolvedModel?.({
      provider: "google",
      modelId: catalogModel.id,
      model: { ...catalogModel, baseUrl },
      config: { models: { providers: { google: providerConfig } } },
    });
    expect(resolved).toMatchObject({
      id: catalogModel.id,
      baseUrl,
      api: api ?? (baseUrl === endpoints[0] ? "google-interactions" : "google-generative-ai"),
    });
  });

  it.each([
    ["gemini-4-argon", "google-interactions"],
    ["gemini-3.1-pro-preview", "google-interactions"],
    ["gemma-4-26b-a4b-it", "google-generative-ai"],
  ] as const)("defaults %s on AI Studio to %s", (modelId, api) => {
    const resolved = provider.normalizeResolvedModel?.({
      provider: "google",
      modelId,
      model: { ...catalogModel, id: modelId, baseUrl: endpoints[0] },
      config: {},
    });
    expect(resolved?.api).toBe(api);
  });
});
