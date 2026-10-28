import type { ProviderDefaultThinkingPolicyContext } from "openclaw/plugin-sdk/plugin-entry";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import type * as ProviderStreamFamily from "openclaw/plugin-sdk/provider-stream-family";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import openrouterPlugin from "./index.js";

type Capabilities = {
  compat?: { supportedReasoningEfforts?: string[] };
  thinkingLevelMap?: { off: null };
};
const loadedCapabilities = vi.hoisted(() => new Map<string, Capabilities>());
vi.mock("openclaw/plugin-sdk/provider-stream-family", async (importOriginal) => ({
  ...(await importOriginal<typeof ProviderStreamFamily>()),
  getLoadedOpenRouterModelCapabilities: (modelId: string) => loadedCapabilities.get(modelId),
}));

const modelId = "anthropic/claude-opus-5.5";
const baseUrl = "https://openrouter.ai/api/v1";
const configuredModel = {
  id: modelId,
  name: modelId,
  reasoning: true,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 8192,
};
const opusCapabilities = {
  compat: { supportedReasoningEfforts: ["max", "xhigh", "high", "medium", "low"] },
  thinkingLevelMap: { off: null },
};
let provider: Awaited<ReturnType<typeof registerSingleProviderPlugin>>;
beforeAll(async () => {
  provider = await registerSingleProviderPlugin(openrouterPlugin);
});
beforeEach(() => loadedCapabilities.clear());

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

it.each([
  ["normalized provider key", baseUrl, {}, true],
  ["legacy endpoint", "https://openrouter.ai/v1/", {}, false],
  ["custom model endpoint", baseUrl, { baseUrl: "https://private.example.invalid/v1" }, false],
  ["custom model API", baseUrl, { api: "openai-responses" as const }, false],
] as const)("prefers catalog metadata for %s", (_name, url, model, preferred) => {
  expect(
    provider.preferRuntimeResolvedModel?.({
      provider: "openrouter",
      modelId,
      config: {
        models: {
          providers: {
            OpenRouter: {
              baseUrl: url,
              models: [{ ...configuredModel, input: ["text"], ...model }],
            },
          },
        },
      },
    }),
  ).toBe(preferred);
});

it.each<[string, Partial<ProviderDefaultThinkingPolicyContext>, string[] | undefined]>([
  ["custom route", { baseUrl: "https://private.example.invalid/v1" }, undefined],
  [
    "declared route efforts",
    { compat: { supportedReasoningEfforts: ["low", "high"] } },
    ["off", "low", "high"],
  ],
])("resolves thinking levels for the %s", (_name, route, levels) => {
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
