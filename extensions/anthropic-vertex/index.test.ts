import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { hasAuthMock } = vi.hoisted(() => ({ hasAuthMock: vi.fn() }));

vi.mock("./region.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./region.js")>();
  return { ...actual, hasAnthropicVertexAvailableAuth: hasAuthMock };
});

import anthropicVertexPlugin from "./index.js";
import { buildAnthropicVertexProvider } from "./provider-catalog.js";

const opusThinking = { xhigh: "xhigh", max: "max" };
const fableThinking = { off: "low", minimal: "low", ...opusThinking };
const globalUrl = "https://aiplatform.googleapis.com";
const usUrl = "https://aiplatform.us.rep.googleapis.com";
const adcEnv = { ANTHROPIC_VERTEX_USE_GCP_METADATA: "true" };
const currentMetadata = {
  reasoning: true,
  input: ["text", "image"],
  contextWindow: 1_000_000,
  contextTokens: 1_000_000,
  maxTokens: 128_000,
} satisfies Partial<ProviderRuntimeModel>;

function staleModel(id: string, patch: Partial<ProviderRuntimeModel> = {}): ProviderRuntimeModel {
  return {
    id,
    name: id,
    api: "anthropic-messages",
    provider: "anthropic-vertex",
    baseUrl: globalUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
    contextWindow: 200_000,
    maxTokens: 8192,
    ...patch,
  };
}

describe("anthropic-vertex provider plugin", () => {
  let provider: Awaited<ReturnType<typeof registerSingleProviderPlugin>>;
  beforeEach(async () => {
    hasAuthMock.mockReturnValue(true);
    provider = await registerSingleProviderPlugin(anthropicVertexPlugin);
  });

  const normalize = (model: ProviderRuntimeModel) =>
    provider.normalizeResolvedModel?.({ provider: "anthropic-vertex", modelId: model.id, model });

  afterEach(() => vi.clearAllMocks());

  afterAll(() => {
    vi.doUnmock("./region.js");
    vi.resetModules();
  });

  it("resolves the ADC marker through the provider hook", () => {
    expect(provider.resolveConfigApiKey?.({ provider: "anthropic-vertex", env: adcEnv })).toBe(
      "gcp-vertex-credentials",
    );
  });

  it("returns raw discovery for the host to merge with explicit provider overrides", async () => {
    const configured = {
      baseUrl: "https://europe-west4-aiplatform.googleapis.com",
      headers: { "x-test-header": "1" },
    };
    const result = await provider.catalog?.run({
      config: { models: { providers: { "anthropic-vertex": configured } } },
      env: { ...adcEnv, GOOGLE_CLOUD_LOCATION: "us-east5" },
    } as never);

    if (!result || !("provider" in result)) {
      throw new Error("expected single provider catalog result");
    }
    expect(result.provider).toMatchObject({
      api: "anthropic-messages",
      apiKey: "gcp-vertex-credentials",
      baseUrl: "https://us-east5-aiplatform.googleapis.com",
    });
    expect(result.provider.headers).toBeUndefined();
    expect(
      result.provider.models.map(({ id, thinkingLevelMap }) => [id, thinkingLevelMap]),
    ).toEqual([
      ["claude-fable-5", fableThinking],
      ["claude-mythos-5", fableThinking],
      ["claude-opus-4-8", opusThinking],
      ["claude-opus-4-6", { xhigh: null, max: "max" }],
      ["claude-sonnet-4-6", { xhigh: null, max: "max" }],
    ]);
  });

  describe.each([
    ["global", globalUrl, [2, 10, 0.2, 2.5], [3, 15, 0.3, 3.75]],
    ["us", usUrl, [2.2, 11, 0.22, 2.75], [3.3, 16.5, 0.33, 4.125]],
  ] as const)("Sonnet 5 pricing for %s", (region, baseUrl, current, retired) => {
    const pricing = ([input, output, cacheRead, cacheWrite]: readonly [
      number,
      number,
      number,
      number,
    ]) => ({
      input,
      output,
      cacheRead,
      cacheWrite,
    });
    const cost = pricing(current);
    const nowMs = Date.UTC(2026, 8, 1);
    beforeEach(() => vi.useFakeTimers({ now: nowMs }));

    afterEach(() => vi.useRealTimers());

    it("publishes current pricing with or without the shipped nowMs argument", () => {
      const env = { GOOGLE_CLOUD_LOCATION: region };
      for (const params of [{ env }, { env, nowMs }]) {
        const catalog = buildAnthropicVertexProvider(params);
        expect(catalog.models.find((model) => model.id === "claude-sonnet-5")).toMatchObject({
          cost,
          contextWindow: 1_000_000,
          maxTokens: 128_000,
          thinkingLevelMap: opusThinking,
        });
      }
    });

    it("repairs missing or retired pricing and leaves current pricing unchanged", () => {
      const model = staleModel("claude-sonnet-5", {
        name: "Claude Sonnet 5",
        baseUrl,
        ...currentMetadata,
        thinkingLevelMap: opusThinking,
      });
      for (const staleCost of [undefined, pricing(retired)]) {
        expect(normalize(staleModel(model.id, { ...model, cost: staleCost }))?.cost).toEqual(cost);
      }
      expect(normalize({ ...model, cost })).toBeUndefined();
    });
  });

  it("registers the shared thinking policy with canonical alias support", () => {
    const profile = provider.resolveThinkingProfile?.({
      provider: "anthropic-vertex",
      modelId: "production-claude",
      params: { canonicalModelId: "claude-fable-5" },
    });
    expect(profile).toMatchObject({
      defaultLevel: "medium",
      preserveWhenCatalogReasoningFalse: true,
    });
    expect(profile?.levels.map((level) => level.id)).toContain("max");
  });

  const opusCost = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };
  it.each<[string, Partial<ProviderRuntimeModel>, Partial<ProviderRuntimeModel>]>([
    ["claude-fable-5", {}, { thinkingLevelMap: fableThinking }],
    ["claude-mythos-5", {}, { thinkingLevelMap: fableThinking }],
    ["claude-opus-5", { cost: opusCost }, { thinkingLevelMap: opusThinking }],
    [
      "production-claude",
      { params: { canonicalModelId: "claude-fable-5" }, thinkingLevelMap: { max: null } },
      { thinkingLevelMap: { ...fableThinking, max: null } },
    ],
    [
      "prod-opus",
      {
        baseUrl: usUrl,
        cost: opusCost,
        contextTokens: 200_000,
        maxTokens: 64_000,
        params: { canonicalModelId: "claude-opus-5" },
      },
      {
        thinkingLevelMap: opusThinking,
        cost: { input: 5.5, output: 27.5, cacheRead: 0.55, cacheWrite: 6.875 },
      },
    ],
  ])("restores %s metadata and authored levels", (id, overrides, expected) => {
    expect(normalize(staleModel(id, overrides))).toEqual(
      expect.objectContaining({ ...currentMetadata, ...expected }),
    );
  });

  it.each([true, false])("resolves synthetic auth only when ADC is available=%s", (available) => {
    hasAuthMock.mockReturnValue(available);
    const auth = provider.resolveSyntheticAuth?.({ provider: "anthropic-vertex" } as never);
    expect(auth).toEqual(
      available
        ? {
            apiKey: "gcp-vertex-credentials",
            source: "gcp-vertex-credentials (ADC)",
            mode: "api-key",
          }
        : undefined,
    );
  });
});
