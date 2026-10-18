import type { ProviderDefaultThinkingPolicyContext } from "openclaw/plugin-sdk/plugin-entry";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import type * as ProviderStreamFamily from "openclaw/plugin-sdk/provider-stream-family";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import openrouterPlugin from "./index.js";

const loadedCapabilities = vi.hoisted(
  () =>
    new Map<
      string,
      {
        compat?: { supportedReasoningEfforts?: string[] };
        thinkingLevelMap?: { off: null };
      }
    >(),
);
vi.mock("openclaw/plugin-sdk/provider-stream-family", async (importOriginal) => ({
  ...(await importOriginal<typeof ProviderStreamFamily>()),
  getLoadedOpenRouterModelCapabilities: (modelId: string) => loadedCapabilities.get(modelId),
}));

const modelId = "anthropic/claude-opus-5.5";
const baseUrl = "https://openrouter.ai/api/v1";
const opusCapabilities = {
  compat: { supportedReasoningEfforts: ["max", "xhigh", "high", "medium", "low"] },
  thinkingLevelMap: { off: null },
};
let provider: Awaited<ReturnType<typeof registerSingleProviderPlugin>>;
beforeAll(async () => {
  provider = await registerSingleProviderPlugin(openrouterPlugin);
});
beforeEach(() => {
  loadedCapabilities.clear();
});

function resolveLevels(route: Partial<ProviderDefaultThinkingPolicyContext> = {}) {
  return provider
    .resolveThinkingProfile?.({
      provider: "openrouter",
      modelId,
      api: "openai-completions",
      baseUrl,
      reasoning: true,
      ...route,
    })
    ?.levels.map((level) => level.id);
}

describe("OpenRouter configured model capability ownership", () => {
  it.each([
    { name: "normalized provider key", providerBaseUrl: baseUrl, model: {}, preferred: true },
    {
      name: "legacy endpoint",
      providerBaseUrl: "https://openrouter.ai/v1/",
      model: {},
      preferred: false,
    },
    {
      name: "custom model endpoint",
      providerBaseUrl: baseUrl,
      model: { baseUrl: "https://private.example.invalid/v1" },
      preferred: false,
    },
    {
      name: "custom model API",
      providerBaseUrl: baseUrl,
      model: { api: "openai-responses" as const },
      preferred: false,
    },
  ])(
    "prefers provider-owned reasoning metadata only on the $name",
    ({ providerBaseUrl, model, preferred }) => {
      expect(
        provider.preferRuntimeResolvedModel?.({
          provider: "openrouter",
          modelId,
          config: {
            models: {
              providers: {
                OpenRouter: {
                  baseUrl: providerBaseUrl,
                  models: [
                    {
                      id: modelId,
                      name: modelId,
                      reasoning: true,
                      input: ["text"],
                      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                      contextWindow: 128000,
                      maxTokens: 8192,
                      ...model,
                    },
                  ],
                },
              },
            },
          },
        }),
      ).toBe(preferred);
    },
  );

  it.each([
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
  ])("resolves thinking levels for the $name", ({ route, levels }) => {
    loadedCapabilities.set(modelId, opusCapabilities);
    expect(resolveLevels(route)).toEqual(levels);
  });

  it("follows the loaded catalog from a cold start through refreshes", () => {
    expect(resolveLevels()).toBeUndefined();
    loadedCapabilities.set(modelId, opusCapabilities);
    expect(resolveLevels()).toEqual(["low", "medium", "high", "xhigh", "max"]);
    loadedCapabilities.set(modelId, {
      ...opusCapabilities,
      compat: { supportedReasoningEfforts: ["high", "medium", "low"] },
    });
    expect(resolveLevels()).toEqual(["low", "medium", "high"]);
  });
});
