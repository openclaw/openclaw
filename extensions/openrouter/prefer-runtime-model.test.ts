import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import type * as ProviderStreamFamily from "openclaw/plugin-sdk/provider-stream-family";
import { describe, expect, it, vi } from "vitest";
import openrouterPlugin from "./index.js";

const loadedCapabilities = vi.hoisted(
  () =>
    new Map<
      string,
      { compat?: { supportedReasoningEfforts?: string[] }; thinkingLevelMap?: { off: null } }
    >(),
);

vi.mock("openclaw/plugin-sdk/provider-stream-family", async (importOriginal) => ({
  ...(await importOriginal<typeof ProviderStreamFamily>()),
  getLoadedOpenRouterModelCapabilities: (modelId: string) => loadedCapabilities.get(modelId),
}));

const opusCapabilities = {
  compat: { supportedReasoningEfforts: ["max", "xhigh", "high", "medium", "low"] },
  thinkingLevelMap: { off: null },
};

describe("OpenRouter configured model capability ownership", () => {
  it.each([
    {
      name: "canonical provider route",
      providerBaseUrl: "https://openrouter.ai/api/v1",
      modelBaseUrl: undefined,
      modelApi: undefined,
      preferred: true,
    },
    {
      name: "legacy endpoint before transport normalization",
      providerBaseUrl: "https://openrouter.ai/v1/",
      modelBaseUrl: undefined,
      modelApi: undefined,
      preferred: false,
    },
    {
      name: "normalized provider key",
      providerKey: "OpenRouter",
      providerBaseUrl: "https://openrouter.ai/api/v1",
      modelBaseUrl: undefined,
      modelApi: undefined,
      preferred: true,
    },
    {
      name: "custom provider endpoint",
      providerBaseUrl: "https://private.example.invalid/v1",
      modelBaseUrl: undefined,
      modelApi: undefined,
      preferred: false,
    },
    {
      name: "custom model endpoint",
      providerBaseUrl: "https://openrouter.ai/api/v1",
      modelBaseUrl: "https://private.example.invalid/v1",
      modelApi: undefined,
      preferred: false,
    },
    {
      name: "custom model API",
      providerBaseUrl: "https://openrouter.ai/api/v1",
      modelBaseUrl: undefined,
      modelApi: "openai-responses",
      preferred: false,
    },
  ])(
    "prefers provider-owned reasoning metadata only on the $name",
    async ({ providerKey, providerBaseUrl, modelBaseUrl, modelApi, preferred }) => {
      const provider = await registerSingleProviderPlugin(openrouterPlugin);
      const modelId = "anthropic/claude-opus-5.5";
      expect(
        provider.preferRuntimeResolvedModel?.({
          provider: "openrouter",
          modelId,
          config: {
            models: {
              providers: {
                [providerKey ?? "openrouter"]: {
                  baseUrl: providerBaseUrl,
                  models: [
                    {
                      id: modelId,
                      name: modelId,
                      ...(modelBaseUrl ? { baseUrl: modelBaseUrl } : {}),
                      ...(modelApi ? { api: modelApi } : {}),
                    },
                  ],
                },
              },
            },
          },
        } as never),
      ).toBe(preferred);
    },
  );

  it.each([
    {
      name: "canonical configured row",
      route: {},
      levels: ["low", "medium", "high", "xhigh", "max"],
    },
    {
      name: "row whose catalog capabilities are not loaded",
      modelId: "anthropic/claude-sonnet-5.5",
      route: {},
      levels: undefined,
    },
    {
      name: "custom route",
      route: { baseUrl: "https://private.example.invalid/v1" },
      levels: undefined,
    },
    {
      name: "declared route efforts",
      route: { compat: { supportedReasoningEfforts: ["low", "high"] } },
      levels: ["off", "low", "high"],
    },
  ])("resolves thinking levels for the $name", async ({ modelId, route, levels }) => {
    loadedCapabilities.clear();
    loadedCapabilities.set("anthropic/claude-opus-5.5", opusCapabilities);
    const provider = await registerSingleProviderPlugin(openrouterPlugin);
    const profile = provider.resolveThinkingProfile?.({
      provider: "openrouter",
      modelId: modelId ?? "anthropic/claude-opus-5.5",
      api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1",
      reasoning: true,
      ...route,
    });
    expect(profile?.levels.map((level) => level.id)).toEqual(levels);
  });

  it("follows the loaded catalog from a cold start through refreshes", async () => {
    loadedCapabilities.clear();
    const provider = await registerSingleProviderPlugin(openrouterPlugin);
    const resolveLevels = () =>
      provider
        .resolveThinkingProfile?.({
          provider: "openrouter",
          modelId: "anthropic/claude-opus-5.5",
          api: "openai-completions",
          baseUrl: "https://openrouter.ai/api/v1",
          reasoning: true,
        })
        ?.levels.map((level) => level.id);

    // A cold cache keeps the configured row's own profile.
    expect(resolveLevels()).toBeUndefined();
    loadedCapabilities.set("anthropic/claude-opus-5.5", opusCapabilities);
    expect(resolveLevels()).toEqual(["low", "medium", "high", "xhigh", "max"]);
    loadedCapabilities.set("anthropic/claude-opus-5.5", {
      ...opusCapabilities,
      compat: { supportedReasoningEfforts: ["high", "medium", "low"] },
    });
    expect(resolveLevels()).toEqual(["low", "medium", "high"]);
  });
});
