import { describe, expect, it } from "vitest";
import {
  OPENAI_PROVIDER_MODERN_MODEL_IDS,
  isOpenAIDualRouteModelId,
  isOpenAIPlatformOnlyRouteModelId,
  isOpenAISubscriptionOnlyRouteModelId,
  normalizeOpenAIModelRouteId,
} from "./model-route-contract.js";
import { buildOpenAIProvider } from "./openai-provider.js";
import { resolveModelRoutes } from "./provider-policy-api.js";

const platformRoute = { api: "openai-completions", authRequirement: "api-key" };
const subscriptionRoute = { api: "openai-chatgpt-responses", authRequirement: "subscription" };
const completions = { api: "openai-completions" } as const;
function resolveBilling(overrides: Partial<Parameters<typeof resolveModelRoutes>[0]>) {
  return resolveModelRoutes({
    provider: "openai",
    modelId: "gpt-5.4-mini",
    configuredProvider: completions,
    env: {},
    ...overrides,
  });
}

describe("OpenAI model route contract", () => {
  it("preserves custom model spelling while matching built-in routes case-insensitively", () => {
    expect(normalizeOpenAIModelRouteId("  openai/Future-MODEL  ")).toBe("openai/Future-MODEL");
    expect(normalizeOpenAIModelRouteId("future-model")).toBe("future-model");
    expect(normalizeOpenAIModelRouteId("GPT-5.4-CODEX")).toBe("gpt-5.4");

    expect(isOpenAIDualRouteModelId("GPT-5.5")).toBe(true);
    expect(isOpenAIDualRouteModelId("gpt-6-astra")).toBe(true);
    expect(isOpenAIPlatformOnlyRouteModelId("CHAT-LATEST")).toBe(true);
    expect(isOpenAISubscriptionOnlyRouteModelId("GPT-5.3-CODEX-SPARK")).toBe(true);
  });

  it("registers modern OpenAI model refs", () => {
    const provider = buildOpenAIProvider();
    for (const modelId of OPENAI_PROVIDER_MODERN_MODEL_IDS) {
      expect(provider.isModernModelRef?.({ provider: "openai", modelId })).toBe(true);
    }
  });
});

describe("OpenAI billing route intent", () => {
  it.each([
    [undefined, "https://api.openai.com/v1", "subscription"],
    [{ runtimeId: "codex", source: "inherited" }, "https://api.openai.com/v1", "subscription"],
    [{ authRequirement: "api-key", source: "inherited" }, undefined, "api-key"],
    [{ runtimeId: "openclaw", source: "explicit" }, undefined, "api-key"],
  ] as const)("preserves both billing routes for intent %j", (routeIntent, baseUrl, preference) => {
    expect(
      resolveBilling({ configuredProvider: { ...completions, baseUrl }, routeIntent }),
    ).toMatchObject({
      kind: "routes",
      preferredAuthRequirement: preference,
      routes: [platformRoute, subscriptionRoute],
    });
  });
  it("retains the provider adapter for API-key callers when the model overrides its official URL", () => {
    expect(
      resolveBilling({
        modelId: "gpt-5.5",
        configuredModel: { baseUrl: "https://api.openai.com/v1" },
      }),
    ).toEqual({
      kind: "routes",
      defaultRuntimeId: "openclaw",
      preferredAuthRequirement: "subscription",
      routes: [
        {
          ...platformRoute,
          baseUrl: "https://api.openai.com/v1",
          requestTransportOverrides: "none",
          runtimePolicy: { compatibleIds: ["openclaw"] },
        },
        {
          ...subscriptionRoute,
          baseUrl: "https://chatgpt.com/backend-api/codex",
          requestTransportOverrides: "none",
          runtimePolicy: { compatibleIds: ["openclaw", "codex"] },
        },
      ],
    });
  });
});
