import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { hasAnthropicVertexAvailableAuthMock } = vi.hoisted(() => ({
  hasAnthropicVertexAvailableAuthMock: vi.fn(),
}));

vi.mock("./region.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./region.js")>();
  return {
    ...actual,
    hasAnthropicVertexAvailableAuth: hasAnthropicVertexAvailableAuthMock,
  };
});

import anthropicVertexPlugin from "./index.js";
import { buildAnthropicVertexProvider } from "./provider-catalog.js";

function staleModel(
  id: string,
  overrides: Partial<ProviderRuntimeModel> = {},
): ProviderRuntimeModel {
  return {
    id,
    name: id,
    api: "anthropic-messages",
    provider: "anthropic-vertex",
    baseUrl: "https://aiplatform.googleapis.com",
    reasoning: false,
    input: ["text"],
    cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
    contextWindow: 200_000,
    maxTokens: 8192,
    ...overrides,
  };
}

describe("anthropic-vertex provider plugin", () => {
  beforeEach(() => {
    hasAnthropicVertexAvailableAuthMock.mockReturnValue(true);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  afterAll(() => {
    vi.doUnmock("./region.js");
    vi.resetModules();
  });

  it("resolves the ADC marker through the provider hook", async () => {
    const provider = await registerSingleProviderPlugin(anthropicVertexPlugin);

    expect(
      provider.resolveConfigApiKey?.({
        provider: "anthropic-vertex",
        env: {
          ANTHROPIC_VERTEX_USE_GCP_METADATA: "true",
        } as NodeJS.ProcessEnv,
      } as never),
    ).toBe("gcp-vertex-credentials");
  });

  it("returns raw discovery for the host to merge with explicit provider overrides", async () => {
    const provider = await registerSingleProviderPlugin(anthropicVertexPlugin);

    const result = await provider.catalog?.run({
      config: {
        models: {
          providers: {
            "anthropic-vertex": {
              baseUrl: "https://europe-west4-aiplatform.googleapis.com",
              headers: { "x-test-header": "1" },
            },
          },
        },
      },
      env: {
        ANTHROPIC_VERTEX_USE_GCP_METADATA: "true",
        GOOGLE_CLOUD_LOCATION: "us-east5",
      } as NodeJS.ProcessEnv,
      resolveProviderApiKey: () => ({ apiKey: undefined }),
      resolveProviderAuth: () => ({
        apiKey: undefined,
        discoveryApiKey: undefined,
        mode: "none",
        source: "none",
      }),
    } as never);

    if (!result || !("provider" in result)) {
      throw new Error("expected single provider catalog result");
    }
    expect(result.provider.api).toBe("anthropic-messages");
    expect(result.provider.apiKey).toBe("gcp-vertex-credentials");
    expect(result.provider.baseUrl).toBe("https://us-east5-aiplatform.googleapis.com");
    expect(result.provider.headers).toBeUndefined();
    expect(
      result.provider.models.map(({ id, thinkingLevelMap }) => [id, thinkingLevelMap]),
    ).toEqual([
      ["claude-fable-5", { off: "low", minimal: "low", xhigh: "xhigh", max: "max" }],
      ["claude-mythos-5", { off: "low", minimal: "low", xhigh: "xhigh", max: "max" }],
      ["claude-opus-4-8", { xhigh: "xhigh", max: "max" }],
      ["claude-opus-4-6", { xhigh: null, max: "max" }],
      ["claude-sonnet-4-6", { xhigh: null, max: "max" }],
    ]);
  });

  it.each([
    { region: "global", baseUrl: "https://aiplatform.googleapis.com" },
    { region: "us", baseUrl: "https://aiplatform.us.rep.googleapis.com" },
    { region: "eu", baseUrl: "https://aiplatform.eu.rep.googleapis.com" },
  ])("publishes the SDK endpoint for the $region location", ({ region, baseUrl }) => {
    expect(
      buildAnthropicVertexProvider({
        env: { GOOGLE_CLOUD_LOCATION: region },
      }).baseUrl,
    ).toBe(baseUrl);
  });

  it.each([
    {
      region: "global",
      cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    },
    {
      region: "us",
      cost: { input: 5.5, output: 27.5, cacheRead: 0.55, cacheWrite: 6.875 },
    },
  ])("uses the documented Opus 5 pricing for $region", ({ region, cost }) => {
    const provider = buildAnthropicVertexProvider({
      env: { GOOGLE_CLOUD_LOCATION: region },
    });

    expect(provider.models.find((model) => model.id === "claude-opus-5")).toMatchObject({
      cost,
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      thinkingLevelMap: { xhigh: "xhigh", max: "max" },
    });
  });

  describe.each([
    {
      region: "global",
      baseUrl: "https://aiplatform.googleapis.com",
      cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
      retiredCost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    },
    {
      region: "us",
      baseUrl: "https://aiplatform.us.rep.googleapis.com",
      cost: { input: 2.2, output: 11, cacheRead: 0.22, cacheWrite: 2.75 },
      retiredCost: { input: 3.3, output: 16.5, cacheRead: 0.33, cacheWrite: 4.125 },
    },
  ])("Sonnet 5 pricing for $region", ({ region, baseUrl, cost, retiredCost }) => {
    const nowMs = Date.UTC(2026, 8, 1);
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(nowMs);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("publishes current pricing with or without the shipped nowMs argument", () => {
      const env = { GOOGLE_CLOUD_LOCATION: region };
      const providers = [
        buildAnthropicVertexProvider({ env }),
        buildAnthropicVertexProvider({ env, nowMs }),
      ];
      for (const provider of providers) {
        expect(provider.models.find((model) => model.id === "claude-sonnet-5")).toMatchObject({
          cost,
          contextWindow: 1_000_000,
          maxTokens: 128_000,
          thinkingLevelMap: { xhigh: "xhigh", max: "max" },
        });
      }
    });

    it("repairs missing or retired pricing and leaves current pricing unchanged", async () => {
      const provider = await registerSingleProviderPlugin(anthropicVertexPlugin);
      const model = {
        id: "claude-sonnet-5",
        name: "Claude Sonnet 5",
        api: "anthropic-messages",
        provider: "anthropic-vertex",
        baseUrl,
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 1_000_000,
        contextTokens: 1_000_000,
        maxTokens: 128_000,
        thinkingLevelMap: { xhigh: "xhigh", max: "max" },
      };
      for (const staleCost of [undefined, retiredCost]) {
        const normalized = provider.normalizeResolvedModel?.({
          provider: "anthropic-vertex",
          modelId: model.id,
          model: { ...model, cost: staleCost },
        } as never);
        expect(normalized?.cost).toEqual(cost);
      }
      expect(
        provider.normalizeResolvedModel?.({
          provider: "anthropic-vertex",
          modelId: model.id,
          model: { ...model, cost },
        } as never),
      ).toBeUndefined();
    });
  });

  it.each([
    ["claude-sonnet-4-6", false],
    ["claude-fable-5-1@20260801", true],
  ])(
    "owns Anthropic-style replay policy for Vertex %s",
    async (modelId, appendOnlyRuntimeContext) => {
      const provider = await registerSingleProviderPlugin(anthropicVertexPlugin);

      expect(
        provider.buildReplayPolicy?.({
          provider: "anthropic-vertex",
          modelApi: "anthropic-messages",
          modelId,
        }),
      ).toEqual({
        sanitizeMode: "full",
        sanitizeToolCallIds: true,
        toolCallIdMode: "strict",
        preserveNativeAnthropicToolUseIds: true,
        appendOnlyRuntimeContext,
        preserveSignatures: true,
        repairToolUseResultPairing: true,
        validateAnthropicTurns: true,
        allowSyntheticToolResults: true,
      });
      expect(
        provider.buildReplayPolicy?.({
          provider: "anthropic-vertex",
          modelApi: "anthropic-messages",
          modelId: "claude-fable-5",
        } as never),
      ).not.toHaveProperty("dropThinkingBlocks");
    },
  );

  it("registers the shared thinking policy with canonical alias support", async () => {
    const provider = await registerSingleProviderPlugin(anthropicVertexPlugin);
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

  it.each([
    {
      id: "claude-fable-5",
      thinkingLevelMap: { off: "low", minimal: "low", xhigh: "xhigh", max: "max" },
    },
    {
      id: "claude-mythos-5",
      thinkingLevelMap: { off: "low", minimal: "low", xhigh: "xhigh", max: "max" },
    },
    {
      id: "claude-opus-5",
      thinkingLevelMap: { xhigh: "xhigh", max: "max" },
      overrides: { cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } },
    },
    {
      id: "production-claude",
      overrides: {
        params: { canonicalModelId: "claude-fable-5" },
        thinkingLevelMap: { max: null },
      },
      thinkingLevelMap: { off: "low", minimal: "low", xhigh: "xhigh", max: null },
    },
    {
      id: "prod-opus",
      overrides: {
        baseUrl: "https://aiplatform.us.rep.googleapis.com",
        cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
        contextTokens: 200_000,
        maxTokens: 64_000,
        params: { canonicalModelId: "claude-opus-5" },
      },
      cost: { input: 5.5, output: 27.5, cacheRead: 0.55, cacheWrite: 6.875 },
      thinkingLevelMap: { xhigh: "xhigh", max: "max" },
    },
  ])(
    "restores metadata for $id without overriding authored thinking levels",
    async ({ id, overrides, thinkingLevelMap, cost }) => {
      const provider = await registerSingleProviderPlugin(anthropicVertexPlugin);
      const normalized = provider.normalizeResolvedModel?.({
        provider: "anthropic-vertex",
        modelId: id,
        model: staleModel(id, overrides),
      });
      expect(normalized).toMatchObject({
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 1_000_000,
        contextTokens: 1_000_000,
        maxTokens: 128_000,
        ...(cost ? { cost } : {}),
      });
      // Exact maps also guard Opus's absence of mandatory off/minimal remapping.
      expect(normalized?.thinkingLevelMap).toEqual(thinkingLevelMap);
    },
  );

  it.each([
    {
      available: true,
      expected: {
        apiKey: "gcp-vertex-credentials",
        source: "gcp-vertex-credentials (ADC)",
        mode: "api-key",
      },
    },
    { available: false, expected: undefined },
  ])(
    "resolves synthetic auth only when ADC is available=$available",
    async ({ available, expected }) => {
      hasAnthropicVertexAvailableAuthMock.mockReturnValue(available);
      const provider = await registerSingleProviderPlugin(anthropicVertexPlugin);
      expect(
        provider.resolveSyntheticAuth?.({
          provider: "anthropic-vertex",
          config: undefined,
          providerConfig: undefined,
        } as never),
      ).toEqual(expected);
    },
  );
});
